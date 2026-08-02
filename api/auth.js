import {
  config,
  createStudentSession,
  fetchPortalStudentByUsername,
  jsonResponse,
  readJsonBody,
  verifyStudentPassword,
} from '../lib/platform.js';

const sessionCookie = (value, maxAge) => [
  `syndicate_session=${value}`,
  'Path=/',
  'HttpOnly',
  'Secure',
  'SameSite=Strict',
  `Max-Age=${maxAge}`,
].join('; ');

export default async function handler(request, response) {
  if (request.method === 'DELETE') {
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    return jsonResponse(response, 200, { ok: true });
  }
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });
  try {
    if (!config.portalSessionSecret) throw new Error('Student login is not configured yet');
    const { username, password } = await readJsonBody(request);
    const student = await fetchPortalStudentByUsername(username);
    const valid = student?.passwordHash && await verifyStudentPassword(password, student.passwordHash);
    if (!valid) return jsonResponse(response, 401, { error: 'Invalid username or password' });
    response.setHeader('Set-Cookie', sessionCookie(createStudentSession(student), 12 * 60 * 60));
    return jsonResponse(response, 200, {
      ok: true,
      student: { name: student.name, onboardingComplete: student.onboardingComplete },
    });
  } catch (error) {
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
