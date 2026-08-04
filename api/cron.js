import { randomUUID } from 'node:crypto';

import {
  analysisDelaySeconds,
  config,
  fetchActiveStudents,
  fetchKeepaTokenStatus,
  fetchWalmartCatalog,
  filterRecentlyAnalyzedCandidates,
  getRunSummary,
  isExcludedWalmartBrand,
  jsonResponse,
  keepaInitialDelaySeconds,
  publishBatch,
  readJsonBody,
  redis,
  requireEnvironment,
  walmartUrlsForWindow,
  workerAuthorized,
} from '../lib/platform.js';

export default async function handler(request, response) {
  if (!['GET', 'POST'].includes(request.method)) return jsonResponse(response, 405, { error: 'Method not allowed' });
  const internalRequest = request.method === 'POST' && workerAuthorized(request);
  if (!internalRequest && config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }

  try {
    const input = request.method === 'POST' ? await readJsonBody(request) : (request.query || {});
    requireEnvironment([
      'WALMART_SCRAPER_API_KEY', 'WALMART_TARGET_URLS', 'AIRTABLE_PAT',
      'AIRTABLE_BASE_ID', 'QSTASH_TOKEN', 'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN', 'PUBLIC_BASE_URL', 'WORKER_SECRET', 'KEEPA_API_KEY',
    ]);
    const recentRunIds = await redis.lrange('runs:recent', 0, 4);
    for (const recentRunId of recentRunIds) {
      const recentRun = await getRunSummary(recentRunId);
      if (recentRun?.status === 'analyzing') {
        return jsonResponse(response, 409, {
          ok: false,
          error: 'A sourcing run is already active',
          activeRunId: recentRunId,
          completedJobs: recentRun.completedJobs,
          totalJobs: recentRun.totalJobs,
        });
      }
    }
    const requestedLimit = Number.parseInt(input.limit, 10);
    const candidateLimit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, config.maxCandidates))
      : config.maxCandidates;
    const requestedWindow = Number.parseInt(input.window, 10);
    const sourceWindow = Number.isInteger(requestedWindow)
      ? Math.max(0, requestedWindow)
      : Math.floor(Date.now() / 86400000);
    const sourceUrls = walmartUrlsForWindow(sourceWindow);
    const [students, rawScrapedCandidates] = await Promise.all([
      fetchActiveStudents(),
      fetchWalmartCatalog(Math.min(config.maxCandidates, candidateLimit * 2), sourceUrls),
    ]);
    if (students.length === 0) throw new Error('No active students with Discord webhooks were found');
    if (rawScrapedCandidates.length === 0) throw new Error('Walmart scraping returned no usable candidates');
    const allBrandEligibleCandidates = rawScrapedCandidates
      .filter((candidate) => !isExcludedWalmartBrand(candidate));
    const excludedWalmartBrands = rawScrapedCandidates.length - allBrandEligibleCandidates.length;
    const brandEligibleCandidates = allBrandEligibleCandidates.slice(0, candidateLimit);
    if (brandEligibleCandidates.length === 0) {
      throw new Error('Every scraped candidate was excluded as a Walmart private-label brand');
    }
    const candidates = input.refresh === true || input.refresh === 'true'
      ? brandEligibleCandidates
      : await filterRecentlyAnalyzedCandidates(brandEligibleCandidates);
    const skippedRecentlyAnalyzed = brandEligibleCandidates.length - candidates.length;
    if (candidates.length === 0) {
      return jsonResponse(response, 200, {
        ok: true,
        skipped: true,
        reason: 'No new or price-changed Walmart candidates were found',
        scrapedCandidates: rawScrapedCandidates.length,
        excludedWalmartBrands,
        skippedRecentlyAnalyzed,
      });
    }

    const runId = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}`;
    const chunks = candidates.map((candidate) => [candidate]);
    const keepaStatus = await fetchKeepaTokenStatus();
    const effectiveRefillRate = Math.min(config.keepaTokensPerMinute, keepaStatus.refillRate);
    const initialDelaySeconds = keepaInitialDelaySeconds(
      keepaStatus.tokensLeft,
      effectiveRefillRate,
      config.keepaTokensPerCandidate,
    );
    const run = {
      runId,
      createdAt: new Date().toISOString(),
      status: 'analyzing',
      students,
      candidateCount: candidates.length,
      scrapedCandidateCount: rawScrapedCandidates.length,
      excludedWalmartBrands,
      skippedRecentlyAnalyzed,
      sourceWindow,
      sourceUrl: sourceUrls[0],
      sourcePages: sourceUrls.length,
      continuationRunsRemaining: Math.max(0, Number.parseInt(input.continuationRunsRemaining, 10) || 0),
      staged: true,
      totalChunks: chunks.length,
      targetDealsPerStudent: config.targetDealsPerStudent,
      keepaTokensAtQueueTime: keepaStatus.tokensLeft,
      keepaTokensPerMinute: effectiveRefillRate,
      initialDelaySeconds,
    };
    await Promise.all([
      redis.set(`run:${runId}:meta`, run, { ex: config.runTtlSeconds }),
      ...chunks.map((chunk, index) =>
        redis.set(`run:${runId}:chunk:${index}`, chunk, { ex: config.runTtlSeconds })),
    ]);
    await redis.lpush('runs:recent', runId);
    await redis.ltrim('runs:recent', 0, 19);

    const initiallyQueuedChunks = Math.min(chunks.length, config.analysisBatchSize);
    await publishBatch(chunks.slice(0, initiallyQueuedChunks).map((_, chunkIndex) => ({
      url: `${config.publicBaseUrl}/api/analyze`,
      body: { runId, chunkIndex },
      deduplicationId: `${runId}-analyze-${chunkIndex}`,
      delaySeconds: analysisDelaySeconds(
        chunkIndex,
        effectiveRefillRate,
        config.keepaTokensPerCandidate,
        initialDelaySeconds,
      ),
    })));
    console.log(JSON.stringify({ event: 'run_queued', runId, students: students.length, candidates: candidates.length, chunks: chunks.length }));
    return jsonResponse(response, 202, {
      ok: true,
      runId,
      students: students.length,
      candidates: candidates.length,
      scrapedCandidates: rawScrapedCandidates.length,
      excludedWalmartBrands,
      skippedRecentlyAnalyzed,
      candidateLimit,
      analysisJobs: chunks.length,
      initiallyQueuedJobs: initiallyQueuedChunks,
      sourceWindow,
      sourceUrl: sourceUrls[0],
      sourcePages: sourceUrls.length,
      initialDelayMinutes: Math.ceil(initialDelaySeconds / 60),
      estimatedAnalysisMinutes: Math.ceil(analysisDelaySeconds(
        Math.max(0, chunks.length - 1),
        effectiveRefillRate,
        config.keepaTokensPerCandidate,
        initialDelaySeconds,
      ) / 60),
      targetUniqueDeals: config.deliverAllQualified
        ? candidates.length
        : students.length * config.targetDealsPerStudent,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'cron_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
