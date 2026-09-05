import { randomUUID } from 'node:crypto';

import {
  analysisDelaySeconds,
  candidateFingerprint,
  candidatePriority,
  config,
  dailyWalmartWindow,
  fetchActiveStudents,
  fetchKeepaTokenStatus,
  fetchWalmartCatalog,
  filterRecentlyAnalyzedCandidates,
  getRunSummary,
  hasWalmartDealSignal,
  isRetryableProviderError,
  isExcludedWalmartBrand,
  jsonResponse,
  keepaInitialDelaySeconds,
  publishBatch,
  publishMessage,
  prioritizeCandidates,
  readJsonBody,
  redis,
  requireEnvironment,
  walmartUrlsForWindow,
  walmartSourceUrls,
  withinBuyCostLimit,
  workerAuthorized,
} from '../lib/platform.js';

export default async function handler(request, response) {
  let activeCollectionId;
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
    // Walmart production runs are fixed-size cohorts. A partial cohort is not
    // launched: discovery must supply 100 fresh, cheaply eligible products
    // before any detail/Keepa work begins.
    const candidateLimit = Math.min(
      config.walmartEligibleCohortSize,
      config.maxCandidates,
      config.walmartDetailLookupLimit,
    );
    const scanUntilQualified = input.scanUntilQualified === true
      || input.scanUntilQualified === 'true';
    const requestedMinRoi = Number(input.minRoi);
    const requestedMinMonthlySales = Number(input.minMonthlySales);
    const minRoiOverride = Number.isFinite(requestedMinRoi)
      ? Math.max(config.minimumRoi, requestedMinRoi)
      : null;
    const minMonthlySalesOverride = Number.isFinite(requestedMinMonthlySales)
      ? Math.max(config.minimumMonthlySales, requestedMinMonthlySales)
      : null;
    const continuingCollection = typeof input.collectionId === 'string' && input.collectionId.length > 0;
    // Explicit operator override for an already-collected cohort. The default
    // remains a hard 100; this only lets an authenticated request launch a
    // preserved short cohort after the operator approves the shortfall.
    const allowPartialCollection = continuingCollection
      && (input.allowPartialCollection === true || input.allowPartialCollection === 'true');
    const collectionId = continuingCollection ? input.collectionId : randomUUID();
    activeCollectionId = collectionId;
    if (!continuingCollection) {
      const claimed = await redis.set('walmart:freshCollection:active', collectionId, {
        nx: true, ex: config.runTtlSeconds,
      });
      if (!claimed) {
        return jsonResponse(response, 409, {
          ok: false,
          error: 'A fresh-product collection is already active',
          collectionId: await redis.get('walmart:freshCollection:active'),
        });
      }
    }
    const requestedWindow = Number.parseInt(input.window, 10);
    const explicitWindow = Number.isInteger(requestedWindow);
    const sourceWindow = explicitWindow ? Math.max(0, requestedWindow) : dailyWalmartWindow();
    const sourceUrls = walmartUrlsForWindow(sourceWindow, config.walmartPagesPerRun);
    const discoveryPoolLimit = Math.min(
      config.maxCandidates,
      candidateLimit * config.walmartDiscoveryMultiplier,
    );
    const [fetchedStudents, rawScrapedCandidates] = await Promise.all([
      fetchActiveStudents(),
      fetchWalmartCatalog(discoveryPoolLimit, sourceUrls),
    ]);
    if (fetchedStudents.length === 0) throw new Error('No active students with Discord webhooks were found');
    const dealEligible = rawScrapedCandidates.filter(hasWalmartDealSignal);
    const excludedNoDealSignal = rawScrapedCandidates.length - dealEligible.length;
    const brandEligible = dealEligible.filter((candidate) => !isExcludedWalmartBrand(candidate));
    const excludedWalmartBrands = dealEligible.length - brandEligible.length;
    const allBrandEligibleCandidates = brandEligible.filter((candidate) =>
      withinBuyCostLimit(candidate.currentPrice, candidate.discoverySourceUrl));
    const excludedBuyCost = brandEligible.length - allBrandEligibleCandidates.length;
    const refresh = input.refresh === true || input.refresh === 'true';
    const freshEligibleCandidates = refresh || allBrandEligibleCandidates.length === 0
      ? allBrandEligibleCandidates
      : await filterRecentlyAnalyzedCandidates(allBrandEligibleCandidates);
    const skippedRecentlyAnalyzed = allBrandEligibleCandidates.length - freshEligibleCandidates.length;
    const collectionKey = `walmart:freshCollection:${collectionId}`;
    const previousCollection = continuingCollection ? await redis.get(collectionKey) : null;
    const runMinimumRoi = minRoiOverride ?? previousCollection?.runMinimumRoi ?? null;
    const runMinimumMonthlySales = minMonthlySalesOverride
      ?? previousCollection?.runMinimumMonthlySales
      ?? null;
    const students = fetchedStudents.map((student) => ({
      ...student,
      ...(runMinimumRoi === null ? {} : { minRoi: runMinimumRoi }),
      ...(runMinimumMonthlySales === null ? {} : { minMonthlySales: runMinimumMonthlySales }),
    }));
    const priorCandidates = Array.isArray(previousCollection?.candidates) ? previousCollection.candidates : [];
    const mergedByFingerprint = new Map(priorCandidates.map((candidate) => [
      candidateFingerprint(candidate), candidate,
    ]));
    for (const candidate of freshEligibleCandidates) {
      mergedByFingerprint.set(candidateFingerprint(candidate), candidate);
    }
    // A collection spans many source windows. Re-rank the entire accumulated
    // pool globally; otherwise early pages win by insertion order even when a
    // later page contains much deeper, cleaner markdown opportunities.
    const collectedCandidates = prioritizeCandidates([...mergedByFingerprint.values()])
      .map((candidate) => ({
        ...candidate,
        discoveryScore: candidatePriority(candidate),
      }));
    const pagesScanned = Number(previousCollection?.pagesScanned || 0) + sourceUrls.length;
    const totalSourcePages = walmartSourceUrls().length;
    const collection = {
      collectionId,
      createdAt: previousCollection?.createdAt || new Date().toISOString(),
      status: collectedCandidates.length >= candidateLimit ? 'ready' : 'collecting',
      candidates: collectedCandidates,
      pagesScanned,
      totalSourcePages,
      startWindow: Number(previousCollection?.startWindow ?? sourceWindow),
      nextWindow: sourceWindow + sourceUrls.length,
      discoveredCount: Number(previousCollection?.discoveredCount || 0) + rawScrapedCandidates.length,
      initiallyEligibleCount: Number(previousCollection?.initiallyEligibleCount || 0) + allBrandEligibleCandidates.length,
      excludedNoDealSignal: Number(previousCollection?.excludedNoDealSignal || 0) + excludedNoDealSignal,
      excludedWalmartBrands: Number(previousCollection?.excludedWalmartBrands || 0) + excludedWalmartBrands,
      excludedBuyCost: Number(previousCollection?.excludedBuyCost || 0) + excludedBuyCost,
      skippedRecentlyAnalyzed: Number(previousCollection?.skippedRecentlyAnalyzed || 0) + skippedRecentlyAnalyzed,
      sourceUrls: [...new Set([...(previousCollection?.sourceUrls || []), ...sourceUrls])],
      scanUntilQualified: scanUntilQualified || previousCollection?.scanUntilQualified === true,
      runMinimumRoi,
      runMinimumMonthlySales,
    };
    const launchPartialForContinuousScan = collection.scanUntilQualified
      && collectedCandidates.length > 0
      && pagesScanned >= totalSourcePages;
    if (!refresh && !allowPartialCollection
      && !launchPartialForContinuousScan
      && collectedCandidates.length < candidateLimit && pagesScanned < totalSourcePages) {
      await redis.set(collectionKey, collection, { ex: config.runTtlSeconds });
      await publishMessage({
        url: `${config.publicBaseUrl}/api/cron`,
        body: {
          collectionId,
          window: collection.nextWindow,
          scanUntilQualified: collection.scanUntilQualified,
          ...(collection.runMinimumRoi === null ? {} : { minRoi: collection.runMinimumRoi }),
          ...(collection.runMinimumMonthlySales === null
            ? {}
            : { minMonthlySales: collection.runMinimumMonthlySales }),
        },
        deduplicationId: `${collectionId}-discover-${collection.nextWindow}`,
        delaySeconds: config.walmartDetailJobSpacingSeconds,
      });
      return jsonResponse(response, 202, {
        ok: true,
        collecting: true,
        collectionId,
        collectedFreshEligible: collectedCandidates.length,
        requiredFreshEligible: candidateLimit,
        remaining: candidateLimit - collectedCandidates.length,
        pagesScanned,
        totalSourcePages,
        nextWindow: collection.nextWindow,
      });
    }
    if (!refresh && !allowPartialCollection && !launchPartialForContinuousScan
      && collectedCandidates.length < candidateLimit) {
      collection.status = 'exhausted';
      await redis.set(collectionKey, collection, { ex: config.runTtlSeconds });
      await redis.del('walmart:freshCollection:active');
      if (collection.scanUntilQualified && collectedCandidates.length === 0) {
        const retryWindow = collection.nextWindow;
        await publishMessage({
          url: `${config.publicBaseUrl}/api/cron`,
          body: {
            window: retryWindow,
            scanUntilQualified: true,
            ...(collection.runMinimumRoi === null ? {} : { minRoi: collection.runMinimumRoi }),
            ...(collection.runMinimumMonthlySales === null
              ? {}
              : { minMonthlySales: collection.runMinimumMonthlySales }),
          },
          deduplicationId: `${collectionId}-wait-for-fresh-${retryWindow}`,
          delaySeconds: 21600,
        });
        return jsonResponse(response, 202, {
          ok: true,
          waitingForFreshInventory: true,
          collectionId,
          retryWindow,
          retryDelayHours: 6,
        });
      }
      return jsonResponse(response, 409, {
        ok: false,
        collectionId,
        reason: 'The entire Walmart source catalog was exhausted before 100 fresh eligible products were found',
        requiredFreshEligible: candidateLimit,
        collectedFreshEligible: collectedCandidates.length,
        shortfall: candidateLimit - collectedCandidates.length,
        pagesScanned,
        totalSourcePages,
      });
    }
    const candidates = collectedCandidates.slice(0, candidateLimit);
    const notSelectedAfterLimit = Math.max(0, collectedCandidates.length - candidates.length);
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
      discoveredCount: collection.discoveredCount,
      initiallyEligibleCount: collection.initiallyEligibleCount,
      scrapedCandidateCount: collection.discoveredCount,
      excludedWalmartBrands: collection.excludedWalmartBrands,
      excludedNoDealSignal: collection.excludedNoDealSignal,
      excludedBuyCost: collection.excludedBuyCost,
      skippedRecentlyAnalyzed: collection.skippedRecentlyAnalyzed,
      sourceWindow: collection.startWindow,
      sourceUrl: collection.sourceUrls[0],
      sourceUrls: collection.sourceUrls,
      sourcePages: collection.pagesScanned,
      sourceCandidateCounts: Object.fromEntries(sourceUrls.map((url) => [
        url,
        rawScrapedCandidates.filter((candidate) => candidate.discoverySourceUrl === url).length,
      ])),
      refresh,
      discoveryPoolLimit,
      freshCandidateCount: collectedCandidates.length,
      notSelectedAfterLimit,
      continuationRunsRemaining: Math.max(0, Number.parseInt(input.continuationRunsRemaining, 10) || 0),
      auditMode: input.audit === true || input.audit === 'true',
      partialCollectionApproved: allowPartialCollection,
      scanUntilQualified: collection.scanUntilQualified,
      runMinimumRoi,
      runMinimumMonthlySales,
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
    await Promise.all([
      redis.del(collectionKey),
      redis.del('walmart:freshCollection:active'),
    ]);

    const initiallyQueuedChunks = chunks.length;
    await publishBatch(chunks.map((_, chunkIndex) => ({
      url: `${config.publicBaseUrl}/api/enrich`,
      body: { runId, chunkIndex },
      deduplicationId: `${runId}-enrich-${chunkIndex}`,
      // Avoid bursting 50 simultaneous detail-page requests into a scraper's
      // small prototype concurrency allowance.
      delaySeconds: chunkIndex * config.walmartDetailJobSpacingSeconds,
    })));
    console.log(JSON.stringify({ event: 'run_queued', runId, students: students.length, candidates: candidates.length, chunks: chunks.length }));
    return jsonResponse(response, 202, {
      ok: true,
      runId,
      collectionId,
      students: students.length,
      candidates: candidates.length,
      scrapedCandidates: rawScrapedCandidates.length,
      excludedWalmartBrands,
      excludedNoDealSignal,
      excludedBuyCost,
      skippedRecentlyAnalyzed,
      freshCandidates: collectedCandidates.length,
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
    if (activeCollectionId) {
      const lockOwner = await redis.get('walmart:freshCollection:active').catch(() => null);
      if (lockOwner === activeCollectionId && !isRetryableProviderError(error)) {
        await redis.del('walmart:freshCollection:active').catch(() => {});
      }
    }
    console.error(JSON.stringify({ event: 'cron_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
