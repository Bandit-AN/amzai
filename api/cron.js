import { randomUUID } from 'node:crypto';

import {
  analysisDelaySeconds,
  config,
  dailyWalmartWindow,
  fetchActiveStudents,
  fetchKeepaTokenStatus,
  fetchWalmartCatalog,
  filterRecentlyAnalyzedCandidates,
  getRunSummary,
  hasWalmartDealSignal,
  isExcludedWalmartBrand,
  jsonResponse,
  keepaInitialDelaySeconds,
  publishBatch,
  readJsonBody,
  redis,
  requireEnvironment,
  walmartUrlsForDailyRun,
  walmartUrlsForWindow,
  withinBuyCostLimit,
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
      'WALMART_TARGET_URLS', 'AIRTABLE_PAT',
      'AIRTABLE_BASE_ID', 'QSTASH_TOKEN', 'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN', 'PUBLIC_BASE_URL', 'WORKER_SECRET', 'KEEPA_API_KEY',
    ]);
    if (!config.scrapingAntApiKey && !config.scraperApiKey && !config.walmartScraperApiKey) {
      throw new Error('SCRAPINGANT_API_KEY, SCRAPERAPI_KEY, or WALMART_SCRAPER_API_KEY is required');
    }
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
      ? Math.max(1, Math.min(requestedLimit, config.maxCandidates, config.walmartDetailLookupLimit))
      : Math.min(config.maxCandidates, config.walmartDetailLookupLimit);
    const requestedWindow = Number.parseInt(input.window, 10);
    const explicitWindow = Number.isInteger(requestedWindow);
    const sourceWindow = explicitWindow ? Math.max(0, requestedWindow) : dailyWalmartWindow();
    const sourceUrls = explicitWindow
      ? walmartUrlsForWindow(sourceWindow, config.walmartPagesPerRun)
      : walmartUrlsForDailyRun();
    const discoveryPoolLimit = Math.min(
      config.maxCandidates,
      candidateLimit * config.walmartDiscoveryMultiplier,
    );
    const [students, rawScrapedCandidates] = await Promise.all([
      fetchActiveStudents(),
      fetchWalmartCatalog(discoveryPoolLimit, sourceUrls),
    ]);
    if (students.length === 0) throw new Error('No active students with Discord webhooks were found');
    if (rawScrapedCandidates.length === 0) throw new Error('Walmart scraping returned no usable candidates');
    const dealEligible = rawScrapedCandidates.filter(hasWalmartDealSignal);
    const excludedNoDealSignal = rawScrapedCandidates.length - dealEligible.length;
    const brandEligible = dealEligible.filter((candidate) => !isExcludedWalmartBrand(candidate));
    const excludedWalmartBrands = dealEligible.length - brandEligible.length;
    const allBrandEligibleCandidates = brandEligible.filter((candidate) =>
      withinBuyCostLimit(candidate.currentPrice, candidate.discoverySourceUrl));
    const excludedBuyCost = brandEligible.length - allBrandEligibleCandidates.length;
    if (allBrandEligibleCandidates.length === 0) {
      throw new Error('No scraped candidates passed the markdown, brand, and buy-cost filters');
    }
    const refresh = input.refresh === true || input.refresh === 'true';
    const freshEligibleCandidates = refresh
      ? allBrandEligibleCandidates
      : await filterRecentlyAnalyzedCandidates(allBrandEligibleCandidates);
    const skippedRecentlyAnalyzed = allBrandEligibleCandidates.length - freshEligibleCandidates.length;
    const candidates = freshEligibleCandidates.slice(0, candidateLimit);
    const notSelectedAfterLimit = Math.max(0, freshEligibleCandidates.length - candidates.length);
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
      discoveredCount: rawScrapedCandidates.length,
      initiallyEligibleCount: allBrandEligibleCandidates.length,
      scrapedCandidateCount: rawScrapedCandidates.length,
      excludedWalmartBrands,
      excludedNoDealSignal,
      excludedBuyCost,
      skippedRecentlyAnalyzed,
      sourceWindow,
      sourceUrl: sourceUrls[0],
      sourceUrls,
      sourcePages: sourceUrls.length,
      sourceCandidateCounts: Object.fromEntries(sourceUrls.map((url) => [
        url,
        rawScrapedCandidates.filter((candidate) => candidate.discoverySourceUrl === url).length,
      ])),
      refresh,
      discoveryPoolLimit,
      freshCandidateCount: freshEligibleCandidates.length,
      notSelectedAfterLimit,
      continuationRunsRemaining: Math.max(0, Number.parseInt(input.continuationRunsRemaining, 10) || 0),
      auditMode: input.audit === true || input.audit === 'true',
      staged: false,
      funnelVersion: 2,
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

    const initiallyQueuedChunks = chunks.length;
    await publishBatch(chunks.map((_, chunkIndex) => ({
      url: `${config.publicBaseUrl}/api/enrich`,
      body: { runId, chunkIndex },
      deduplicationId: `${runId}-enrich-${chunkIndex}`,
      // Avoid bursting 50 simultaneous detail-page requests into a scraper's
      // small prototype concurrency allowance.
      delaySeconds: chunkIndex * 10,
    })));
    console.log(JSON.stringify({ event: 'run_queued', runId, students: students.length, candidates: candidates.length, chunks: chunks.length }));
    return jsonResponse(response, 202, {
      ok: true,
      runId,
      students: students.length,
      candidates: candidates.length,
      scrapedCandidates: rawScrapedCandidates.length,
      excludedWalmartBrands,
      excludedNoDealSignal,
      excludedBuyCost,
      skippedRecentlyAnalyzed,
      freshCandidates: freshEligibleCandidates.length,
      notSelectedAfterLimit,
      discoveryPoolLimit,
      candidateLimit,
      detailLookupLimit: config.walmartDetailLookupLimit,
      detailJobs: chunks.length,
      analysisJobs: chunks.length,
      initiallyQueuedJobs: initiallyQueuedChunks,
      sourceWindow,
      sourceUrl: sourceUrls[0],
      sourceUrls,
      sourcePages: sourceUrls.length,
      initialDelayMinutes: Math.ceil(initialDelaySeconds / 60),
      estimatedAnalysisMinutes: Math.ceil(analysisDelaySeconds(
        Math.max(0, chunks.length - 1),
        effectiveRefillRate,
        config.keepaTokensPerCandidate,
        initialDelaySeconds,
        keepaStatus.tokensLeft,
      ) / 60),
      targetUniqueDeals: config.deliverAllQualified
        ? candidates.length
        : students.length * config.targetDealsPerStudent,
      auditMode: run.auditMode,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'cron_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
