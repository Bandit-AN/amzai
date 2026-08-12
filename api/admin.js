import {
  cachedValue,
  config,
  fetchActiveStudents,
  fetchKeepaTokenStatus,
  getRunSummary,
  jsonResponse,
  redis,
} from '../lib/platform.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (config.cronSecret && request.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { error: 'Unauthorized' });
  }
  try {
    const [runIds, keepa, students] = await Promise.all([
      redis.lrange('runs:recent', 0, 9),
      cachedValue('cache:keepa:status', 60, fetchKeepaTokenStatus),
      fetchActiveStudents(),
    ]);
    const runs = (await Promise.all(runIds.map((runId) => getRunSummary(runId)))).filter(Boolean);
    return jsonResponse(response, 200, {
      ok: true,
      keepa,
      students: students.map((student) => ({
        name: student.name,
        minRoi: student.minRoi,
        minMonthlySales: student.minMonthlySales,
        maxCost: student.maxCost,
        excludedBrands: student.excludedBrands,
        webhookConfigured: Boolean(student.discordWebhookUrl),
      })),
      schedule: { cron: '0 13 * * *', timezone: 'UTC', pacific: '5–6 AM' },
      runs,
    });
  } catch (error) {
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
