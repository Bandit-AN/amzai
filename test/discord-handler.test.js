import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import axios from 'axios';

globalThis.File ??= class File {};
const keys = nacl.sign.keyPair();
process.env.DISCORD_PUBLIC_KEY = Buffer.from(keys.publicKey).toString('hex');
process.env.DISCORD_APPLICATION_ID = 'test-app';
process.env.DISCORD_GUILD_ID = 'test-guild';
process.env.DISCORD_STUDENT_ROLE_ID = 'student-role';
process.env.SUPABASE_URL = 'https://database.example';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
const { default: handler } = await import('../api/discord.js');

function request(name, extra = {}) {
  const body = Buffer.from(JSON.stringify({ id: 'interaction', token: 'test-token', type: 2,
    guild_id: 'test-guild', channel_id: 'private', member: { user: { id: 'student' }, roles: ['student-role'], permissions: '0' },
    data: { name, options: [{ name: 'storefront', value: 'A2UCDC7R7NY4ET' }] }, ...extra }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { method: 'POST', body, headers: { 'x-signature-timestamp': timestamp,
    'x-signature-ed25519': Buffer.from(nacl.sign.detached(Buffer.concat([Buffer.from(timestamp), body]), keys.secretKey)).toString('hex') } };
}
function response() {
  return { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
}
function backend(t, { rows = [], channel = 'private' } = {}) {
  const events = []; const replies = [];
  t.mock.method(axios, 'post', async (url, data) => {
    if (url.includes('/callback')) { events.push('ack'); assert.equal(data.type, 5); assert.equal(data.data.flags, 64); return {}; }
    events.push('insert');
    assert.equal(data[0].airtable_student_id, 'record-1');
    assert.equal(data[0].owner_email, 'student@example.com');
    assert.equal(data[0].seller_id, 'A2UCDC7R7NY4ET');
    return { data: [{ ...data[0], id: 'new' }] };
  });
  t.mock.method(axios, 'get', async (url, options) => {
    assert.equal(events[0], 'ack');
    if (url.includes('airtable.com')) { events.push('student'); return { data: { records: [{ id: 'record-1', fields: { Email: 'Student@Example.com', Status: 'Active', 'Discord User ID': 'student', 'Discord Channel ID': channel } }] } }; }
    events.push('stores'); assert.match(options.params.or, /airtable_student_id.eq."record-1"/);
    assert.match(options.params.or, /airtable_student_id.is.null/);
    if (options.params.limit) assert.equal(options.params.seller_id, 'eq.A2UCDC7R7NY4ET');
    return { data: rows };
  });
  t.mock.method(axios, 'patch', async (url, data) => {
    assert.ok(url.endsWith('/messages/@original')); replies.push(data); events.push('edit'); return {};
  });
  return { events, replies };
}
test('signed viewlist acknowledges before both lookups and ends HTTP 202 empty', async (t) => {
  const { events, replies } = backend(t, { rows: [{ seller_id: 'A2UCDC7R7NY4ET', label: 'Competitor' }] });
  const res = response(); await handler(request('viewlist'), res);
  assert.deepEqual(events, ['ack', 'student', 'stores', 'edit']);
  assert.match(replies[0].content, /Competitor/);
  assert.equal(res.statusCode, 202); assert.equal(res.body, undefined);
});
test('signed add preserves existing row and returns already tracking', async (t) => {
  const { events, replies } = backend(t, { rows: [{ id: 'existing', seller_id: 'SELLER123' }] });
  await handler(request('add'), response());
  assert.ok(!events.includes('insert')); assert.match(replies[0].content, /already tracking/);
});
test('signed add inserts with resolved student email and identity', async (t) => {
  const { events, replies } = backend(t);
  await handler(request('add'), response());
  assert.equal(events.filter((e) => e === 'insert').length, 1);
  assert.match(replies[0].content, /Now tracking/);
});
test('wrong private channel cannot read or insert storefronts', async (t) => {
  const { events, replies } = backend(t, { channel: 'different' });
  await handler(request('add'), response());
  assert.deepEqual(events, ['ack', 'student', 'edit']);
  assert.match(replies[0].content, /assigned private/);
});
test('setup modal remains immediate and does not defer', async (t) => {
  const { events } = backend(t); const res = response();
  await handler(request('setup'), res);
  assert.equal(JSON.parse(res.body).type, 9); assert.deepEqual(events, []);
});
test('invalid signature cannot acknowledge or query data', async (t) => {
  const { events } = backend(t); const req = request('viewlist'); req.headers['x-signature-ed25519'] = '';
  const res = response(); await handler(req, res);
  assert.equal(res.statusCode, 401); assert.deepEqual(events, []);
});
test('nonadmin scan defers but never publishes sourcing work', async (t) => {
  const { events, replies } = backend(t);
  await handler(request('scan'), response());
  assert.deepEqual(events, ['ack', 'edit']); assert.match(replies[0].content, /Only server administrators/);
});
