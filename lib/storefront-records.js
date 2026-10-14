import axios from 'axios';
import { addStorefrontOnce } from './discord-commands.js';
import { assertStorefrontAllowed, isBlockedStorefront } from './storefront-policy.js';

export function validSellerId(value) {
  return /^[A-Z0-9]{10,32}$/.test(String(value || ''));
}

export function parseSellerId(value) {
  const raw = String(value || '').trim();
  let candidate = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { /* handled by validation below */ }
    if (!url || !/(^|\.)amazon\.(com|ca|co\.uk|com\.au|de|fr|it|es|co\.jp|in|com\.mx|com\.br|nl|se|pl|com\.be|ie|sg|ae|sa|com\.tr)$/.test(url.hostname)) {
      throw new Error('Enter a valid Amazon seller ID or an Amazon storefront URL containing seller= or me=.');
    }
    candidate = url.searchParams.get('seller') || url.searchParams.get('me') || '';
    // Never infer an ID from arbitrary path text (for example /lookup).
  }
  candidate = candidate.trim().toUpperCase();
  if (!validSellerId(candidate)) throw new Error('Enter a valid Amazon seller ID or an Amazon storefront URL containing seller= or me=.');
  return candidate;
}

const quoted = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
export function ownedStorefrontParams(student) {
  if (!student.id || !student.email) throw new Error('Student identity is incomplete');
  // Include pre-Discord website rows only while unassigned. An explicit
  // different student ID always wins over email; never cross tenant boundaries.
  return { or: `(airtable_student_id.eq.${quoted(student.id)},and(airtable_student_id.is.null,owner_email.eq.${quoted(student.email.toLowerCase())}))` };
}

export function visibleStorefronts(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!validSellerId(row.seller_id) || seen.has(row.seller_id)) return false;
    seen.add(row.seller_id); return true;
  }).map((row) => ({ ...row, blocked: isBlockedStorefront(row.seller_id) }));
}

export function storefrontRecords(config, http = axios) {
  const url = `${config.supabaseUrl}/rest/v1/student_storefronts`;
  const headers = { apikey: config.supabaseServiceRoleKey, Authorization: `Bearer ${config.supabaseServiceRoleKey}` };
  const options = (student, params = {}) => {
    if (!config.supabaseServiceRoleKey) throw new Error('Storefront storage is not configured');
    return { headers, params: { ...params, ...ownedStorefrontParams(student) }, timeout: config.requestTimeoutMs };
  };
  const list = async (student, params = {}) => {
    const response = await http.get(url, options(student, {
      select: 'id,user_id,airtable_student_id,owner_email,seller_id,label,created_at', order: 'created_at.asc', ...params,
    }));
    return response.data || [];
  };
  return {
    list,
    async add(student, sellerId, label, userId) {
      const validated = parseSellerId(sellerId);
      assertStorefrontAllowed(validated);
      return addStorefrontOnce({
        find: async () => (await list(student, { seller_id: `eq.${validated}`, limit: 1 }))[0] || null,
        insert: async () => {
          const response = await http.post(url, [{ airtable_student_id: student.id, owner_email: student.email,
            seller_id: validated, label, ...(userId ? { user_id: userId } : {}) }], {
            headers: { ...headers, Prefer: 'return=representation' }, timeout: config.requestTimeoutMs,
          });
          return response.data?.[0];
        },
      });
    },
    async remove(student, params) {
      return http.delete(url, options(student, params));
    },
  };
}
