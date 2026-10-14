import test from 'node:test';
import assert from 'node:assert/strict';
import { addStorefrontOnce, commandErrorMessage, deferredCommand, storefrontListMessage } from '../lib/discord-commands.js';

test('existing storefront is preserved without another insert', async () => {
  const row = { id: 'existing', label: 'Original name' };
  const result = await addStorefrontOnce({ find: async () => row, insert: async () => assert.fail('must not insert') });
  assert.equal(result.added, false);
  assert.equal(result.storefront, row);
});
test('new storefront is inserted once', async () => {
  let inserts = 0;
  const result = await addStorefrontOnce({ find: async () => null, insert: async () => { inserts++; return { id: 'new' }; } });
  assert.equal(result.added, true);
  assert.equal(inserts, 1);
});
test('simultaneous inserts return one created and one already tracked', async () => {
  let row;
  const options = { find: async () => row || null, insert: async () => {
    if (row) throw { response: { data: { code: '23505' } } };
    row = { id: 'winner' }; return row;
  } };
  const results = await Promise.all([addStorefrontOnce(options), addStorefrontOnce(options)]);
  assert.deepEqual(results.map((r) => r.added).sort(), [false, true]);
  assert.ok(results.every((r) => r.storefront.id === 'winner'));
});
test('unrelated conflicts and failed reads never become a false success', async () => {
  const conflict = { response: { data: { code: '23505' } } };
  await assert.rejects(addStorefrontOnce({ find: async () => null, insert: async () => { throw conflict; } }));
  await assert.rejects(addStorefrontOnce({ find: async () => { throw new Error('offline'); }, insert: async () => assert.fail() }));
});
test('acknowledgment happens before slow work and original response is edited privately', async () => {
  const events = [];
  let finish;
  const slow = new Promise((resolve) => { finish = resolve; });
  const running = deferredCommand({ acknowledge: async () => events.push('ack'),
    work: async () => { events.push('work'); await slow; return { data: { content: 'list', flags: 64 } }; },
    edit: async (data) => { events.push('edit'); assert.equal(data.content, 'list'); assert.equal(data.flags, undefined); assert.deepEqual(data.allowed_mentions, { parse: [] }); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['ack', 'work']);
  finish(); await running;
  assert.deepEqual(events, ['ack', 'work', 'edit']);
});
test('failed acknowledgment prevents all work', async () => {
  await assert.rejects(deferredCommand({ acknowledge: async () => { throw new Error('expired'); }, work: async () => assert.fail(), edit: async () => assert.fail() }));
});
test('backend failure edits loading response without exposing database internals', async () => {
  let text;
  await deferredCommand({ acknowledge: async () => {}, work: async () => { throw { response: { status: 500, data: { message: 'secret SQL' } } }; }, edit: async (data) => { text = data.content; } });
  assert.match(text, /try again/);
  assert.doesNotMatch(text, /SQL/);
});
test('reply retry does not repeat mutations', async () => {
  let work = 0; let edits = 0;
  await deferredCommand({ acknowledge: async () => {}, work: async () => { work++; return { data: { content: 'ok' } }; }, edit: async () => { if (++edits === 1) throw new Error('timeout'); } });
  assert.equal(work, 1); assert.equal(edits, 2);
});
test('authorization guidance is preserved and long lists remain below Discord limit', () => {
  assert.match(commandErrorMessage(new Error('Use this command inside your assigned private Buy Box Bandit channel.')), /assigned private/);
  assert.match(storefrontListMessage([]), /not tracking/);
  const output = storefrontListMessage(Array.from({ length: 60 }, (_, i) => ({ seller_id: `SELLER${i}`, label: 'a'.repeat(80) })));
  assert.ok(output.length <= 2000);
  assert.match(output, /Showing .* of 60/);
});
