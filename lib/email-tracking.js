import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { config } from './platform.js';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const serviceHeaders = () => ({
  apikey: config.supabaseServiceRoleKey,
  Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  'Content-Type': 'application/json',
});

const base64url = (value) => Buffer.from(value).toString('base64url');
const encryptionKey = () => createHash('sha256').update(String(config.gmailTokenEncryptionKey || '')).digest();

export function encryptRefreshToken(token) {
  if (!config.gmailTokenEncryptionKey) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptRefreshToken(value) {
  if (!config.gmailTokenEncryptionKey) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY is not configured');
  const [iv, tag, encrypted] = String(value || '').split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv?.length || !tag?.length || !encrypted?.length) throw new Error('Stored Gmail token is invalid');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

const stateSecret = () => config.portalSessionSecret || config.gmailTokenEncryptionKey;
export function createGmailState({ organizationId, userId, email }) {
  if (!stateSecret()) throw new Error('PORTAL_SESSION_SECRET is not configured');
  const payload = base64url(JSON.stringify({ organizationId, userId, email, exp: Date.now() + 10 * 60 * 1000 }));
  const signature = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyGmailState(value) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature || !stateSecret()) throw new Error('Invalid Gmail connection state');
  const expected = createHmac('sha256', stateSecret()).update(payload).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('Invalid Gmail connection state');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!parsed.organizationId || !parsed.userId || !parsed.email || Number(parsed.exp) < Date.now()) {
    throw new Error('Gmail connection expired; please try again');
  }
  return parsed;
}

const redirectUri = () => `${config.publicBaseUrl}/api/student?resource=gmail&action=callback`;

export function gmailAuthorizationUrl(identity) {
  if (!config.publicBaseUrl || !config.googleGmailClientId || !config.googleGmailClientSecret || !config.gmailTokenEncryptionKey) {
    throw new Error('Daily Gmail tracking is not configured yet');
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.googleGmailClientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('login_hint', identity.email);
  url.searchParams.set('state', createGmailState(identity));
  return url.toString();
}

async function googleToken(body) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || 'Google authorization failed');
  return data;
}

export async function finishGmailConnection(code, stateValue) {
  const state = verifyGmailState(stateValue);
  const tokens = await googleToken({
    code,
    client_id: config.googleGmailClientId,
    client_secret: config.googleGmailClientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  if (!tokens.refresh_token) throw new Error('Google did not return offline access; reconnect and approve Gmail access');
  const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok) throw new Error(profile.error?.message || 'Could not verify the Gmail account');
  if (String(profile.emailAddress || '').toLowerCase() !== String(state.email).toLowerCase()) {
    throw new Error('Connect the same Google account used to sign in to Buy Box Bandit');
  }
  const response = await fetch(`${config.supabaseUrl}/rest/v1/gmail_connections?on_conflict=organization_id`, {
    method: 'POST',
    headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{
      organization_id: state.organizationId,
      connected_by: state.userId,
      google_email: profile.emailAddress,
      encrypted_refresh_token: encryptRefreshToken(tokens.refresh_token),
      granted_scopes: String(tokens.scope || GMAIL_SCOPE).split(/\s+/).filter(Boolean),
      is_active: true,
      last_error: null,
      updated_at: new Date().toISOString(),
    }]),
  });
  const rows = await response.json().catch(() => []);
  if (!response.ok) throw new Error(rows.message || 'Could not save the Gmail connection');
  return rows[0];
}

async function gmailAccessToken(connection) {
  const tokens = await googleToken({
    refresh_token: decryptRefreshToken(connection.encrypted_refresh_token),
    client_id: config.googleGmailClientId,
    client_secret: config.googleGmailClientSecret,
    grant_type: 'refresh_token',
  });
  return tokens.access_token;
}

function decodePart(part) {
  const own = part?.body?.data ? Buffer.from(part.body.data, 'base64url').toString('utf8') : '';
  return [own, ...(part?.parts || []).map(decodePart)].filter(Boolean).join('\n');
}

export function messageText(message) {
  const headers = Object.fromEntries((message?.payload?.headers || []).map((entry) => [String(entry.name).toLowerCase(), entry.value]));
  const decoded = decodePart(message?.payload);
  const links = [...decoded.matchAll(/href=["']([^"']+)["']/gi)].map((match) => match[1]).join(' ');
  const body = `${decoded} ${links}`.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
  return { subject: headers.subject || '', from: headers.from || '', date: headers.date || '', body };
}

const compact = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function emailContainsOrder(text, orderNumber) {
  const needle = compact(orderNumber);
  return needle.length >= 4 && compact(`${text.subject} ${text.body}`).includes(needle);
}

export function extractShipmentUpdate(text) {
  const content = `${text.subject} ${text.body}`.replace(/\s+/g, ' ');
  const labeledTracking = content.match(/(?:tracking(?:\s+(?:number|no\.?|code|id))?|track(?:\s+your)?\s+(?:package|shipment))[^A-Z0-9]{0,20}([A-Z0-9-]{8,30})/i)?.[1] || '';
  const candidates = [
    ['UPS', content.match(/\b1Z[A-Z0-9]{16}\b/i)?.[0]],
    ['AmazonShipping', content.match(/\bTBA\d{10,15}\b/i)?.[0]],
    ['USPS', content.match(/\b(?:9[2345]\d{18,20}|[A-Z]{2}\d{9}US)\b/i)?.[0]],
    ['FedEx', /^(?:\d{12}|\d{15}|\d{20}|\d{22})$/.test(labeledTracking) ? labeledTracking : content.match(/\bFedEx[^\d]{0,40}(\d{12}|\d{15}|\d{20}|\d{22})\b/i)?.[1]],
    ['OnTrac', content.match(/\bC\d{14}\b/i)?.[0]],
  ];
  const [carrier, trackingNumber] = candidates.find(([, number]) => number) || [null, null];
  const lower = content.toLowerCase();
  let status = 'unknown';
  if (/\bdelivered\b/.test(lower) && !/will be delivered|scheduled (?:for|to be delivered)/.test(lower)) status = 'delivered';
  else if (/out for delivery/.test(lower)) status = 'out_for_delivery';
  else if (/available for pickup|ready for pickup/.test(lower)) status = 'available_for_pickup';
  else if (/return(?:ed|ing)? to sender/.test(lower)) status = 'return_to_sender';
  else if (/shipment exception|delivery exception|delivery failed|undeliverable/.test(lower)) status = 'failure';
  else if (/has shipped|was shipped|shipped!|in transit|on the way/.test(lower)) status = 'in_transit';
  else if (/label (?:has been )?created|pre-shipment/.test(lower)) status = 'pre_transit';
  else if (/order (?:was |has been )?cancelled|order (?:was |has been )?canceled/.test(lower)) status = 'cancelled';
  const etaMatch = content.match(/(?:estimated (?:delivery|arrival)|arriv(?:es|ing|al)(?: by| on)?|expected (?:delivery|arrival))(?: date)?[:\s,-]*(?:on\s+)?((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?([A-Z][a-z]{2,8}\s+\d{1,2}(?:,?\s+\d{4})?)/i);
  let expectedDeliveryAt = null;
  if (etaMatch) {
    const candidate = new Date(etaMatch[0].replace(/^.*?(?=(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i, ''));
    if (!Number.isNaN(candidate.getTime())) {
      if (!/\d{4}/.test(etaMatch[0])) candidate.setFullYear(new Date().getFullYear());
      expectedDeliveryAt = candidate.toISOString();
    }
  }
  return { carrier, trackingNumber, status, expectedDeliveryAt };
}

const orderStatus = (trackingStatus, current) => {
  if (trackingStatus === 'delivered') return 'delivered';
  if (trackingStatus === 'return_to_sender') return 'returned';
  if (['in_transit', 'out_for_delivery', 'available_for_pickup'].includes(trackingStatus)) return 'shipped';
  if (trackingStatus === 'cancelled') return 'cancelled';
  return current === 'draft' ? 'ordered' : current;
};

async function gmailJson(accessToken, path) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gmail request failed (${response.status})`);
  return data;
}

async function connectionOrders(organizationId) {
  const columns = 'id,organization_id,source_retailer,retailer_order_number,status,tracking_number,carrier,tracking_status,expected_delivery_at';
  const response = await fetch(`${config.supabaseUrl}/rest/v1/purchase_orders?select=${columns}&organization_id=eq.${organizationId}&retailer_order_number=not.is.null&status=not.in.(delivered,cancelled,returned)&order=ordered_at.desc&limit=100`, { headers: serviceHeaders() });
  const rows = await response.json().catch(() => []);
  if (!response.ok) throw new Error(rows.message || 'Could not load orders for Gmail matching');
  return rows;
}

async function saveEmailUpdate(order, text, update, messageId) {
  const now = new Date().toISOString();
  const stage = { unknown: 0, pre_transit: 1, in_transit: 2, available_for_pickup: 2, out_for_delivery: 3, delivered: 4 };
  const currentStatus = order.tracking_status || 'unknown';
  const nextStatus = update.status === 'unknown' || (stage[update.status] ?? 0) < (stage[currentStatus] ?? 0)
    ? currentStatus : update.status;
  const payload = {
    ...(update.trackingNumber && !order.tracking_number ? { tracking_number: update.trackingNumber } : {}),
    ...(update.carrier && !order.carrier ? { carrier: update.carrier } : {}),
    ...(update.expectedDeliveryAt ? { expected_delivery_at: update.expectedDeliveryAt } : {}),
    tracking_provider: 'gmail',
    tracking_status: nextStatus,
    tracking_status_detail: `Matched shipping email from ${text.from || 'retailer'}`,
    tracking_last_event: text.subject.slice(0, 500) || `Shipping update from ${order.source_retailer}`,
    tracking_last_checked_at: now,
    tracking_updated_at: now,
    tracking_events: [{ datetime: text.date || now, message: text.subject, source: 'gmail', messageId }],
    status: orderStatus(nextStatus, order.status),
  };
  const response = await fetch(`${config.supabaseUrl}/rest/v1/purchase_orders?id=eq.${order.id}&organization_id=eq.${order.organization_id}`, {
    method: 'PATCH', headers: serviceHeaders(), body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Could not save the email shipment update');
  return nextStatus;
}

async function processConnection(connection) {
  const accessToken = await gmailAccessToken(connection);
  const orders = await connectionOrders(connection.organization_id);
  if (!orders.length) return { connectionId: connection.id, messages: 0, updated: 0 };
  const after = connection.last_checked_at
    ? Math.max(0, Math.floor(new Date(connection.last_checked_at).getTime() / 1000) - 3600)
    : Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const query = encodeURIComponent(`after:${after} {subject:shipped subject:shipping subject:delivered subject:delivery subject:tracking subject:"on the way" "tracking number"}`);
  const listing = await gmailJson(accessToken, `/messages?q=${query}&maxResults=100`);
  const refs = listing.messages || [];
  const messages = [];
  for (let index = 0; index < refs.length; index += 10) {
    const batch = await Promise.all(refs.slice(index, index + 10).map(async (ref) => ({
      id: ref.id,
      data: await gmailJson(accessToken, `/messages/${encodeURIComponent(ref.id)}?format=full`),
    })));
    messages.push(...batch);
  }
  messages.sort((left, right) => Number(left.data.internalDate || 0) - Number(right.data.internalDate || 0));
  let updated = 0;
  for (const message of messages) {
    const text = messageText(message.data);
    for (const order of orders) {
      if (!emailContainsOrder(text, order.retailer_order_number)) continue;
      const update = extractShipmentUpdate(text);
      if (update.status === 'unknown' && !update.trackingNumber && !update.expectedDeliveryAt) continue;
      const savedStatus = await saveEmailUpdate(order, text, update, message.id);
      Object.assign(order, {
        tracking_number: order.tracking_number || update.trackingNumber,
        carrier: order.carrier || update.carrier,
        tracking_status: savedStatus,
        expected_delivery_at: update.expectedDeliveryAt || order.expected_delivery_at,
      });
      updated += 1;
    }
  }
  await fetch(`${config.supabaseUrl}/rest/v1/gmail_connections?id=eq.${connection.id}`, {
    method: 'PATCH', headers: serviceHeaders(), body: JSON.stringify({ last_checked_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }),
  });
  return { connectionId: connection.id, messages: messages.length, updated };
}

export async function refreshOrdersFromGmail() {
  if (!config.googleGmailClientId || !config.googleGmailClientSecret || !config.gmailTokenEncryptionKey) {
    return { configured: false, checkedConnections: 0, messages: 0, updated: 0, errors: [] };
  }
  const response = await fetch(`${config.supabaseUrl}/rest/v1/gmail_connections?select=*&is_active=eq.true&order=last_checked_at.asc.nullsfirst&limit=25`, { headers: serviceHeaders() });
  const connections = await response.json().catch(() => []);
  if (!response.ok) throw new Error(connections.message || 'Could not load Gmail connections');
  const results = [];
  for (const connection of connections) {
    try {
      results.push(await processConnection(connection));
    } catch (error) {
      results.push({ connectionId: connection.id, error: error.message });
      await fetch(`${config.supabaseUrl}/rest/v1/gmail_connections?id=eq.${connection.id}`, {
        method: 'PATCH', headers: serviceHeaders(), body: JSON.stringify({ last_error: error.message.slice(0, 500), updated_at: new Date().toISOString() }),
      }).catch(() => {});
    }
  }
  return {
    configured: true,
    checkedConnections: connections.length,
    messages: results.reduce((sum, item) => sum + Number(item.messages || 0), 0),
    updated: results.reduce((sum, item) => sum + Number(item.updated || 0), 0),
    errors: results.filter((item) => item.error),
  };
}
