import { randomUUID } from 'node:crypto';

import {
  analysisDelaySeconds,
  config,
  fetchActiveStudents,
  fetchKeepaTokenStatus,
  fetchWalmartCatalog,
  jsonResponse,
  keepaInitialDelaySeconds,
  publishBatch,
  redis,
  requireEnvironment,
} from '../lib/platform.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }

  try {
    requireEnvironment([
      'WALMART_SCRAPER_API_KEY', 'WALMART_TARGET_URLS', 'AIRTABLE_PAT',
      'AIRTABLE_BASE_ID', 'QSTASH_TOKEN', 'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN', 'PUBLIC_BASE_URL', 'WORKER_SECRET', 'KEEPA_API_KEY',
    ]);
    const requestedLimit = Number.parseInt(request.query?.limit, 10);
    const candidateLimit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, config.maxCandidates))
      : config.maxCandidates;
    const [students, candidates] = await Promise.all([
      fetchActiveStudents(),
      fetchWalmartCatalog(candidateLimit),
    ]);
    if (students.length === 0) throw new Error('No active students with Discord webhooks were found');
    if (candidates.length === 0) throw new Error('Walmart scraping returned no usable candidates');

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

    await publishBatch(chunks.map((_, chunkIndex) => ({
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
      candidateLimit,
      analysisJobs: chunks.length,
      initialDelayMinutes: Math.ceil(initialDelaySeconds / 60),
      estimatedAnalysisMinutes: Math.ceil(analysisDelaySeconds(
        Math.max(0, chunks.length - 1),
        effectiveRefillRate,
        config.keepaTokensPerCandidate,
        initialDelaySeconds,
      ) / 60),
      targetUniqueDeals: students.length * config.targetDealsPerStudent,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'cron_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
