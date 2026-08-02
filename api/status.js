import {
  config,
  jsonResponse,
  redis,
} from '../lib/platform.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }
  const runId = String(request.query?.runId || '').trim();
  if (!runId) return jsonResponse(response, 400, { error: 'runId is required' });

  try {
    const [meta, completedChunks, deals, errors, finalized] = await Promise.all([
      redis.get(`run:${runId}:meta`),
      redis.get(`run:${runId}:completedChunks`),
      redis.lrange(`run:${runId}:qualified`, 0, -1),
      redis.lrange(`run:${runId}:errors`, 0, -1),
      redis.get(`run:${runId}:finalized`),
    ]);
    if (!meta) return jsonResponse(response, 404, { error: 'Run was not found or expired' });
    const delivery = [];
    for (const student of meta.students || []) {
      const assigned = await redis.get(`run:${runId}:assignment:${student.id}`);
      const delivered = await redis.get(`run:${runId}:delivered:${student.id}`);
      delivery.push({ assigned: Array.isArray(assigned) ? assigned.length : 0, delivered: Boolean(delivered) });
    }
    return jsonResponse(response, 200, {
      ok: true,
      runId,
      status: finalized ? 'finalized' : 'analyzing',
      candidates: meta.candidateCount,
      completedJobs: Number(completedChunks || 0),
      totalJobs: meta.totalChunks,
      qualifiedDeals: deals.length,
      analysisErrors: errors.length,
      delivery,
    });
  } catch (error) {
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
