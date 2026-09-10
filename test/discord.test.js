import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.File ??= class File {};
process.env.DISCORD_GUILD_ID = 'guild-1';
const { isDiscordAdministrator, sellerIdFrom } = await import('../api/discord.js');

test('Discord scan authorization requires administrator permission in the configured guild', () => {
  assert.equal(isDiscordAdministrator({ guild_id: 'guild-1', member: { permissions: '8' } }), true);
  assert.equal(isDiscordAdministrator({ guild_id: 'guild-1', member: { permissions: '0' } }), false);
  assert.equal(isDiscordAdministrator({ guild_id: 'another-guild', member: { permissions: '8' } }), false);
});

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
