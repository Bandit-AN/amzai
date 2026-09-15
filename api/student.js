import {
  config,
  extractAmazonScreenshot,
  extractOrderScreenshot,
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

const allowExtensionOrigin = (request, response) => {
  const origin = String(request.headers.origin || '');
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  response.setHeader('Vary', 'Origin');
  return true;
};

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

async function supabaseJson(url, options, fallbackMessage) {
  const result = await fetch(url, options);
  const data = await result.json().catch(() => ({}));
  if (!result.ok) {
    const error = new Error(data.message || data.details || fallbackMessage);
    error.status = result.status;
    throw error;
  }
  return data;
}

const validUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
const cleanText = (value, limit = 500) => String(value || '').trim().slice(0, limit);
const cleanMoney = (value, fallback = null) => {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : fallback;
};
const cleanUrl = (value) => {
  const text = cleanText(value, 1000);
  if (!text) return null;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
};

async function captureSession(tableUrl, headers, membership, identity, id) {
  if (!validUuid(id)) throw new Error('Invalid capture session');
  const rows = await supabaseJson(
    `${tableUrl}?select=*&id=eq.${id}&organization_id=eq.${membership.organization_id}&created_by=eq.${identity.userId}&limit=1`,
    { headers },
    'Could not load the capture session',
  );
  if (!rows[0]) throw new Error('Capture session not found or expired');
  return rows[0];
}

async function handleOrderCapture(request, response, identity) {
  if (identity.type !== 'supabase') {
    return jsonResponse(response, 403, { error: 'Sign in with Google to capture orders' });
  }
  const token = bearerToken(request);
  const headers = supabaseHeaders(token);
  const membership = await organizationForUser(identity, token);
  const base = `${config.supabaseUrl}/rest/v1`;
  const sessionTable = `${base}/capture_sessions`;

  if (request.method === 'GET') {
    const orders = await supabaseJson(
      `${base}/purchase_orders?select=id,source_retailer,retailer_order_number,ordered_at,status,total,confirmed_at,purchase_order_items(id,product_title,quantity,unit_cost,asin,amazon_url)&organization_id=eq.${membership.organization_id}&order=created_at.desc&limit=10`,
      { headers },
      'Could not load recent captured orders',
    );
    return jsonResponse(response, 200, { ok: true, orders });
  }
  if (request.method !== 'POST') return jsonResponse(response, 405, { error: 'Method not allowed' });

  const body = await readJsonBody(request);
  const action = cleanText(body.action, 40);
  if (action === 'extract_source') {
    if (!config.geminiKey) throw new Error('Screenshot extraction is not configured');
    const source = await extractOrderScreenshot(body.imageData, body.pageUrl);
    const rows = await supabaseJson(sessionTable, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify([{
        organization_id: membership.organization_id,
        created_by: identity.userId,
        status: 'source_captured',
        source_page_url: cleanUrl(body.pageUrl),
        source_capture: source,
      }]),
    }, 'Could not create the capture session');
    return jsonResponse(response, 201, { ok: true, sessionId: rows[0].id, source });
  }

  if (action === 'extract_amazon') {
    if (!config.geminiKey) throw new Error('Screenshot extraction is not configured');
    const session = await captureSession(sessionTable, headers, membership, identity, body.sessionId);
    if (!['source_captured', 'amazon_linked'].includes(session.status)) throw new Error('This capture session is already closed');
    const amazon = await extractAmazonScreenshot(body.imageData, body.pageUrl);
    const rows = await supabaseJson(
      `${sessionTable}?id=eq.${session.id}&organization_id=eq.${membership.organization_id}`,
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'amazon_linked', amazon_page_url: cleanUrl(body.pageUrl), amazon_capture: amazon }),
      },
      'Could not attach the Amazon listing',
    );
    return jsonResponse(response, 200, { ok: true, sessionId: session.id, amazon, session: rows[0] });
  }

  if (action === 'confirm') {
    const session = await captureSession(sessionTable, headers, membership, identity, body.sessionId);
    if (session.status !== 'amazon_linked') throw new Error('Capture the retailer order and Amazon listing before confirming');
    const retailer = cleanText(body.retailer, 120);
    const orderNumber = cleanText(body.orderNumber, 120);
    const total = cleanMoney(body.total);
    const rawItems = Array.isArray(body.items) && body.items.length ? body.items.slice(0, 10) : [body];
    if (!retailer) throw new Error('Retailer is required');
    if (total === null) throw new Error('Order total is required');
    const submittedItems = rawItems.map((rawItem, index) => {
      const productTitle = cleanText(rawItem.productTitle);
      const asin = cleanText(rawItem.asin, 10).toUpperCase();
      const quantity = Number(rawItem.quantity);
      if (!productTitle) throw new Error(`Product ${index + 1} needs a title`);
      if (!/^B[A-Z0-9]{9}$/.test(asin)) throw new Error(`Product ${index + 1} needs a valid 10-character Amazon ASIN`);
      if (!(quantity > 0 && quantity <= 100000)) throw new Error(`Product ${index + 1} needs a quantity greater than zero`);
      const lineTotal = cleanMoney(rawItem.lineTotal);
      const unitCost = cleanMoney(
        rawItem.unitCost,
        lineTotal !== null ? lineTotal / quantity : (rawItems.length === 1 && total ? total / quantity : null),
      );
      if (rawItems.length > 1 && lineTotal === null && unitCost === null) {
        throw new Error(`Product ${index + 1} needs a line total or unit cost`);
      }
      return {
        productTitle,
        asin,
        quantity,
        unitCost,
        lineTotal: lineTotal ?? (unitCost !== null ? Math.round(unitCost * quantity * 100) / 100 : (rawItems.length === 1 ? total : null)),
        retailerSku: cleanText(rawItem.retailerSku, 120) || null,
        variant: cleanText(rawItem.variant, 200) || null,
        amazonUrl: cleanUrl(rawItem.amazonUrl) || `https://www.amazon.com/dp/${asin}`,
        amazonTitle: cleanText(rawItem.amazonTitle) || null,
        isBundle: rawItem.isBundle === true,
        extractionConfidence: Math.min(1, Math.max(0, Number(rawItem.extractionConfidence) || 0)),
      };
    });
    if (new Set(submittedItems.map((item) => item.asin)).size !== submittedItems.length) {
      throw new Error('Each product in an order must use a distinct ASIN');
    }
    const orderedAtDate = new Date(body.orderedAt || Date.now());
    if (Number.isNaN(orderedAtDate.getTime())) throw new Error('Order date is invalid');
    const lastFour = /^\d{4}$/.test(cleanText(body.cardLastFour, 4)) ? cleanText(body.cardLastFour, 4) : '';
    const cardIssuer = cleanText(body.cardIssuer, 80);
    let cardAlias = null;
    if (lastFour) {
      const existing = await supabaseJson(
        `${base}/payment_card_aliases?select=id,label,last_four,issuer&organization_id=eq.${membership.organization_id}&last_four=eq.${lastFour}&is_active=eq.true&limit=1`,
        { headers },
        'Could not load payment-card aliases',
      );
      cardAlias = existing[0] || null;
      if (!cardAlias) {
        const label = `${cardIssuer || 'Card'} •••• ${lastFour}`;
        const inserted = await supabaseJson(`${base}/payment_card_aliases`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify([{
            organization_id: membership.organization_id,
            created_by: identity.userId,
            label,
            last_four: lastFour,
            issuer: cardIssuer || null,
          }]),
        }, 'Could not save the card alias');
        cardAlias = inserted[0];
      }
    }
    const orderPayload = {
        organization_id: membership.organization_id,
        created_by: identity.userId,
        source_retailer: retailer,
        source_url: cleanUrl(body.sourceUrl),
        retailer_order_number: orderNumber || null,
        ordered_at: orderedAtDate.toISOString(),
        currency: 'USD',
        subtotal: cleanMoney(body.subtotal),
        tax: cleanMoney(body.tax, 0),
        shipping: cleanMoney(body.shipping, 0),
        discount: cleanMoney(body.discount, 0),
        total,
        card_alias_id: cardAlias?.id || null,
        receiving_location: cleanText(body.receivingLocation, 120) || 'House',
        notes: cleanText(body.notes, 2000) || null,
    };
    let order = null;
    if (orderNumber) {
      const existingOrders = await supabaseJson(
        `${base}/purchase_orders?select=*&organization_id=eq.${membership.organization_id}&retailer_order_number=eq.${encodeURIComponent(orderNumber)}&limit=10`,
        { headers },
        'Could not check for an existing purchase order',
      );
      order = existingOrders.find((candidate) => String(candidate.source_retailer || '').toLowerCase() === retailer.toLowerCase()) || null;
    }
    if (order) {
      const updatedRows = await supabaseJson(
        `${base}/purchase_orders?id=eq.${order.id}&organization_id=eq.${membership.organization_id}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify(orderPayload),
        },
        'Could not update the existing purchase order',
      );
      order = updatedRows[0] || order;
    } else {
      const orderRows = await supabaseJson(`${base}/purchase_orders`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify([{ ...orderPayload, status: 'draft' }]),
      }, 'Could not create the purchase order');
      order = orderRows[0];
    }
    const items = [];
    try {
      const existingItems = await supabaseJson(
        `${base}/purchase_order_items?select=*&organization_id=eq.${membership.organization_id}&purchase_order_id=eq.${order.id}`,
        { headers },
        'Could not check the existing purchase-order items',
      );
      for (const submittedItem of submittedItems) {
        const itemPayload = {
          organization_id: membership.organization_id,
          purchase_order_id: order.id,
          product_title: submittedItem.productTitle,
          retailer_sku: submittedItem.retailerSku,
          variant: submittedItem.variant,
          quantity: submittedItem.quantity,
          unit_cost: submittedItem.unitCost,
          line_total: submittedItem.lineTotal,
          asin: submittedItem.asin,
          amazon_url: submittedItem.amazonUrl,
          amazon_title: submittedItem.amazonTitle,
          is_bundle: submittedItem.isBundle,
          extraction_confidence: submittedItem.extractionConfidence,
        };
        const existingItem = existingItems.find((candidate) => candidate.asin === submittedItem.asin);
        if (existingItem) {
          const itemRows = await supabaseJson(
            `${base}/purchase_order_items?id=eq.${existingItem.id}&organization_id=eq.${membership.organization_id}`,
            {
              method: 'PATCH',
              headers: { ...headers, Prefer: 'return=representation' },
              body: JSON.stringify(itemPayload),
            },
            'Could not update an existing purchase-order item',
          );
          items.push(itemRows[0] || existingItem);
        } else {
          const itemRows = await supabaseJson(`${base}/purchase_order_items`, {
            method: 'POST',
            headers: { ...headers, Prefer: 'return=representation' },
            body: JSON.stringify([itemPayload]),
          }, 'Could not create a purchase-order item');
          items.push(itemRows[0]);
        }
      }
      const confirmedAt = new Date().toISOString();
      const confirmedRows = await supabaseJson(
        `${base}/purchase_orders?id=eq.${order.id}&organization_id=eq.${membership.organization_id}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({ status: 'ordered', confirmed_at: confirmedAt }),
        },
        'Could not confirm the purchase order',
      );
      Object.assign(order, confirmedRows[0]);
      await supabaseJson(
        `${sessionTable}?id=eq.${session.id}&organization_id=eq.${membership.organization_id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'confirmed', purchase_order_id: order.id }),
        },
        'Could not close the capture session',
      );
    } catch (error) {
      const confirmationError = new Error(`The order data was retained, but confirmation did not finish: ${error.message}`);
      confirmationError.status = error.status;
      throw confirmationError;
    }
    const connections = await supabaseJson(
      `${base}/google_sheet_connections?select=id,spreadsheet_id,spreadsheet_title,order_tracking_tab,expenses_tab&organization_id=eq.${membership.organization_id}&is_active=eq.true&order=updated_at.desc&limit=1`,
      { headers },
      'Could not load the Google Sheet connection',
    );
    const connection = connections[0] || null;
    let syncQueueError = null;
    if (connection) {
      try {
        await supabaseJson(`${base}/google_sheet_sync_records`, {
          method: 'POST',
          headers,
          body: JSON.stringify(items.flatMap((item) => ['Order Tracking', 'Automated Order Expenses'].map((targetTab) => ({
            organization_id: membership.organization_id,
            connection_id: connection.id,
            purchase_order_id: order.id,
            purchase_order_item_id: item.id,
            target_tab: targetTab,
            status: 'pending',
          })))),
        }, 'Could not queue the Google Sheet sync');
      } catch (error) {
        syncQueueError = cleanText(error.message, 500);
      }
    }
    return jsonResponse(response, 201, { ok: true, order, item: items[0], items, cardAlias, connection, syncQueueError });
  }

  if (action === 'sync_status') {
    const orderId = cleanText(body.orderId, 36);
    const connectionId = cleanText(body.connectionId, 36);
    if (!validUuid(orderId) || !validUuid(connectionId)) throw new Error('Invalid sync record');
    const status = body.status === 'synced' ? 'synced' : 'failed';
    for (const record of Array.isArray(body.records) ? body.records.slice(0, 20) : []) {
      const targetTab = ['Order Tracking', 'Automated Order Expenses'].includes(record.targetTab) ? record.targetTab : null;
      if (!targetTab) continue;
      const itemFilter = validUuid(record.itemId) ? `&purchase_order_item_id=eq.${record.itemId}` : '';
      await supabaseJson(
        `${base}/google_sheet_sync_records?organization_id=eq.${membership.organization_id}&connection_id=eq.${connectionId}&purchase_order_id=eq.${orderId}${itemFilter}&target_tab=eq.${encodeURIComponent(targetTab)}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            status,
            target_row: Number(record.targetRow) > 0 ? Math.floor(Number(record.targetRow)) : null,
            error_message: status === 'failed' ? cleanText(body.error, 500) : null,
            synced_at: status === 'synced' ? new Date().toISOString() : null,
          }),
        },
        'Could not update the Google Sheet sync status',
      );
    }
    return jsonResponse(response, 200, { ok: true, status });
  }

  return jsonResponse(response, 400, { error: 'Unknown capture action' });
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
  allowExtensionOrigin(request, response);
  if (request.method === 'OPTIONS') return response.status(204).end();
  const identity = await readPortalIdentity(request);
  if (!identity) return jsonResponse(response, 401, { error: 'Please sign in' });
  try {
    const student = identity.type === 'supabase'
      ? await fetchPortalStudentByEmail(identity.email)
      : await fetchPortalStudentById(identity.studentId);
    if (!student) return jsonResponse(response, 403, { error: 'This Google email is not an active Syndicate student' });
    if (request.query?.resource === 'sheet') {
      return await handleSheetConnection(request, response, identity);
    }
    if (request.query?.resource === 'capture') {
      return await handleOrderCapture(request, response, identity);
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
    const status = [401, 403, 409, 413].includes(Number(error.status)) ? Number(error.status) : 400;
    return jsonResponse(response, status, { ok: false, error: error.message });
  }
}
