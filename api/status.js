import {
  config,
  getRunSummary,
  jsonResponse,
} from '../lib/platform.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }
  const runId = String(request.query?.runId || '').trim();
  if (!runId) return jsonResponse(response, 400, { error: 'runId is required' });

  try {
    const summary = await getRunSummary(runId);
    if (!summary) return jsonResponse(response, 404, { error: 'Run was not found or expired' });
    return jsonResponse(response, 200, { ok: true, ...summary });
  } catch (error) {
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
