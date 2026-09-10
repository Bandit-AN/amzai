import axios from 'axios';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';

import {
  config as platformConfig,
  fetchDiscordStudent,
  getRunSummary,
  jsonResponse,
  publishMessage,
  redis,
  upsertDiscordStudent,
} from '../lib/platform.js';

export const config = { api: { bodyParser: false } };

const EPHEMERAL = 64;
const discordResponse = (response, body) => jsonResponse(response, 200, body);
const message = (content) => ({ type: 4, data: { content, flags: EPHEMERAL } });
const apiHeaders = () => ({ Authorization: `Bot ${platformConfig.discordBotToken}`, 'Content-Type': 'application/json' });

async function rawBody(request) {
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === 'string') return Buffer.from(request.body);
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function validSignature(request, body) {
  const signature = String(request.headers['x-signature-ed25519'] || '');
  const timestamp = String(request.headers['x-signature-timestamp'] || '');
  if (!signature || !timestamp || !platformConfig.discordPublicKey) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + body.toString('utf8')),
      Buffer.from(signature, 'hex'),
      Buffer.from(platformConfig.discordPublicKey, 'hex'),
    );
  } catch { return false; }
}

function option(interaction, name) {
  return interaction.data?.options?.find((item) => item.name === name)?.value;
}

function modalValue(interaction, id) {
  for (const row of interaction.data?.components || []) {
    const input = row.components?.find((item) => item.custom_id === id);
    if (input) return String(input.value || '').trim();
  }
  return '';
}

function authorizedStudentRole(interaction) {
  return interaction.guild_id === platformConfig.discordGuildId
    && interaction.member?.roles?.includes(platformConfig.discordStudentRoleId);
}

export function isDiscordAdministrator(interaction) {
  try {
    return interaction.guild_id === platformConfig.discordGuildId
      && (BigInt(interaction.member?.permissions || '0') & 8n) === 8n;
  } catch {
    return false;
  }
}

export function sellerIdFrom(value) {
  const raw = String(value || '').trim();
  let sellerId = raw;
  try {
    const url = new URL(raw);
    sellerId = url.searchParams.get('seller') || url.searchParams.get('me') || '';
  } catch {}
  sellerId = sellerId.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(sellerId)) throw new Error('Enter a valid Amazon seller ID or a storefront URL containing `seller=`.');
  return sellerId;
}

async function enrolledStudent(interaction) {
  const student = await fetchDiscordStudent({ userId: interaction.member?.user?.id || interaction.user?.id });
  if (!student || student.fields.Status !== 'Active') throw new Error('Run `/setup` before using storefront commands.');
  if (String(student.fields['Discord Channel ID']) !== String(interaction.channel_id)) {
    throw new Error('Use this command inside your assigned private Buy Box Bandit channel.');
  }
  return student;
}

const supabaseAdminHeaders = () => ({
  apikey: platformConfig.supabaseServiceRoleKey,
  Authorization: `Bearer ${platformConfig.supabaseServiceRoleKey}`,
  'Content-Type': 'application/json',
});
const storefrontUrl = () => `${platformConfig.supabaseUrl}/rest/v1/student_storefronts`;
const discordCommands = [
  { name: 'setup', description: 'Create or connect your Buy Box Bandit student account' },
  { name: 'add', description: 'Track an Amazon competitor storefront', options: [
    { type: 3, name: 'storefront', description: 'Amazon seller ID or storefront URL', required: true },
    { type: 3, name: 'name', description: 'Optional competitor name', required: false, max_length: 80 },
  ] },
  { name: 'remove', description: 'Stop tracking an Amazon competitor storefront', options: [
    { type: 3, name: 'storefront', description: 'Amazon seller ID', required: true },
  ] },
  { name: 'viewlist', description: 'View your tracked Amazon storefronts' },
  {
    name: 'scan',
    description: 'Admin: start a 100-product Walmart AI sourcing scan',
    default_member_permissions: '8',
    dm_permission: false,
  },
  {
    name: 'progress',
    description: 'Admin: check the current AI sourcing queue',
    default_member_permissions: '8',
    dm_permission: false,
  },
  { name: 'help', description: 'View Buy Box Bandit commands' },
];

async function registerCommands(response) {
  const result = await axios.put(
    `https://discord.com/api/v10/applications/${platformConfig.discordApplicationId}/guilds/${platformConfig.discordGuildId}/commands`,
    discordCommands,
    { headers: apiHeaders(), timeout: platformConfig.requestTimeoutMs },
  );
  return jsonResponse(response, 200, { ok: true, commands: result.data.map((command) => command.name) });
}

async function listStorefronts(student) {
  const response = await axios.get(storefrontUrl(), {
    headers: supabaseAdminHeaders(),
    params: { select: 'id,seller_id,label,created_at', airtable_student_id: `eq.${student.id}`, order: 'created_at.asc' },
    timeout: platformConfig.requestTimeoutMs,
  });
  return response.data || [];
}

async function createChannelWebhook(channelId) {
  const response = await axios.post(`https://discord.com/api/v10/channels/${channelId}/webhooks`, {
    name: 'The Buy Box Bandit',
  }, { headers: apiHeaders(), timeout: platformConfig.requestTimeoutMs });
  return `https://discord.com/api/webhooks/${response.data.id}/${response.data.token}`;
}

async function completeSetup(interaction) {
  if (!authorizedStudentRole(interaction)) throw new Error('You need the Buy Box Bandit Student role to enroll.');
  const name = modalValue(interaction, 'student_name').replace(/\s+/g, ' ').slice(0, 100);
  const email = modalValue(interaction, 'student_email').toLowerCase();
  if (name.length < 2) throw new Error('Enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  const userId = interaction.member.user.id;
  const existing = await fetchDiscordStudent({ userId });
  let webhookUrl = existing?.fields?.['Discord Webhook URL'] || '';
  if (!webhookUrl) webhookUrl = await createChannelWebhook(interaction.channel_id);
  const student = await upsertDiscordStudent({
    name, email, userId, channelId: interaction.channel_id, guildId: interaction.guild_id, webhookUrl, existingByUser: existing,
  });
  return message(`✅ **The Buy Box Bandit is ready**\n\nStudent: **${student.name}**\nLogin email: **${email}**\nDashboard: https://app.sellersyndicate.org\nPrivate alerts: <#${interaction.channel_id}>\nTracked storefronts: **0**`);
}

async function sourcingProgressMessage() {
  const [collectionId, recentRunIds] = await Promise.all([
    redis.get('walmart:freshCollection:active'),
    redis.lrange('runs:recent', 0, 9),
  ]);
  if (collectionId) {
    const collection = await redis.get(`walmart:freshCollection:${collectionId}`);
    const collected = Array.isArray(collection?.candidates) ? collection.candidates.length : 0;
    const required = platformConfig.walmartEligibleCohortSize;
    return `🔎 **Walmart discovery in progress**\n\nFresh eligible products: **${collected}/${required}**\nPages searched: **${Number(collection?.pagesScanned || 0)}/${Number(collection?.totalSourcePages || 0)}**\nCollection ID: \`${collectionId}\``;
  }

  const summaries = (await Promise.all(recentRunIds.map((runId) => getRunSummary(runId))))
    .filter(Boolean);
  const run = summaries.find((item) => item.status === 'analyzing') || summaries[0];
  if (!run) return 'There is no current or recent AI sourcing run.';
  const percent = run.totalJobs > 0
    ? Math.min(100, Math.round((run.completedJobs / run.totalJobs) * 100))
    : 0;
  const delivery = run.delivery.reduce((total, item) => total + (item.delivered ? item.assigned : 0), 0);
  const heading = run.status === 'analyzing' ? '⚙️ **AI sourcing queue**' : '✅ **Most recent sourcing run**';
  return `${heading}\n\nStatus: **${run.status}**\nProgress: **${run.completedJobs}/${run.totalJobs} (${percent}%)**\nProducts in cohort: **${run.candidates}**\nUPC confirmed: **${run.funnel.upcConfirmed}**\nExact Amazon matches: **${run.funnel.exactAmazonMatchFound ?? 0}**\nQualified: **${run.qualifiedDeals}**\nErrors: **${run.analysisErrors}**\nDelivered: **${delivery}**\nRun ID: \`${run.runId}\``;
}

async function handleCommand(interaction) {
  const command = interaction.data?.name;
  if (command === 'scan') {
    if (!isDiscordAdministrator(interaction)) {
      return message('Only server administrators can start AI sourcing scans.');
    }
    const requestId = randomUUID();
    await publishMessage({
      url: `${platformConfig.publicBaseUrl}/api/cron`,
      body: { requestedFrom: 'discord', requestedBy: interaction.member?.user?.id },
      deduplicationId: `discord-walmart-scan-${requestId}`,
    });
    return message(`✅ **Walmart sourcing scan queued**\n\nTarget: **100 fresh eligible products**\nRequest ID: \`${requestId}\`\nResults will be sent only to the private AI sourcing leads destination.`);
  }
  if (command === 'progress') {
    if (!isDiscordAdministrator(interaction)) {
      return message('Only server administrators can view the AI sourcing queue.');
    }
    return message(await sourcingProgressMessage());
  }
  if (command === 'setup') {
    if (!authorizedStudentRole(interaction)) return message('You need the Buy Box Bandit Student role to enroll.');
    return {
      type: 9,
      data: {
        custom_id: 'student_setup', title: 'Set up The Buy Box Bandit',
        components: [
          { type: 1, components: [{ type: 4, custom_id: 'student_name', label: 'Full name', style: 1, min_length: 2, max_length: 100, required: true }] },
          { type: 1, components: [{ type: 4, custom_id: 'student_email', label: 'Google login email', style: 1, min_length: 5, max_length: 254, required: true, placeholder: 'you@example.com' }] },
        ],
      },
    };
  }
  const student = await enrolledStudent(interaction);
  if (command === 'add') {
    const sellerId = sellerIdFrom(option(interaction, 'storefront'));
    const label = String(option(interaction, 'name') || '').trim().slice(0, 80);
    await axios.post(storefrontUrl(), [{
      airtable_student_id: student.id,
      owner_email: student.email,
      seller_id: sellerId,
      label,
    }], { headers: { ...supabaseAdminHeaders(), Prefer: 'resolution=ignore-duplicates,return=representation' }, timeout: platformConfig.requestTimeoutMs });
    return message(`✅ Now tracking **${label || sellerId}** (${sellerId}). The first tracker check creates a baseline; later new listings will alert this channel.`);
  }
  if (command === 'remove') {
    const sellerId = sellerIdFrom(option(interaction, 'storefront'));
    await axios.delete(storefrontUrl(), {
      headers: supabaseAdminHeaders(),
      params: { airtable_student_id: `eq.${student.id}`, seller_id: `eq.${sellerId}` },
      timeout: platformConfig.requestTimeoutMs,
    });
    return message(`✅ Removed **${sellerId}** from your tracked storefronts.`);
  }
  if (command === 'viewlist') {
    const stores = await listStorefronts(student);
    if (!stores.length) return message('You are not tracking any storefronts yet. Use `/add`.');
    const rows = stores.slice(0, 50).map((store, index) => `${index + 1}. **${store.label || store.seller_id}**\n   ${store.seller_id}`);
    return message(`**Your tracked storefronts (${stores.length})**\n\n${rows.join('\n')}`);
  }
  return message('**Buy Box Bandit commands**\n`/setup` create or connect your account\n`/add` track a storefront\n`/remove` stop tracking a storefront\n`/viewlist` see your tracked storefronts');
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (request.query?.register === 'true'
    && platformConfig.cronSecret
    && request.headers.authorization === `Bearer ${platformConfig.cronSecret}`) {
    try { return await registerCommands(response); }
    catch (error) {
      const detail = error.response?.data?.message || error.message;
      return jsonResponse(response, 400, { ok: false, error: detail });
    }
  }
  const body = await rawBody(request);
  if (!validSignature(request, body)) return jsonResponse(response, 401, { error: 'Invalid Discord signature' });
  try {
    const interaction = JSON.parse(body.toString('utf8'));
    if (interaction.type === 1) return discordResponse(response, { type: 1 });
    if (interaction.type === 5 && interaction.data?.custom_id === 'student_setup') {
      return discordResponse(response, await completeSetup(interaction));
    }
    if (interaction.type === 2) return discordResponse(response, await handleCommand(interaction));
    return discordResponse(response, message('Unsupported interaction.'));
  } catch (error) {
    const detail = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    console.error(JSON.stringify({ event: 'discord_interaction_failed', message: detail }));
    return discordResponse(response, message(`Could not complete that command: ${detail}`));
  }
}
