import axios from 'axios';

import {
  confirmWalmartAvailability,
  config,
  discordPayloads,
  emptyDiscordPayload,
  jsonResponse,
  readJsonBody,
  redis,
  workerAuthorized,
} from '../lib/platform.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function postDiscord(webhook, payload) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await axios.post(webhook, payload, { timeout: config.requestTimeoutMs });
    } catch (error) {
      if (error.response?.status !== 429 || attempt === 4) throw error;
      const retryAfterSeconds = Number(error.response?.data?.retry_after || 1);
      await wait(Math.max(250, Math.ceil(retryAfterSeconds * 1000)));
    }
  }
  throw new Error('Discord delivery retries exhausted');
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (!workerAuthorized(request)) return jsonResponse(response, 401, { error: 'Unauthorized' });
  let runId;
  let studentId;
  let postedPayloads = 0;
  const lockKey = () => `run:${runId}:deliveryLock:${studentId}`;
  try {
    ({ runId, studentId } = await readJsonBody(request));
    if (!runId || !studentId) throw new Error('runId and studentId are required');
    if (await redis.get(`run:${runId}:delivered:${studentId}`)) {
      return jsonResponse(response, 200, { ok: true, duplicate: true });
    }
    // This is an idempotency claim, not merely a short concurrency lock. Keep
    // it for the run lifetime so a QStash/Vercel retry cannot repost a Discord
    // batch after the first request succeeded but the function response was lost.
    const locked = await redis.set(lockKey(), true, { nx: true, ex: config.runTtlSeconds });
    if (!locked) return jsonResponse(response, 409, { ok: false, error: 'Delivery already in progress' });
    const [meta, deals] = await Promise.all([
      redis.get(`run:${runId}:meta`),
      redis.get(`run:${runId}:assignment:${studentId}`),
    ]);
    const student = meta?.students?.find((item) => item.id === studentId);
    if (!student || !Array.isArray(deals)) throw new Error('Student or assignment was not found');

    const availabilityChecks = await Promise.all(deals.map(async (deal) => {
      try {
        return { deal, available: await confirmWalmartAvailability(deal) };
      } catch (error) {
        console.error(JSON.stringify({
          event: 'walmart_availability_check_failed', runId, studentId,
          itemId: deal.itemId, message: error.message,
        }));
        return { deal, available: false };
      }
    }));
    const deliverableDeals = availabilityChecks.filter((result) => result.available)
      .map((result) => result.deal);
    const unavailableDeals = availabilityChecks.filter((result) => !result.available)
      .map((result) => ({ itemId: result.deal.itemId, title: result.deal.title }));
    if (unavailableDeals.length) {
      await redis.set(`run:${runId}:unavailable:${studentId}`, unavailableDeals, { ex: config.runTtlSeconds });
    }

    const errors = deliverableDeals.length === 0 ? await redis.lrange(`run:${runId}:errors`, 0, -1) : [];
    const payloads = deliverableDeals.length > 0
      ? discordPayloads(student, deliverableDeals)
      : [emptyDiscordPayload(student, { candidateCount: meta.candidateCount, failedCandidates: errors.length })];
    const webhook = new URL(student.discordWebhookUrl);
    webhook.searchParams.set('wait', 'true');
    for (const payload of payloads) {
      await postDiscord(webhook.href, payload);
      postedPayloads += 1;
    }
    await Promise.all([
      redis.set(`run:${runId}:delivered:${studentId}`, true, { ex: config.runTtlSeconds }),
      ...deliverableDeals.map((deal) => redis.set(
        `catalog:delivered-asin:${deal.asin}`,
        true,
        { ex: config.productCooldownSeconds },
      )),
    ]);
    return jsonResponse(response, 200, {
      ok: true, runId, studentId, delivered: deliverableDeals.length,
      suppressedUnavailable: unavailableDeals.length,
    });
  } catch (error) {
    // An explicit failure before any Discord post is safe to retry. Once one
    // message has posted, retain the claim to prefer a partial delivery over
    // sending duplicates with ambiguous webhook acknowledgement.
    if (runId && studentId && postedPayloads === 0) await redis.del(lockKey()).catch(() => {});
    console.error(JSON.stringify({ event: 'delivery_failed', runId, studentId, message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
