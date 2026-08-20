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
    if (meta.auditMode) {
      await redis.set(`run:${runId}:finalized`, true, { ex: config.runTtlSeconds });
      await redis.del(lockKey());
      return jsonResponse(response, 200, {
        ok: true,
        runId,
        auditMode: true,
        awaitingAudit: rawDeals.length,
        assigned: 0,
        studentsReceivingDeals: 0,
        analysisErrors: analysisErrors.length,
      });
    }
    const previousDelivery = await redis.mget(rawDeals.map((deal) => `catalog:delivered-asin:${deal.asin}`));
    const freshDeals = rawDeals.filter((_, index) => !previousDelivery[index]);
    const assignmentLimit = config.deliverAllQualified
      ? Math.max(1, freshDeals.length)
      : meta.targetDealsPerStudent;
    const assignments = allocateDeals(freshDeals, meta.students, assignmentLimit, runId);
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
    if (Number(meta.continuationRunsRemaining) > 0) {
      // Advance by however many pages this run's window actually consumed
      // (meta.sourcePages), not a flat +1, so the next continuation starts
      // right after them instead of overlapping almost entirely.
      const nextWindow = Number(meta.sourceWindow) + Number(meta.sourcePages || 1);
      await publishBatch([{
        url: `${config.publicBaseUrl}/api/cron`,
        body: {
          window: nextWindow,
          limit: config.maxCandidates,
          continuationRunsRemaining: Number(meta.continuationRunsRemaining) - 1,
        },
        deduplicationId: `${runId}-continue-${nextWindow}`,
        delaySeconds: 120,
      }]);
    }
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
      unfilledSlots: config.deliverAllQualified
        ? 0
        : Math.max(0, meta.students.length * meta.targetDealsPerStudent - assigned),
    });
  } catch (error) {
    if (runId) await redis.del(lockKey()).catch(() => {});
    console.error(JSON.stringify({ event: 'finalize_failed', runId, message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
