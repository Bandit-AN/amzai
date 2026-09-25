import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { processStorefront } from '../lib/storefront-delivery.js';

import { handleOrderTrackingCron } from '../lib/order-tracking.js';

import {
  cachedValue,
  config,
  fetchActiveStudents,
  fetchPortalStudentByEmail,
  fetchSellerStorefrontAsins,
  hydrateKeepaProductsByAsin,
  isBlockedStorefrontBrand,
  jsonResponse,
  publishBatch,
  publishMessage,
  readJsonBody,
  readPortalIdentity,
  redis,
  requireEnvironment,
  storefrontDiscordPayloads,
  workerAuthorized,
} from '../lib/platform.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function postDiscord(webhook, payload) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const url = new URL(webhook);
      url.searchParams.set('wait', 'true');
      return await axios.post(url.toString(), payload, { timeout: config.requestTimeoutMs });
    } catch (error) {
      if (error.response?.status !== 429 || attempt === 4) throw error;
      const retryAfterSeconds = Number(error.response?.data?.retry_after || 1);
      await wait(Math.max(250, Math.ceil(retryAfterSeconds * 1000)));
    }
  }
  throw new Error('Discord delivery retries exhausted');
}

const storefrontTableUrl = () => `${config.supabaseUrl}/rest/v1/student_storefronts`;
const bearerToken = (request) => String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
const supabaseHeaders = (token) => ({
  apikey: config.supabaseAnonKey,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

function normalizedSellerId(value) {
  const raw = String(value || '').trim();
  let candidate = raw;
  try {
    const url = new URL(raw);
    candidate = url.searchParams.get('seller') || url.searchParams.get('me') || url.pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {}
  candidate = candidate.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(candidate)) {
    throw new Error('Enter a valid Amazon seller ID or storefront URL containing seller=');
  }
  return candidate;
}

async function handleStudentStorefronts(request, response, identity) {
  if (identity.type !== 'supabase') {
    return jsonResponse(response, 403, { error: 'Sign in with Google to manage storefronts' });
  }
  const token = bearerToken(request);
  const headers = supabaseHeaders(token);
  const student = await fetchPortalStudentByEmail(identity.email);
  if (!student) return jsonResponse(response, 403, { error: 'This Google email is not an active Seller Syndicate student' });
  // A student may enroll and add stores in Discord before their first portal
  // login. Claim those rows on first Google-authenticated portal use.
  if (config.supabaseServiceRoleKey) {
    await axios.patch(storefrontTableUrl(), {
      user_id: identity.userId,
      airtable_student_id: student.id,
    }, {
      headers: {
        apikey: config.supabaseServiceRoleKey,
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
      params: { owner_email: `eq.${identity.email}`, user_id: 'is.null' },
      timeout: config.requestTimeoutMs,
    });
  }
  if (request.method === 'GET') {
    const result = await axios.get(storefrontTableUrl(), {
      headers,
      params: { select: 'id,seller_id,label,created_at', order: 'created_at.desc' },
      timeout: config.requestTimeoutMs,
    });
    return jsonResponse(response, 200, { ok: true, storefronts: result.data || [] });
  }
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    const sellerId = normalizedSellerId(body.sellerId || body.url);
    const label = String(body.label || '').trim().slice(0, 80);
    const result = await axios.post(storefrontTableUrl(), [{
      user_id: identity.userId,
      airtable_student_id: student.id,
      owner_email: identity.email,
      seller_id: sellerId,
      label,
    }], {
      headers: { ...headers, Prefer: 'return=representation' },
      timeout: config.requestTimeoutMs,
    });
    return jsonResponse(response, 201, { ok: true, storefront: result.data?.[0] });
  }
  if (request.method === 'DELETE') {
    const body = await readJsonBody(request);
    const id = String(body.id || request.query?.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid storefront entry');
    await axios.delete(storefrontTableUrl(), {
      headers,
      params: { id: `eq.${id}` },
      timeout: config.requestTimeoutMs,
    });
    return jsonResponse(response, 200, { ok: true });
  }
  return jsonResponse(response, 405, { error: 'Method not allowed' });
}

async function configuredStorefronts() {
  const tracked = [];
  if (config.supabaseUrl && config.supabaseServiceRoleKey) {
    const response = await axios.get(storefrontTableUrl(), {
      headers: {
        apikey: config.supabaseServiceRoleKey,
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      },
      params: { select: 'id,user_id,owner_email,seller_id,label' },
      timeout: config.requestTimeoutMs,
    });
    const students = await fetchActiveStudents({ fresh: true });
    const byEmail = new Map(students.map((student) => [student.email, student]));
    for (const row of response.data || []) {
      const student = byEmail.get(String(row.owner_email || '').trim().toLowerCase());
      if (!student) continue;
      tracked.push({
        ownerKey: student.id,
        legacyOwnerKey: row.user_id || student.id,
        ownerEmail: row.owner_email,
        sellerId: row.seller_id,
        label: row.label || row.seller_id,
        webhook: student.discordWebhookUrl,
      });
    }
  }
  for (const entry of config.amazonTrackedSellers) {
    tracked.push({ ...entry, ownerKey: 'legacy', webhook: config.storefrontDiscordWebhookUrl });
  }
  return tracked;
}

export default async function handler(request, response) {
  if (request.query?.task === 'orders') return handleOrderTrackingCron(request, response);
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return jsonResponse(response, 405, { error: 'Method not allowed' });
  const portalIdentity = await readPortalIdentity(request);
  if (portalIdentity) {
    try { return await handleStudentStorefronts(request, response, portalIdentity); }
    catch (error) {
      const message = error.response?.data?.message || error.response?.data?.details || error.message;
      const status = error.response?.status === 409 ? 409 : 400;
      return jsonResponse(response, status, { ok: false, error: message });
    }
  }
  const internalRequest = request.method === 'POST' && workerAuthorized(request);
  if (!internalRequest && config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }
  try {
    requireEnvironment(['KEEPA_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);
    const trackedStorefronts = await configuredStorefronts();
    if (trackedStorefronts.length === 0) {
      return jsonResponse(response, 200, { ok: true, skipped: true, reason: 'No student storefronts configured' });
    }
    const input = request.method === 'POST' ? await readJsonBody(request) : request.query || {};
    const tracked = [...new Map(trackedStorefronts.map((store) => [`${store.ownerKey}:${store.sellerId}`, store])).values()];
    // Authenticated, read-only status: never returns a webhook or credential.
    if (input.task === 'health') {
      const states = await redis.mget(tracked.map((store) => `storefront:state:${store.ownerKey}:${store.sellerId}`));
      return jsonResponse(response, 200, { ok: true, dispatch: await redis.get('storefront:lastDispatch'),
        sellers: tracked.map((store, i) => ({ sellerId: store.sellerId, label: store.label,
          webhookConfigured: Boolean(store.webhook), status: states[i]?.status || 'not_checked_by_new_worker',
          checkedAt: states[i]?.checkedAt, pending: states[i]?.pending?.length || 0,
          delivered: states[i]?.delivered || 0, error: states[i]?.error || null,
          lastDeliveryAt: states[i]?.lastDelivery?.at })) });
    }
    requireEnvironment(['QSTASH_TOKEN', 'PUBLIC_BASE_URL', 'WORKER_SECRET']);
    if (input.task === 'store') {
      // Resolve the subscription again, so deletion/revocation stops queued work
      // and webhook credentials never need to travel through the queue.
      const store = tracked.find((entry) => entry.ownerKey === input.ownerKey && entry.sellerId === input.sellerId);
      if (!store) return jsonResponse(response, 200, { ok: true, removed: true });
      if (!store.webhook) throw new Error('Storefront Discord webhook is not configured');
      const result = await processStorefront({ store, redis,
        fetchSeller: (sellerId) => cachedValue(`storefront:snapshot:${sellerId}`, 300, () => fetchSellerStorefrontAsins(sellerId)),
        hydrate: hydrateKeepaProductsByAsin, blocked: isBlockedStorefrontBrand,
        payloads: storefrontDiscordPayloads, send: postDiscord, ttl: config.productCooldownSeconds * 12 });
      // Bound each daily subscription cycle to the existing configured allowance.
      // Excess remains durable for tomorrow rather than being marked away.
      const remaining = Math.max(0, Math.min(25, Number(input.batchesLeft) || 0) - 1);
      if (result.pending > 0 && result.status === 'pending' && remaining > 0) {
        await publishMessage({ url: `${config.publicBaseUrl}/api/storefronts`,
          body: { task: 'store', ownerKey: store.ownerKey, sellerId: store.sellerId, cycle: input.cycle, batchesLeft: remaining },
          deduplicationId: `storefront-${store.ownerKey}-${store.sellerId}-${input.cycle || 'retry'}-${remaining}`,
          delaySeconds: 60 });
      }
      return jsonResponse(response, 200, { ok: true, ...result });
    }
    const cycle = randomUUID();
    await publishBatch(tracked.filter((store) => store.webhook).map((store, index) => ({
      url: `${config.publicBaseUrl}/api/storefronts`,
      body: { task: 'store', ownerKey: store.ownerKey, sellerId: store.sellerId, cycle,
        batchesLeft: Math.max(1, Math.ceil(config.storefrontNewListingsPerRunLimit / 4)) },
      deduplicationId: `storefront-${cycle}-${store.ownerKey}-${store.sellerId}`, delaySeconds: index * 60,
    })));
    await redis.set('storefront:lastDispatch', { at: new Date().toISOString(), queued: tracked.filter((s) => s.webhook).length });
    return jsonResponse(response, 202, { ok: true, queued: tracked.filter((s) => s.webhook).length });
  } catch (error) {
    console.error(JSON.stringify({ event: 'storefronts_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
