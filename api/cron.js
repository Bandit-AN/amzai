import { randomUUID } from 'node:crypto';

import {
  config,
  fetchActiveStudents,
  fetchWalmartCatalog,
  jsonResponse,
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
      'UPSTASH_REDIS_REST_TOKEN', 'PUBLIC_BASE_URL', 'WORKER_SECRET',
    ]);
    const [students, candidates] = await Promise.all([
      fetchActiveStudents(),
      fetchWalmartCatalog(),
    ]);
    if (students.length === 0) throw new Error('No active students with Discord webhooks were found');
    if (candidates.length === 0) throw new Error('Walmart scraping returned no usable candidates');

    const runId = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}`;
    const chunks = [];
    for (let index = 0; index < candidates.length; index += config.analysisChunkSize) {
      chunks.push(candidates.slice(index, index + config.analysisChunkSize));
    }
    const run = {
      runId,
      createdAt: new Date().toISOString(),
      status: 'analyzing',
      students,
      candidateCount: candidates.length,
      totalChunks: chunks.length,
      targetDealsPerStudent: config.targetDealsPerStudent,
    };
    await Promise.all([
      redis.set(`run:${runId}:meta`, run, { ex: config.runTtlSeconds }),
      ...chunks.map((chunk, index) =>
        redis.set(`run:${runId}:chunk:${index}`, chunk, { ex: config.runTtlSeconds })),
    ]);

    await publishBatch(chunks.map((_, chunkIndex) => ({
      url: `${config.publicBaseUrl}/api/analyze`,
      body: { runId, chunkIndex },
      deduplicationId: `${runId}-analyze-${chunkIndex}`,
    })));
    console.log(JSON.stringify({ event: 'run_queued', runId, students: students.length, candidates: candidates.length, chunks: chunks.length }));
    return jsonResponse(response, 202, {
      ok: true,
      runId,
      students: students.length,
      candidates: candidates.length,
      analysisJobs: chunks.length,
      targetUniqueDeals: students.length * config.targetDealsPerStudent,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'cron_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
