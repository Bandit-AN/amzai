import {
  analyzeCandidate,
  config,
  isRetryableProviderError,
  jsonResponse,
  markCandidatesAnalyzed,
  publishMessage,
  readJsonBody,
  redis,
  requireEnvironment,
  salesVelocityManualReviewEntry,
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
  }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (!workerAuthorized(request)) return jsonResponse(response, 401, { error: 'Unauthorized' });
  let runId;
  let chunkIndex;
  const processingKey = () => `run:${runId}:chunk:${chunkIndex}:analysisProcessing`;
  try {
    requireEnvironment(['GEMINI_KEY', 'KEEPA_API_KEY', 'QSTASH_TOKEN', 'PUBLIC_BASE_URL', 'WORKER_SECRET']);
    ({ runId, chunkIndex } = await readJsonBody(request));
    if (!runId || !Number.isInteger(chunkIndex)) throw new Error('runId and integer chunkIndex are required');

    const completionKey = `run:${runId}:chunk:${chunkIndex}:complete`;
    if (await redis.get(`run:${runId}:cancelled`)) {
      return jsonResponse(response, 200, { ok: true, cancelled: true });
    }
    if (await redis.get(completionKey)) {
      const [completedChunks, meta] = await redis.mget([
        `run:${runId}:completedChunks`,
        `run:${runId}:meta`,
      ]);
      await advanceRun(runId, Number(completedChunks || 0), meta);
      return jsonResponse(response, 200, { ok: true, duplicate: true });
    }
    const processing = await redis.set(
      processingKey(), true,
      { nx: true, ex: 300 },
    );
    if (!processing) {
      return jsonResponse(response, 409, { ok: false, error: 'Analysis already in progress' });
    }
    const candidates = await redis.get(`run:${runId}:detail:${chunkIndex}`);
    const candidate = candidates && !Array.isArray(candidates) ? candidates : candidates?.[0];
    if (!candidate) throw new Error('Enriched analysis candidate was not found or expired');

    let qualified = 0;
    const analyzedCandidates = [];
    const errors = [];
    {
      try {
        const result = await analyzeCandidate(candidate);
        if (result.funnel?.amazonUpcMatchFound) {
          await redis.incr(`run:${runId}:funnel:amazonUpcMatchFound`);
        }
        if (result.funnel?.exactAmazonMatchFound) {
          await redis.incr(`run:${runId}:funnel:exactAmazonMatchFound`);
        }
        if (result.funnel?.economicsPassed) {
          await redis.incr(`run:${runId}:funnel:economicsPassed`);
        }
        if (result.funnel?.titleSearchFallbackMatched) {
          await redis.incr(`run:${runId}:funnel:titleSearchFallbackMatches`);
        }
        if (result.deal) {
          await Promise.all([
            redis.rpush(`run:${runId}:qualified`, result.deal),
            redis.incr(`run:${runId}:funnel:automaticallyQualified`),
          ]);
          qualified += 1;
        } else {
          if (result.rejection === 'missing_sales_velocity') {
            const priced = (result.diagnostics || [])
              .find((d) => d.rejection === 'missing_sales_velocity' && d.amazonPrice);
            if (priced) {
              await Promise.all([
                redis.rpush(`run:${runId}:manualReview`, salesVelocityManualReviewEntry(candidate, priced)),
                redis.incr(`run:${runId}:funnel:manualReview`),
              ]);
            }
          }
          await redis.rpush(`run:${runId}:rejections`, {
            chunkIndex,
            title: candidate.title,
            reason: result.rejection || 'other',
            walmartIdentity: {
              title: candidate.title,
              currentPrice: candidate.currentPrice,
              upc: candidate.upc,
              variantId: candidate.variantId,
              seller: candidate.seller,
            },
            diagnostics: result.diagnostics || [],
          });
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

    const firstCompletion = await redis.set(completionKey, true, { nx: true, ex: config.runTtlSeconds });
    let completedChunks = null;
    if (firstCompletion) {
      completedChunks = await redis.incr(`run:${runId}:completedChunks`);
      const meta = await redis.get(`run:${runId}:meta`);
      await advanceRun(runId, completedChunks, meta);
    }
    await redis.del(processingKey()).catch(() => {});
    return jsonResponse(response, 200, {
      ok: true,
      runId,
      chunkIndex,
      qualified,
      skippedRecentlyAnalyzed: 0,
      completedChunks,
      errors,
    });
  } catch (error) {
    if (runId && Number.isInteger(chunkIndex)) await redis.del(processingKey()).catch(() => {});
    console.error(JSON.stringify({ event: 'analysis_failed', runId, chunkIndex, message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
