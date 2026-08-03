import {
  allocateDeals,
  config,
  jsonResponse,
  publishBatch,
  readJsonBody,
  redis,
  workerAuthorized,
} from '../lib/platform.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (!workerAuthorized(request)) return jsonResponse(response, 401, { error: 'Unauthorized' });
  let runId;
  const lockKey = () => `run:${runId}:finalizeLock`;
  try {
    ({ runId } = await readJsonBody(request));
    if (!runId) throw new Error('runId is required');
    if (await redis.get(`run:${runId}:cancelled`)) {
      return jsonResponse(response, 200, { ok: true, cancelled: true });
    }
    if (await redis.get(`run:${runId}:finalized`)) {
      return jsonResponse(response, 200, { ok: true, duplicate: true });
    }
    const locked = await redis.set(lockKey(), true, { nx: true, ex: 300 });
    if (!locked) return jsonResponse(response, 409, { ok: false, error: 'Finalization already in progress' });

    const meta = await redis.get(`run:${runId}:meta`);
    if (!meta) throw new Error('Run metadata was not found or expired');
    const rawDeals = await redis.lrange(`run:${runId}:qualified`, 0, -1);
    const analysisErrors = await redis.lrange(`run:${runId}:errors`, 0, -1);
    const previousDelivery = await redis.mget(rawDeals.map((deal) => `catalog:delivered-asin:${deal.asin}`));
    const freshDeals = rawDeals.filter((_, index) => !previousDelivery[index]);
    const assignments = allocateDeals(freshDeals, meta.students, meta.targetDealsPerStudent, runId);
    const deliveryJobs = [];
    for (const [studentId, deals] of Object.entries(assignments)) {
      await redis.set(`run:${runId}:assignment:${studentId}`, deals, { ex: config.runTtlSeconds });
      deliveryJobs.push({
        url: `${config.publicBaseUrl}/api/worker`,
        body: { runId, studentId },
        deduplicationId: `${runId}-deliver-${studentId}`,
      });
    }
    if (deliveryJobs.length > 0) await publishBatch(deliveryJobs);
    await redis.set(`run:${runId}:finalized`, true, { ex: config.runTtlSeconds });
    await redis.del(lockKey());
    const assigned = Object.values(assignments).reduce((sum, deals) => sum + deals.length, 0);
    return jsonResponse(response, 200, {
      ok: true,
      runId,
      qualified: rawDeals.length,
      suppressedPreviouslyDelivered: rawDeals.length - freshDeals.length,
      assigned,
      studentsReceivingDeals: deliveryJobs.length,
      analysisErrors: analysisErrors.length,
      unfilledSlots: Math.max(0, meta.students.length * meta.targetDealsPerStudent - assigned),
    });
  } catch (error) {
    if (runId) await redis.del(lockKey()).catch(() => {});
    console.error(JSON.stringify({ event: 'finalize_failed', runId, message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
