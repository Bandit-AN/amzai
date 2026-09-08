import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.File ??= class File {};
const { sellerIdFrom } = await import('../api/discord.js');

test('Discord storefront commands accept seller IDs and Amazon storefront URLs', () => {
  assert.equal(sellerIdFrom('a1bcdef234567'), 'A1BCDEF234567');
  assert.equal(
    sellerIdFrom('https://www.amazon.com/sp?seller=A2EXAMPLE98765'),
    'A2EXAMPLE98765',
  );
});

test('Discord storefront commands reject ambiguous input', () => {
  assert.throws(() => sellerIdFrom('not a storefront'), /valid Amazon seller ID/);
});
