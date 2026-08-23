import { randomUUID } from 'node:crypto';

import {
  analysisDelaySeconds,
  config,
  fetchActiveStudents,
  fetchKeepaTokenStatus,
  fetchTargetCatalog,
  filterRecentlyAnalyzedCandidates,
  getRunSummary,
  hasWalmartDealSignal,
  isExcludedTargetBrand,
  jsonResponse,
  keepaInitialDelaySeconds,
  publishBatch,
  redis,
  requireEnvironment,
  targetSourceUrls,
  withinBuyCostLimit,
} from '../lib/platform.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }
  try {
    if (!config.targetEnabled) throw new Error('TARGET_ENABLED must be true');
    requireEnvironment([
      'AIRTABLE_PAT', 'AIRTABLE_BASE_ID', 'QSTASH_TOKEN',
      'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
      'PUBLIC_BASE_URL', 'WORKER_SECRET', 'KEEPA_API_KEY',
    ]);
    if (!config.scrapingAntApiKey && !config.scraperApiKey && !config.walmartScraperApiKey) {
      throw new Error('A scraper provider key is required');
    }
    const recentRunIds = await redis.lrange('runs:recent', 0, 4);
    for (const recentRunId of recentRunIds) {
      const recentRun = await getRunSummary(recentRunId);
      if (recentRun?.status === 'analyzing') {
        return jsonResponse(response, 409, {
          ok: false, error: 'A sourcing run is already active', activeRunId: recentRunId,
        });
      }
    }

    const availableSourceUrls = targetSourceUrls();
    const sourceWindow = Math.max(0, (await redis.incr('target:sourceWindow')) - 1);
    // ScrapingAnt's rendered-browser free tier is single-concurrency, while a
    // Vercel invocation is bounded. Rotate one feed per request instead of
    // serially rendering every Target department until the function times out.
    const sourceUrls = [availableSourceUrls[sourceWindow % availableSourceUrls.length]];
    const candidateLimit = config.targetDetailLookupLimit;
    const discoveryPoolLimit = Math.min(config.maxCandidates, candidateLimit * 5);
    const [students, discovered] = await Promise.all([
      fetchActiveStudents(),
      fetchTargetCatalog(discoveryPoolLimit, sourceUrls),
    ]);
    if (students.length === 0) throw new Error('No active students were found');
    if (discovered.length === 0) throw new Error('Target scraping returned no usable candidates');
    const dealEligible = discovered.filter(hasWalmartDealSignal);
    const brandEligible = dealEligible.filter((candidate) => !isExcludedTargetBrand(candidate));
    const costEligible = brandEligible.filter((candidate) => withinBuyCostLimit(candidate.currentPrice));
    const fresh = await filterRecentlyAnalyzedCandidates(costEligible);
    const candidates = fresh.slice(0, candidateLimit);
    if (candidates.length === 0) {
      return jsonResponse(response, 200, {
        ok: true, skipped: true, reason: 'No fresh Target clearance candidates were found',
        discovered: discovered.length,
      });
    }

    const keepaStatus = await fetchKeepaTokenStatus();
    const effectiveRefillRate = Math.min(config.keepaTokensPerMinute, keepaStatus.refillRate);
    const initialDelaySeconds = keepaInitialDelaySeconds(
      keepaStatus.tokensLeft, effectiveRefillRate, config.keepaTokensPerCandidate,
    );
    const runId = `${new Date().toISOString().slice(0, 10)}-target-${randomUUID()}`;
    const chunks = candidates.map((candidate) => [candidate]);
    const run = {
      runId,
      createdAt: new Date().toISOString(),
      status: 'analyzing',
      retailer: 'Target',
      students,
      candidateCount: candidates.length,
      discoveredCount: discovered.length,
      initiallyEligibleCount: costEligible.length,
      scrapedCandidateCount: discovered.length,
      excludedWalmartBrands: dealEligible.length - brandEligible.length,
      excludedNoDealSignal: discovered.length - dealEligible.length,
      excludedBuyCost: brandEligible.length - costEligible.length,
      skippedRecentlyAnalyzed: costEligible.length - fresh.length,
      sourceWindow,
      sourceUrl: sourceUrls[0],
      sourceUrls,
      sourcePages: sourceUrls.length,
      availableSourcePages: availableSourceUrls.length,
      sourceCandidateCounts: Object.fromEntries(sourceUrls.map((url) => [
        url, discovered.filter((candidate) => candidate.discoverySourceUrl === url).length,
      ])),
      discoveryPoolLimit,
      freshCandidateCount: fresh.length,
      notSelectedAfterLimit: Math.max(0, fresh.length - candidates.length),
      continuationRunsRemaining: 0,
      auditMode: true,
      staged: false,
      funnelVersion: 2,
      totalChunks: chunks.length,
      targetDealsPerStudent: config.targetDealsPerStudent,
      keepaTokensAtQueueTime: keepaStatus.tokensLeft,
      keepaTokensPerMinute: effectiveRefillRate,
      initialDelaySeconds,
      targetZipCode: config.targetZipCode,
    };
    await Promise.all([
      redis.set(`run:${runId}:meta`, run, { ex: config.runTtlSeconds }),
      ...chunks.map((chunk, index) => redis.set(
        `run:${runId}:chunk:${index}`, chunk, { ex: config.runTtlSeconds },
      )),
    ]);
    await redis.lpush('runs:recent', runId);
    await redis.ltrim('runs:recent', 0, 19);
    await publishBatch(chunks.map((_, chunkIndex) => ({
      url: `${config.publicBaseUrl}/api/enrich`,
      body: { runId, chunkIndex },
      deduplicationId: `${runId}-target-enrich-${chunkIndex}`,
      // Target browser renders routinely take 25–40 seconds. Keep every job
      // outside the prior job's window so ScrapingAnt's one-concurrent-request
      // free tier does not return 403 for otherwise valid requests.
      delaySeconds: chunkIndex * 60,
    })));
    console.log(JSON.stringify({
      event: 'target_run_queued', runId, discovered: discovered.length, candidates: candidates.length,
    }));
    return jsonResponse(response, 202, {
      ok: true,
      auditMode: true,
      retailer: 'Target',
      runId,
      discovered: discovered.length,
      freshCandidates: fresh.length,
      candidates: candidates.length,
      sourcePages: sourceUrls.length,
      availableSourcePages: availableSourceUrls.length,
      sourceUrl: sourceUrls[0],
      estimatedAnalysisMinutes: Math.max(
        Math.ceil(Math.max(0, chunks.length - 1) * 60 / 60),
        Math.ceil(analysisDelaySeconds(
        Math.max(0, chunks.length - 1), effectiveRefillRate,
        config.keepaTokensPerCandidate, initialDelaySeconds, keepaStatus.tokensLeft,
        ) / 60),
      ),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'target_cron_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
