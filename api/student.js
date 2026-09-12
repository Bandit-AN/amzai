import {
  config,
  fetchPortalStudentByEmail,
  fetchPortalStudentById,
  jsonResponse,
  readJsonBody,
  readPortalIdentity,
  updatePortalStudent,
} from '../lib/platform.js';

const bearerToken = (request) => String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
const supabaseHeaders = (token) => ({
  apikey: config.supabaseAnonKey,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function organizationForUser(identity, token) {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/organization_members?select=organization_id,role&user_id=eq.${encodeURIComponent(identity.userId)}&order=created_at.asc&limit=1`,
    { headers: supabaseHeaders(token) },
  );
  const rows = await response.json().catch(() => []);
  if (!response.ok) throw new Error(rows.message || 'Could not load your Buy Box Bandit organization');
  if (!rows[0]?.organization_id) throw new Error('Your Buy Box Bandit organization is not configured');
  return rows[0];
}

async function handleSheetConnection(request, response, identity) {
  if (identity.type !== 'supabase') {
    return jsonResponse(response, 403, { error: 'Sign in with Google to connect a spreadsheet' });
  }
  const token = bearerToken(request);
  const membership = await organizationForUser(identity, token);
  const tableUrl = `${config.supabaseUrl}/rest/v1/google_sheet_connections`;
  const headers = supabaseHeaders(token);
  if (request.method === 'GET') {
    const result = await fetch(
      `${tableUrl}?select=id,spreadsheet_id,spreadsheet_title,order_tracking_tab,expenses_tab,backend_tab,updated_at&organization_id=eq.${membership.organization_id}&is_active=eq.true&order=updated_at.desc&limit=1`,
      { headers },
    );
    const rows = await result.json().catch(() => []);
    if (!result.ok) throw new Error(rows.message || 'Could not load the connected spreadsheet');
    return jsonResponse(response, 200, { ok: true, connection: rows[0] || null });
  }
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    const spreadsheetId = String(body.spreadsheetId || '').trim();
    const spreadsheetTitle = String(body.spreadsheetTitle || '').trim().slice(0, 200);
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) throw new Error('Invalid Google spreadsheet ID');
    if (!spreadsheetTitle) throw new Error('Spreadsheet title is required');
    const deactivate = await fetch(
      `${tableUrl}?organization_id=eq.${membership.organization_id}&is_active=eq.true`,
      { method: 'PATCH', headers, body: JSON.stringify({ is_active: false }) },
    );
    if (!deactivate.ok) {
      const detail = await deactivate.json().catch(() => ({}));
      throw new Error(detail.message || 'Could not update the previous spreadsheet connection');
    }
    const save = await fetch(`${tableUrl}?on_conflict=organization_id,spreadsheet_id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        organization_id: membership.organization_id,
        connected_by: identity.userId,
        spreadsheet_id: spreadsheetId,
        spreadsheet_title: spreadsheetTitle,
        order_tracking_tab: 'Order Tracking',
        expenses_tab: 'Automated Order Expenses',
        backend_tab: 'Backend',
        is_active: true,
      }]),
    });
    const rows = await save.json().catch(() => []);
    if (!save.ok) throw new Error(rows.message || 'Could not save the spreadsheet connection');
    return jsonResponse(response, 200, { ok: true, connection: rows[0] });
  }
  return jsonResponse(response, 405, { error: 'Method not allowed' });
}

export default async function handler(request, response) {
  const identity = await readPortalIdentity(request);
  if (!identity) return jsonResponse(response, 401, { error: 'Please sign in' });
  try {
    const student = identity.type === 'supabase'
      ? await fetchPortalStudentByEmail(identity.email)
      : await fetchPortalStudentById(identity.studentId);
    if (!student) return jsonResponse(response, 403, { error: 'This Google email is not an active Syndicate student' });
    if (request.query?.resource === 'sheet') {
      return handleSheetConnection(request, response, identity);
    }
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
