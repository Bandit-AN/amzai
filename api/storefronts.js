import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { processStorefront } from '../lib/storefront-delivery.js';
import { parseSellerId, storefrontRecords, validSellerId, visibleStorefronts } from '../lib/storefront-records.js';
import { isBlockedStorefront } from '../lib/storefront-policy.js';

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
const stores = storefrontRecords(config);

async function handleStudentStorefronts(request, response, identity) {
  if (identity.type !== 'supabase') {
    return jsonResponse(response, 403, { error: 'Sign in with Google to manage storefronts' });
  }
  const student = await fetchPortalStudentByEmail(identity.email);
  if (!student) return jsonResponse(response, 403, { error: 'This Google email is not an active Seller Syndicate student' });
  // The verified Google email resolves the same student identity as Discord.
  // Server-side owner filters replace bulk row claiming, which could collide
  // with existing portal rows and make the whole list inaccessible.
  if (request.method === 'GET') {
    const rows = visibleStorefronts(await stores.list(student));
    return jsonResponse(response, 200, { ok: true, storefronts: rows.map(({ id, seller_id, label, created_at, blocked }) => ({ id, seller_id, label, created_at, blocked })) });
  }
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    const sellerId = parseSellerId(body.sellerId || body.url);
    const label = String(body.label || '').trim().slice(0, 80);
    const result = await stores.add(student, sellerId, label, identity.userId);
    return jsonResponse(response, result.added ? 201 : 200, { ok: true, alreadyTracked: !result.added, storefront: result.storefront });
  }
  if (request.method === 'DELETE') {
    const body = await readJsonBody(request);
    const id = String(body.id || request.query?.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid storefront entry');
    const row = (await stores.list(student, { id: `eq.${id}`, limit: 1 }))[0];
    if (!row) return jsonResponse(response, 404, { error: 'Storefront was not found in your account' });
    await stores.remove(student, { seller_id: `eq.${row.seller_id}` });
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
      params: { select: 'id,user_id,airtable_student_id,owner_email,seller_id,label' },
      timeout: config.requestTimeoutMs,
    });
    const students = await fetchActiveStudents({ fresh: true });
    const byEmail = new Map(students.map((student) => [student.email, student]));
    const byId = new Map(students.map((student) => [student.id, student]));
    for (const row of response.data || []) {
      if (!validSellerId(row.seller_id) || isBlockedStorefront(row.seller_id)) continue;
      const student = row.airtable_student_id ? byId.get(row.airtable_student_id)
        : byEmail.get(String(row.owner_email || '').trim().toLowerCase());
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
    if (!validSellerId(entry.sellerId) || isBlockedStorefront(entry.sellerId)) continue;
    tracked.push({ ...entry, ownerKey: 'legacy', webhook: config.storefrontDiscordWebhookUrl });
  }
  return tracked;
}

async function maintainStudentStorefronts(request, response, input) {
  const root = `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableStudentsTable)}`;
  const headers = { Authorization: `Bearer ${config.airtablePat}` };
  let records;
  if (input.studentId) {
    if (!/^rec[A-Za-z0-9]{10,30}$/.test(input.studentId)) throw new Error('Invalid student record ID');
    records = [(await axios.get(`${root}/${input.studentId}`, { headers, timeout: config.requestTimeoutMs })).data];
  } else {
    if (input.task !== 'inspect-student') throw new Error('Exact student record ID required');
    const name = String(input.name || '').trim().toLowerCase();
    if (!/^[a-z\s-]{2,40}$/.test(name)) throw new Error('Provide a student name');
    records = (await axios.get(root, { headers, params: {
      filterByFormula: `FIND('${name}',LOWER({Name}))`, pageSize: 100,
    }, timeout: config.requestTimeoutMs })).data.records || [];
  }
  const results = [];
  for (const record of records) {
    const student = { id: record.id, email: String(record.fields?.Email || '').trim().toLowerCase() };
    const rows = await stores.list(student);
    if (input.task === 'quarantine-invalid') {
      if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'POST required' });
      if (!/^[0-9a-f-]{36}$/i.test(input.rowId || '') || input.expectedSellerId !== 'LOOKUP') throw new Error('Exact invalid LOOKUP row required');
      const row = rows.find((item) => item.id === input.rowId && item.seller_id === input.expectedSellerId);
      if (!row) return jsonResponse(response, 404, { error: 'Invalid row was not found in this student account' });
      const backupKey = `storefront:quarantine:${row.id}`;
      await redis.set(backupKey, { row, reason: 'URL path LOOKUP incorrectly parsed as seller ID', at: new Date().toISOString() }, { nx: true });
      await stores.remove(student, { id: `eq.${row.id}`, seller_id: 'eq.LOOKUP' });
      return jsonResponse(response, 200, { ok: true, quarantined: row.id, backupKey });
    }
    results.push({ studentId: student.id, name: record.fields?.Name, status: record.fields?.Status,
      rows: rows.map(({ id, seller_id, label, airtable_student_id, user_id }) => ({ id, seller_id, label,
        invalid: !validSellerId(seller_id), canonicalStudent: airtable_student_id === student.id, portalLinked: Boolean(user_id) })) });
  }
  return jsonResponse(response, 200, { ok: true, students: results });
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
  if (!internalRequest && (!config.cronSecret || request.headers.authorization !== `Bearer ${config.cronSecret}`)) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }
  try {
    const input = request.method === 'POST' ? await readJsonBody(request) : request.query || {};
    if (['inspect-student', 'quarantine-invalid'].includes(input.task)) {
      if (!config.cronSecret || request.headers.authorization !== `Bearer ${config.cronSecret}`) return jsonResponse(response, 403, { error: 'Admin authorization required' });
      return await maintainStudentStorefronts(request, response, input);
    }
    requireEnvironment(['KEEPA_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);
    const trackedStorefronts = await configuredStorefronts();
    if (trackedStorefronts.length === 0) {
      return jsonResponse(response, 200, { ok: true, skipped: true, reason: 'No student storefronts configured' });
    }
    const destinations = new Map();
    for (const store of trackedStorefronts) {
      const destination = `${store.webhook || store.ownerKey}:${store.sellerId}`;
      // A legacy config and a student subscription can target the same channel.
      // Favor the student entry and send just one alert to that destination.
      if (!destinations.has(destination)) destinations.set(destination, store);
    }
    const tracked = [...destinations.values()];
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
        jobId: input.cycle ? `${input.cycle}:${input.batchesLeft}` : undefined,
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
