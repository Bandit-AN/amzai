import {
  allocateDeals,
  analysisDelaySeconds,
  analyzeCandidate,
  candidateFingerprint,
  config,
  isRetryableProviderError,
  jsonResponse,
  markCandidatesAnalyzed,
  publishMessage,
  publishBatch,
  readJsonBody,
  redis,
  requireEnvironment,
  workerAuthorized,
} from '../lib/platform.js';

const finalizeJob = (runId) => ({
  url: `${config.publicBaseUrl}/api/finalize`,
  body: { runId },
  deduplicationId: `${runId}-finalize`,
});

async function advanceRun(runId, completedChunks, meta) {
  if (!meta || !completedChunks) return;
  if (completedChunks >= meta.totalChunks) {
    await publishMessage(finalizeJob(runId));
    return;
  }
  if (!meta.staged) return;
  if (completedChunks % config.analysisBatchSize !== 0) return;

  const waveLockKey = `run:${runId}:wave:${completedChunks}`;
  const waveLocked = await redis.set(waveLockKey, true, { nx: true, ex: 300 });
  if (!waveLocked) return;
  try {
    const qualifiedDeals = await redis.lrange(`run:${runId}:qualified`, 0, -1);
    const previousDelivery = await redis.mget(
      qualifiedDeals.map((deal) => `catalog:delivered-asin:${deal.asin}`),
    );
    const freshDeals = qualifiedDeals.filter((_, index) => !previousDelivery[index]);
    const assignments = allocateDeals(freshDeals, meta.students, meta.targetDealsPerStudent, runId);
    const allSlotsFilled = meta.students.every(
      (student) => assignments[student.id]?.length >= meta.targetDealsPerStudent,
    );
    if (allSlotsFilled) {
      const stoppedMeta = { ...meta, totalChunks: completedChunks, stoppedEarly: true };
      await redis.set(`run:${runId}:meta`, stoppedMeta, { ex: config.runTtlSeconds });
      await publishMessage(finalizeJob(runId));
      return;
    }

    const nextEnd = Math.min(completedChunks + config.analysisBatchSize, meta.totalChunks);
    await publishBatch(Array.from({ length: nextEnd - completedChunks }, (_, localIndex) => {
      const nextChunkIndex = completedChunks + localIndex;
      return {
        url: `${config.publicBaseUrl}/api/analyze`,
        body: { runId, chunkIndex: nextChunkIndex },
        deduplicationId: `${runId}-analyze-${nextChunkIndex}`,
        delaySeconds: analysisDelaySeconds(
          localIndex + 1,
          meta.keepaTokensPerMinute,
          config.keepaTokensPerCandidate,
        ),
      };
    }));
  } finally {
    await redis.del(waveLockKey).catch(() => {});
  }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (!workerAuthorized(request)) return jsonResponse(response, 401, { error: 'Unauthorized' });
  let runId;
  let chunkIndex;
  try {
    requireEnvironment(['GEMINI_KEY', 'KEEPA_API_KEY', 'QSTASH_TOKEN', 'PUBLIC_BASE_URL', 'WORKER_SECRET']);
    ({ runId, chunkIndex } = await readJsonBody(request));
    if (!runId || !Number.isInteger(chunkIndex)) throw new Error('runId and integer chunkIndex are required');

    const completionKey = `run:${runId}:chunk:${chunkIndex}:complete`;
    if (await redis.get(completionKey)) {
      const [completedChunks, meta] = await redis.mget([
        `run:${runId}:completedChunks`,
        `run:${runId}:meta`,
      ]);
      await advanceRun(runId, Number(completedChunks || 0), meta);
      return jsonResponse(response, 200, { ok: true, duplicate: true });
    }
    const candidates = await redis.get(`run:${runId}:chunk:${chunkIndex}`);
    if (!Array.isArray(candidates)) throw new Error('Analysis chunk was not found or expired');

    let qualified = 0;
    let skippedRecentlyAnalyzed = 0;
    const analyzedCandidates = [];
    const errors = [];
    for (const candidate of candidates) {
      if (await redis.get(`catalog:seen:${candidateFingerprint(candidate)}`)) {
        skippedRecentlyAnalyzed += 1;
        continue;
      }
      try {
        const deal = await analyzeCandidate(candidate);
        if (deal) {
          await redis.rpush(`run:${runId}:qualified`, deal);
          qualified += 1;
        }
      } catch (error) {
        if (isRetryableProviderError(error)) throw error;
        const detail = { chunkIndex, title: candidate.title, message: error.message };
        errors.push(detail);
        await redis.rpush(`run:${runId}:errors`, detail);
      }
      analyzedCandidates.push(candidate);
    }
    await markCandidatesAnalyzed(analyzedCandidates);
    if (skippedRecentlyAnalyzed) {
      await redis.incr(`run:${runId}:skippedRecentlyAnalyzed`);
    }

    const firstCompletion = await redis.set(completionKey, true, { nx: true, ex: config.runTtlSeconds });
    let completedChunks = null;
    if (firstCompletion) {
      completedChunks = await redis.incr(`run:${runId}:completedChunks`);
      const meta = await redis.get(`run:${runId}:meta`);
      await advanceRun(runId, completedChunks, meta);
    }
    return jsonResponse(response, 200, {
      ok: true,
      runId,
      chunkIndex,
      qualified,
      skippedRecentlyAnalyzed,
      completedChunks,
      errors,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'analysis_failed', runId, chunkIndex, message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
