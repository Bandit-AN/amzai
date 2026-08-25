import {
  analysisDelaySeconds,
  automaticEligibilityReason,
  config,
  enrichRetailerCandidate,
  isRetryableProviderError,
  jsonResponse,
  manualReviewEntry,
  markCandidatesAnalyzed,
  publishMessage,
  readJsonBody,
  redis,
  requireEnvironment,
  sanitizedRetryError,
  workerAuthorized,
} from '../lib/platform.js';

const finalizeJob = (runId) => ({
  url: `${config.publicBaseUrl}/api/finalize`,
  body: { runId },
  deduplicationId: `${runId}-finalize`,
});

async function completeCandidate(runId, chunkIndex, meta) {
  const first = await redis.set(
    `run:${runId}:chunk:${chunkIndex}:complete`, true,
    { nx: true, ex: config.runTtlSeconds },
  );
  if (!first) return null;
  const completed = await redis.incr(`run:${runId}:completedChunks`);
  if (completed >= Number(meta.totalChunks)) await publishMessage(finalizeJob(runId));
  return completed;
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (!workerAuthorized(request)) return jsonResponse(response, 401, { error: 'Unauthorized' });
  let runId;
  let chunkIndex;
  let candidate;
  let meta;
  try {
    requireEnvironment([
      'QSTASH_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
      'PUBLIC_BASE_URL', 'WORKER_SECRET',
    ]);
    ({ runId, chunkIndex } = await readJsonBody(request));
    if (!runId || !Number.isInteger(chunkIndex)) throw new Error('runId and integer chunkIndex are required');
    if (await redis.get(`run:${runId}:cancelled`)) {
      return jsonResponse(response, 200, { ok: true, cancelled: true });
    }
    if (await redis.get(`run:${runId}:chunk:${chunkIndex}:enrichmentComplete`)) {
      return jsonResponse(response, 200, { ok: true, duplicate: true });
    }

    const [chunk, storedMeta] = await redis.mget([
      `run:${runId}:chunk:${chunkIndex}`,
      `run:${runId}:meta`,
    ]);
    candidate = Array.isArray(chunk) ? chunk[0] : null;
    meta = storedMeta;
    if (!candidate || !meta) throw new Error('Candidate or run metadata was not found');

    const firstAttempt = await redis.set(
      `run:${runId}:chunk:${chunkIndex}:detailAttempted`, true,
      { nx: true, ex: config.runTtlSeconds },
    );
    if (firstAttempt) await redis.incr(`run:${runId}:funnel:detailPagesChecked`);

    const enriched = await enrichRetailerCandidate(candidate);
    await redis.set(`run:${runId}:detail:${chunkIndex}`, enriched, { ex: config.runTtlSeconds });

    if (enriched.detailVerified && enriched.upc) {
      const firstIdentityRecord = await redis.set(
        `run:${runId}:chunk:${chunkIndex}:identityRecorded`, true,
        { nx: true, ex: config.runTtlSeconds },
      );
      if (firstIdentityRecord) await redis.incr(`run:${runId}:funnel:upcConfirmed`);
    }
    if (enriched.detailVerified && enriched.onlineAvailable === true) {
      const firstStockRecord = await redis.set(
        `run:${runId}:chunk:${chunkIndex}:stockRecorded`, true,
        { nx: true, ex: config.runTtlSeconds },
      );
      if (firstStockRecord) await redis.incr(`run:${runId}:funnel:stockConfirmed`);
    }

    const manualReason = automaticEligibilityReason(enriched);

    if (manualReason) {
      const manualEntry = manualReviewEntry(enriched, manualReason);
      const firstManualRecord = await redis.set(
        `run:${runId}:chunk:${chunkIndex}:manualRecorded`, true,
        { nx: true, ex: config.runTtlSeconds },
      );
      if (firstManualRecord) {
        try {
          await Promise.all([
            redis.rpush(`run:${runId}:manualReview`, manualEntry),
            redis.rpush(`run:${runId}:rejections`, {
              chunkIndex, title: enriched.title, reason: manualReason,
              walmartIdentity: manualEntry,
            }),
            redis.incr(`run:${runId}:funnel:manualReview`),
            markCandidatesAnalyzed([candidate]),
          ]);
        } catch (error) {
          await redis.del(`run:${runId}:chunk:${chunkIndex}:manualRecorded`).catch(() => {});
          throw error;
        }
      }
      await redis.set(
        `run:${runId}:chunk:${chunkIndex}:enrichmentComplete`, true,
        { ex: config.runTtlSeconds },
      );
      const completedChunks = await completeCandidate(runId, chunkIndex, meta);
      return jsonResponse(response, 200, {
        ok: true, runId, chunkIndex, manualReview: true, reason: manualReason, completedChunks,
      });
    }

    const queueClaimKey = `run:${runId}:chunk:${chunkIndex}:analysisQueueClaim`;
    const claimed = await redis.set(queueClaimKey, true, { nx: true, ex: config.runTtlSeconds });
    if (claimed) {
      try {
        // Allocate an analysis position once per chunk and reuse it on publish
        // retries. Incrementing on every retry previously pushed a 100-item run
        // out to queue position 189 and left it stalled for a day.
        const queueIndexKey = `run:${runId}:chunk:${chunkIndex}:analysisQueueIndex`;
        let queueIndex = Number(await redis.get(queueIndexKey));
        if (!Number.isInteger(queueIndex) || queueIndex < 1) {
          queueIndex = await redis.incr(`run:${runId}:analysisQueued`);
          await redis.set(queueIndexKey, queueIndex, { ex: config.runTtlSeconds });
        }
        await publishMessage({
          url: `${config.publicBaseUrl}/api/analyze`,
          body: { runId, chunkIndex },
          deduplicationId: `${runId}-analyze-${chunkIndex}`,
          delaySeconds: analysisDelaySeconds(
            Math.max(0, queueIndex - 1),
            meta.keepaTokensPerMinute,
            config.keepaTokensPerCandidate,
            meta.initialDelaySeconds,
            meta.keepaTokensAtQueueTime,
          ),
        });
      } catch (error) {
        await redis.del(queueClaimKey).catch(() => {});
        throw error;
      }
    }
    await redis.set(
      `run:${runId}:chunk:${chunkIndex}:enrichmentComplete`, true,
      { ex: config.runTtlSeconds },
    );
    return jsonResponse(response, 202, { ok: true, runId, chunkIndex, queuedForAnalysis: true });
  } catch (error) {
    if (isRetryableProviderError(error)) throw sanitizedRetryError(error, 'Retailer detail lookup');
    console.error(JSON.stringify({ event: 'enrichment_failed', runId, chunkIndex, message: error.message }));
    if (runId && Number.isInteger(chunkIndex) && candidate && meta) {
      try {
        const reason = candidate?.sourceRetailer === 'Target'
          ? 'target_detail_lookup_error' : 'walmart_detail_lookup_error';
        const fallback = manualReviewEntry({
          ...candidate, detailVerified: false, onlineAvailable: false,
        }, reason);
        const firstErrorRecord = await redis.set(
          `run:${runId}:chunk:${chunkIndex}:enrichmentErrorRecorded`, true,
          { nx: true, ex: config.runTtlSeconds },
        );
        if (firstErrorRecord) {
          await Promise.all([
            redis.rpush(`run:${runId}:errors`, {
              chunkIndex, title: candidate.title, message: error.message,
            }),
            redis.rpush(`run:${runId}:manualReview`, fallback),
            redis.rpush(`run:${runId}:rejections`, {
              chunkIndex, title: candidate.title, reason, walmartIdentity: fallback,
            }),
            redis.incr(`run:${runId}:funnel:manualReview`),
            markCandidatesAnalyzed([candidate]),
          ]);
        }
        await redis.set(
          `run:${runId}:chunk:${chunkIndex}:enrichmentComplete`, true,
          { ex: config.runTtlSeconds },
        );
        const completedChunks = await completeCandidate(runId, chunkIndex, meta);
        return jsonResponse(response, 200, {
          ok: true, runId, chunkIndex, manualReview: true, reason, completedChunks,
        });
      } catch (recordingError) {
        console.error(JSON.stringify({
          event: 'enrichment_failure_recording_failed', runId, chunkIndex,
          message: recordingError.message,
        }));
      }
    }
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
