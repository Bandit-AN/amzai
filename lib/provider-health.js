import { createHash } from 'node:crypto';

export const providerHealthKey = (name, key) =>
  `scraper:health:${name}:${createHash('sha256').update(key || '').digest('hex').slice(0, 20)}`;

export function permanentProviderFailure(error) {
  const status = Number(error.response?.status);
  const body = JSON.stringify(error.response?.data || '').toLowerCase();
  if (![400, 401, 402, 403, 429].includes(status)) return null;
  if (/quota|credits? (?:exhausted|depleted)|insufficient credits|monthly.*limit|limit.*monthly|no.*credits|credit.*balance.*0|subscription.*expired/.test(body)) return 'quota_exhausted';
  if (status === 401 || /invalid api.?key|api.?key.*invalid/.test(body)) return 'credentials_rejected';
  return null;
}

export async function guardedProviderRequest({ redis, name, key, request }) {
  const healthKey = providerHealthKey(name, key);
  const health = await redis.get(healthKey);
  if (health?.blocked) {
    const error = new Error(`${name}: ${health.reason}; update provider credentials or quota`);
    error.response = { status: health.status };
    error.providerBlocked = true;
    throw error;
  }
  try { return await request(); }
  catch (error) {
    const reason = permanentProviderFailure(error);
    if (reason) {
      await redis.set(healthKey, { blocked: true, reason, status: Number(error.response.status),
        at: new Date().toISOString(), retryAfter: new Date(Date.now() + 6 * 3600000).toISOString() }, { ex: 21600 });
      const safe = new Error(`${name}: ${reason}; update provider credentials or quota`);
      safe.response = { status: Number(error.response.status) };
      safe.providerBlocked = true;
      throw safe;
    }
    const safe = new Error(`${name}: request failed${error.response?.status ? ` (HTTP ${error.response.status})` : ''}`);
    safe.response = error.response ? { status: error.response.status } : undefined;
    safe.code = error.code;
    throw safe;
  }
}
