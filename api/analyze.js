import {
  analyzeCandidate,
  config,
  jsonResponse,
  publishMessage,
  readJsonBody,
  redis,
  requireEnvironment,
  workerAuthorized,
} from '../lib/platform.js';

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
      return jsonResponse(response, 200, { ok: true, duplicate: true });
    }
    const candidates = await redis.get(`run:${runId}:chunk:${chunkIndex}`);
    if (!Array.isArray(candidates)) throw new Error('Analysis chunk was not found or expired');

    let qualified = 0;
    const errors = [];
    for (const candidate of candidates) {
      try {
        const deal = await analyzeCandidate(candidate);
        if (deal) {
          await redis.rpush(`run:${runId}:qualified`, deal);
          qualified += 1;
        }
      } catch (error) {
        errors.push({ title: candidate.title, message: error.message });
      }
    }

    const firstCompletion = await redis.set(completionKey, true, { nx: true, ex: config.runTtlSeconds });
    let completedChunks = null;
    if (firstCompletion) {
      completedChunks = await redis.incr(`run:${runId}:completedChunks`);
      const meta = await redis.get(`run:${runId}:meta`);
      if (completedChunks === meta?.totalChunks) {
        await publishMessage({
          url: `${config.publicBaseUrl}/api/finalize`,
          body: { runId },
          deduplicationId: `${runId}-finalize`,
        });
      }
    }
    return jsonResponse(response, 200, { ok: true, runId, chunkIndex, qualified, completedChunks, errors });
  } catch (error) {
    console.error(JSON.stringify({ event: 'analysis_failed', runId, chunkIndex, message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
