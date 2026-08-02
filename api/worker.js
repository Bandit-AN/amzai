import axios from 'axios';

import {
  config,
  discordPayload,
  jsonResponse,
  readJsonBody,
  redis,
  workerAuthorized,
} from '../lib/platform.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (!workerAuthorized(request)) return jsonResponse(response, 401, { error: 'Unauthorized' });
  let runId;
  let studentId;
  const lockKey = () => `run:${runId}:deliveryLock:${studentId}`;
  try {
    ({ runId, studentId } = await readJsonBody(request));
    if (!runId || !studentId) throw new Error('runId and studentId are required');
    if (await redis.get(`run:${runId}:delivered:${studentId}`)) {
      return jsonResponse(response, 200, { ok: true, duplicate: true });
    }
    const locked = await redis.set(lockKey(), true, { nx: true, ex: 120 });
    if (!locked) return jsonResponse(response, 409, { ok: false, error: 'Delivery already in progress' });
    const [meta, deals] = await Promise.all([
      redis.get(`run:${runId}:meta`),
      redis.get(`run:${runId}:assignment:${studentId}`),
    ]);
    const student = meta?.students?.find((item) => item.id === studentId);
    if (!student || !Array.isArray(deals)) throw new Error('Student or assignment was not found');

    await axios.post(student.discordWebhookUrl, discordPayload(student, deals), {
      timeout: config.requestTimeoutMs,
    });
    await redis.set(`run:${runId}:delivered:${studentId}`, true, { ex: config.runTtlSeconds });
    await redis.del(lockKey());
    return jsonResponse(response, 200, { ok: true, runId, studentId, delivered: deals.length });
  } catch (error) {
    if (runId && studentId) await redis.del(lockKey()).catch(() => {});
    console.error(JSON.stringify({ event: 'delivery_failed', runId, studentId, message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
