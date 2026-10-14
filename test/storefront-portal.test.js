import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
globalThis.File ??= class File {};
process.env.SUPABASE_URL = 'https://database.example';
process.env.SUPABASE_ANON_KEY = 'anon-test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
process.env.CRON_SECRET = 'admin-test';
const { default: handler } = await import('../api/storefronts.js');
const studentId = 'recExample12345678';
const seller = 'A2UCDC7R7NY4ET';
function response() { return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return body; } }; }
function setup(t, rows, auth = true) {
  t.mock.method(axios, 'get', async (url, options) => {
    if (url.endsWith('/auth/v1/user')) {
      if (!auth) throw new Error('invalid token');
      return { data: { id: 'google-user', email: 'student@example.com' } };
    }
    if (url.includes('airtable.com')) return { data: { records: [{ id: studentId, fields: { Email: 'student@example.com', Status: 'Active', Name: 'Student' } }] } };
    assert.match(options.params.or, /airtable_student_id.eq."recExample12345678"/);
    assert.match(options.params.or, /airtable_student_id.is.null,owner_email.eq."student@example.com"/);
    return { data: rows };
  });
  t.mock.method(axios, 'patch', async () => assert.fail('Do not bulk reassign ownership'));
}
test('verified portal returns same canonical and legacy entries and suppresses invalid LOOKUP', async (t) => {
  setup(t, [{ id: 'canonical', seller_id: seller }, { id: 'legacy', seller_id: 'AVPLW9R0ERFXI' }, { id: 'bad', seller_id: 'LOOKUP' }]);
  const res = response(); await handler({ method: 'GET', headers: { authorization: 'Bearer login' } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.storefronts.length, 2);
  assert.ok(res.body.storefronts.every((row) => !('owner_email' in row)));
});
test('portal duplicate uses shared add and never overwrites existing label or ownership', async (t) => {
  setup(t, [{ id: 'saved', seller_id: seller, label: 'Original' }]);
  t.mock.method(axios, 'post', async () => assert.fail('Do not insert a duplicate'));
  const res = response(); await handler({ method: 'POST', headers: { authorization: 'Bearer login' }, body: { sellerId: seller, label: 'Changed' } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.alreadyTracked, true);
  assert.equal(res.body.storefront.label, 'Original');
});
test('portal rejects lookup URLs before writing', async (t) => {
  setup(t, []); t.mock.method(axios, 'post', async () => assert.fail());
  const res = response(); await handler({ method: 'POST', headers: { authorization: 'Bearer login' }, body: { url: 'https://www.amazon.com/lookup' } }, res);
  assert.equal(res.code, 400); assert.match(res.body.error, /valid Amazon seller ID/);
});
test('unknown identity cannot access service role store reads', async (t) => {
  setup(t, [], false);
  const res = response(); await handler({ method: 'GET', headers: { authorization: 'Bearer invalid' } }, res);
  assert.equal(res.code, 401);
});
