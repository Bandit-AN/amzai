import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedStorefrontIds, isBlockedStorefront } from '../lib/storefront-policy.js';
import { storefrontRecords, visibleStorefronts } from '../lib/storefront-records.js';
import { commandErrorMessage, storefrontListMessage } from '../lib/discord-commands.js';
import { processStorefront } from '../lib/storefront-delivery.js';

const expected = ['A13JAOVCSKO2RZ', 'A1M3BPO406QRM2', 'AIQ9T97M1LEFC', 'A23NXM0C8CNVH6', 'A3FJ0GUIE0S5CG', 'A27U6Q3KXGY8H3', 'A19662HMW9QPL7', 'A2B91NEL33MV8Y', 'A2O11WR0T300KP', 'A2UT56ZZF8U7WN', 'A6BXXELHM94Z0', 'A1DIV7RK386GWB', 'A1IUEBFQG312AT', 'A1F4AR58F6S488'];
test('blacklist contains exactly all 14 requested IDs', () => {
  assert.deepEqual([...blockedStorefrontIds].sort(), [...expected].sort());
  for (const id of expected) assert.equal(isBlockedStorefront(` ${id.toLowerCase()} `), true);
  assert.equal(isBlockedStorefront('A2UCDC7R7NY4ET'), false);
});
test('shared portal/Discord adds reject every protected ID and URL before reading or writing', async () => {
  const noIO = async () => assert.fail('Blocked input must never reach storage');
  const repo = storefrontRecords({ supabaseServiceRoleKey: 'test' }, { get: noIO, post: noIO });
  for (const id of expected) {
    for (const input of [id, id.toLowerCase(), `https://www.amazon.com/sp?seller=${id}`, `https://www.amazon.com/s?me=${id.toLowerCase()}`]) {
      await assert.rejects(repo.add({ id: 'student', email: 'student@example.com' }, input, 'Different label', 'google-user'), (error) => {
        assert.equal(error.code, 'STOREFRONT_BLOCKED');
        assert.match(commandErrorMessage(error), /protected and cannot be tracked/);
        return true;
      });
    }
  }
});
test('existing protected subscriptions remain visible and removable, but explicitly disabled', () => {
  const source = [{ id: 'saved', seller_id: expected[0], label: 'Store' }];
  const rows = visibleStorefronts(source);
  assert.equal(rows[0].blocked, true);
  assert.match(storefrontListMessage(rows), /tracking disabled/);
  assert.equal(source.length, 1);
});
test('queued delivery of protected seller does no external work', async () => {
  for (const sellerId of expected) {
    const result = await processStorefront({ store: { sellerId } });
    assert.deepEqual(result, { status: 'blocked', pending: 0, delivered: 0 });
  }
});
