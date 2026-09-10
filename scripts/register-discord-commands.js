const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !guildId || !botToken) {
  throw new Error('DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, and DISCORD_BOT_TOKEN are required');
}

const commands = [
  { name: 'setup', description: 'Create or connect your Buy Box Bandit student account' },
  {
    name: 'add', description: 'Track an Amazon competitor storefront',
    options: [
      { type: 3, name: 'storefront', description: 'Amazon seller ID or storefront URL', required: true },
      { type: 3, name: 'name', description: 'Optional competitor name', required: false, max_length: 80 },
    ],
  },
  {
    name: 'remove', description: 'Stop tracking an Amazon competitor storefront',
    options: [{ type: 3, name: 'storefront', description: 'Amazon seller ID', required: true }],
  },
  { name: 'viewlist', description: 'View your tracked Amazon storefronts' },
  {
    name: 'scan',
    description: 'Admin: start a 100-product Walmart AI sourcing scan',
    default_member_permissions: '8',
    dm_permission: false,
  },
  { name: 'help', description: 'View Buy Box Bandit commands' },
];

const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
const body = await response.json();
if (!response.ok) throw new Error(`Discord command registration failed (${response.status}): ${JSON.stringify(body)}`);
console.log(`Registered ${body.length} guild commands: ${body.map((command) => `/${command.name}`).join(', ')}`);
