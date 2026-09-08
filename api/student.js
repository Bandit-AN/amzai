import {
  config,
  fetchPortalStudentByEmail,
  fetchPortalStudentById,
  jsonResponse,
  readJsonBody,
  readPortalIdentity,
  updatePortalStudent,
} from '../lib/platform.js';

export default async function handler(request, response) {
  const identity = await readPortalIdentity(request);
  if (!identity) return jsonResponse(response, 401, { error: 'Please sign in' });
  try {
    const student = identity.type === 'supabase'
      ? await fetchPortalStudentByEmail(identity.email)
      : await fetchPortalStudentById(identity.studentId);
    if (!student) return jsonResponse(response, 403, { error: 'This Google email is not an active Syndicate student' });
    if (request.method === 'GET') {
      const { discordWebhookUrl: _privateWebhook, ...safeStudent } = student;
      return jsonResponse(response, 200, {
        ok: true,
        student: safeStudent,
        onboardingVideoUrl: config.onboardingVideoUrl,
        platformManagedKeys: ['Walmart scraping', 'Gemini', 'Keepa'],
      });
    }
    if (request.method === 'PATCH') {
      const body = await readJsonBody(request);
      const minRoi = Number(body.minRoi);
      const minMonthlySales = Number(body.minMonthlySales);
      const maxCost = Number(body.maxCost);
      if (!(minRoi >= 0 && minRoi <= 1000)) throw new Error('Minimum ROI must be between 0 and 1000');
      if (!(minMonthlySales >= 0 && minMonthlySales <= 1000000)) throw new Error('Monthly sales is invalid');
      if (!(maxCost > 0 && maxCost <= 1000000)) throw new Error('Maximum cost is invalid');
      await updatePortalStudent(student.id, { ...body, minRoi, minMonthlySales, maxCost });
      return jsonResponse(response, 200, { ok: true });
    }
    return jsonResponse(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    return jsonResponse(response, 400, { ok: false, error: error.message });
  }
}
