import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSellerId, ownedStorefrontParams, visibleStorefronts, storefrontRecords } from '../lib/storefront-records.js';

const seller = 'A2UCDC7R7NY4ET';
test('accepts seller tokens and Amazon merchant links, not arbitrary URL path text', () => {
  for (const value of [seller.toLowerCase(), `https://www.amazon.com/sp?seller=${seller}`, `https://www.amazon.com/s?me=${seller}`]) assert.equal(parseSellerId(value), seller);
  for (const value of ['LOOKUP', 'lookup', 'https://www.amazon.com/lookup', 'https://selleramp.com/lookup', `https://evil.example/?seller=${seller}`, 'https://www.amazon.com/stores/SomeBrand/page/123456789012']) assert.throws(() => parseSellerId(value), /valid Amazon seller ID/);
});
test('unified scope includes only canonical owner or unassigned legacy email rows', () => {
  const filter = ownedStorefrontParams({ id: 'recStudent', email: 'Student@Example.com' });
  assert.equal(filter.or, '(airtable_student_id.eq."recStudent",and(airtable_student_id.is.null,owner_email.eq."student@example.com"))');
  assert.throws(() => ownedStorefrontParams({ id: 'recStudent' }));
  assert.ok(ownedStorefrontParams({ id: 'recStudent', email: 'a"b@example.com' }).or.includes('a\\"b'));
});
test('invalid LOOKUP rows are excluded without modifying or deleting stored data', () => {
  const rows = [{ id: '1', seller_id: seller }, { id: '2', seller_id: 'LOOKUP' }, { id: '3', seller_id: seller }];
  assert.deepEqual(visibleStorefronts(rows).map((r) => r.id), ['1']);
  assert.equal(rows.length, 3);
});
test('portal and Discord use same store and existing legacy row is not inserted twice', async () => {
  const student = { id: 'recStudent', email: 'student@example.com' };
  const old = { id: 'legacy', seller_id: seller, airtable_student_id: null };
  const http = { get: async (_, options) => { assert.equal(options.params.or, ownedStorefrontParams(student).or); return { data: [old] }; }, post: async () => assert.fail('duplicate insert') };
  const repo = storefrontRecords({ supabaseUrl: 'https://example.com', supabaseServiceRoleKey: 'test' }, http);
  assert.equal((await repo.add(student, seller, '', 'google-user')).added, false);
  assert.equal((await repo.add(student, seller, '')).added, false);
});
test('delete always retains the student scope and insert rejects LOOKUP before IO', async () => {
  const student = { id: 'recStudent', email: 'student@example.com' };
  const repo = storefrontRecords({ supabaseUrl: 'https://example.com', supabaseServiceRoleKey: 'test' }, {
    delete: async (_, options) => { assert.equal(options.params.or, ownedStorefrontParams(student).or); assert.equal(options.params.id, 'eq.row'); },
    get: async () => assert.fail('invalid input must not query'),
  });
  await repo.remove(student, { id: 'eq.row' });
  await assert.rejects(repo.add(student, 'LOOKUP', ''), /valid Amazon seller ID/);
});
