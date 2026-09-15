import { config, jsonResponse } from './platform.js';

const serviceHeaders = () => ({
  apikey: config.supabaseServiceRoleKey,
  Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  'Content-Type': 'application/json',
});

const easyPostHeaders = () => ({
  Authorization: `Basic ${Buffer.from(`${config.easyPostApiKey}:`).toString('base64')}`,
  'Content-Type': 'application/json',
});

const allowedStatuses = new Set([
  'unknown', 'pre_transit', 'in_transit', 'out_for_delivery', 'delivered',
  'available_for_pickup', 'return_to_sender', 'failure', 'cancelled', 'error',
]);

const orderStatusForTracking = (status, current) => {
  if (status === 'delivered') return 'delivered';
  if (status === 'return_to_sender') return 'returned';
  if (['in_transit', 'out_for_delivery', 'available_for_pickup'].includes(status)) return 'shipped';
  return current === 'draft' ? 'ordered' : current;
};

async function easyPost(path, options = {}) {
  const response = await fetch(`https://api.easypost.com/v2${path}`, {
    ...options,
    headers: { ...easyPostHeaders(), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `EasyPost request failed (${response.status})`);
  return data;
}

async function loadOrders() {
  const columns = [
    'id', 'organization_id', 'status', 'tracking_number', 'carrier', 'tracking_provider_id',
    'tracking_status', 'tracking_last_checked_at',
  ].join(',');
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/purchase_orders?select=${columns}&tracking_number=not.is.null&status=not.in.(delivered,cancelled,returned)&order=tracking_last_checked_at.asc.nullsfirst&limit=100`,
    { headers: serviceHeaders() },
  );
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(data.message || 'Could not load the shipment tracking queue');
  return data;
}

async function saveTracker(order, tracker) {
  const status = allowedStatuses.has(tracker.status) ? tracker.status : 'unknown';
  const details = Array.isArray(tracker.tracking_details) ? tracker.tracking_details.slice(-20) : [];
  const latest = details.at(-1);
  const expected = tracker.est_delivery_date || tracker.carrier_detail?.est_delivery_date_local || null;
  const payload = {
    tracking_provider: 'easypost',
    tracking_provider_id: tracker.id,
    tracking_status: status,
    tracking_status_detail: tracker.status_detail || null,
    tracking_last_event: latest?.message || latest?.description || null,
    tracking_last_checked_at: new Date().toISOString(),
    tracking_updated_at: tracker.updated_at || new Date().toISOString(),
    tracking_events: details,
    carrier: tracker.carrier || order.carrier || null,
    expected_delivery_at: expected,
    status: orderStatusForTracking(status, order.status),
  };
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/purchase_orders?id=eq.${order.id}&organization_id=eq.${order.organization_id}`,
    { method: 'PATCH', headers: serviceHeaders(), body: JSON.stringify(payload) },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Could not save shipment status');
  return { orderId: order.id, status, expectedDeliveryAt: expected };
}

async function refreshOrder(order) {
  const tracker = order.tracking_provider_id
    ? await easyPost(`/trackers/${encodeURIComponent(order.tracking_provider_id)}`)
    : await easyPost('/trackers', {
      method: 'POST',
      body: JSON.stringify({ tracker: {
        tracking_code: order.tracking_number,
        ...(order.carrier ? { carrier: order.carrier } : {}),
      } }),
    });
  return saveTracker(order, tracker);
}

export async function handleOrderTrackingCron(request, response) {
  const authorization = String(request.headers.authorization || '');
  if (!config.cronSecret || authorization !== `Bearer ${config.cronSecret}`) {
    return jsonResponse(response, 401, { ok: false, error: 'Unauthorized' });
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return jsonResponse(response, 503, { ok: false, error: 'Supabase order tracking is not configured' });
  }
  if (!config.easyPostApiKey) {
    return jsonResponse(response, 200, {
      ok: true, configured: false, checked: 0, message: 'Add EASYPOST_API_KEY to enable carrier updates',
    });
  }
  try {
    const orders = await loadOrders();
    const results = [];
    for (const order of orders) {
      try {
        results.push(await refreshOrder(order));
      } catch (error) {
        results.push({ orderId: order.id, error: error.message });
      }
    }
    return jsonResponse(response, 200, {
      ok: true,
      configured: true,
      checked: orders.length,
      updated: results.filter((item) => !item.error).length,
      errors: results.filter((item) => item.error),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'order_tracking_failed', message: error.message }));
    return jsonResponse(response, 500, { ok: false, error: error.message });
  }
}
