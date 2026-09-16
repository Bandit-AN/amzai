const $ = (selector) => document.querySelector(selector);
const loginView = $('#loginView');
const dashboardView = $('#dashboardView');
const adminLoginForm = $('#adminLoginForm');
const studentLoginForm = $('#studentLoginForm');
const studentView = $('#studentView');
const secretInput = $('#secretInput');
const loginError = $('#loginError');
const refreshButton = $('#refreshButton');
const runButton = $('#runButton');
const lockButton = $('#lockButton');
const notice = $('#notice');
let secret = sessionStorage.getItem('amzai_admin_secret') || '';
let refreshTimer;
let supabaseClient = null;
let supabaseAccessToken = '';
let googleProviderToken = '';
let portalConfig = {};
let sheetConnection = null;
let captureSessionId = '';
let captureDraft = { source: null, amazon: null };
let pendingSheetSync = null;
let trackedOrders = [];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]);

const api = async (path) => {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${secret}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
};

const studentApi = async (path, options = {}) => {
  const headers = { ...(options.headers || {}) };
  if (supabaseAccessToken) headers.Authorization = `Bearer ${supabaseAccessToken}`;
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
};

const formatDate = (value) => value ? new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(value)) : 'Unknown time';

const formatDay = (value) => value ? new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
}).format(new Date(value)) : 'Not available';

const trackingLabel = (status) => ({
  not_tracked: 'Needs tracking', unknown: 'Awaiting carrier', pre_transit: 'Label created',
  in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered',
  available_for_pickup: 'Ready for pickup', return_to_sender: 'Returning', failure: 'Exception',
  cancelled: 'Cancelled', error: 'Tracking error',
})[status] || String(status || 'Needs tracking').replaceAll('_', ' ');

function trackingStage(status) {
  if (status === 'delivered') return 3;
  if (status === 'out_for_delivery') return 2;
  if (['in_transit', 'available_for_pickup'].includes(status)) return 1;
  return 0;
}

function renderTrackedOrders() {
  const search = $('#orderSearchInput').value.trim().toLowerCase();
  const filter = $('#orderStatusFilter').value;
  const now = Date.now();
  const arrivingCutoff = now + (3 * 24 * 60 * 60 * 1000);
  const normalized = trackedOrders.map((order) => ({ ...order, tracking_status: order.tracking_status || 'not_tracked' }));
  $('#ordersAwaitingMetric').textContent = normalized.filter((order) => !order.tracking_number).length;
  $('#ordersTransitMetric').textContent = normalized.filter((order) => ['in_transit', 'out_for_delivery', 'available_for_pickup'].includes(order.tracking_status)).length;
  $('#ordersArrivingMetric').textContent = normalized.filter((order) => {
    const estimate = new Date(order.expected_delivery_at || '').getTime();
    return estimate >= now && estimate <= arrivingCutoff && order.tracking_status !== 'delivered';
  }).length;
  $('#ordersDeliveredMetric').textContent = normalized.filter((order) => order.tracking_status === 'delivered' || order.status === 'delivered').length;
  const filtered = normalized.filter((order) => {
    const haystack = [order.source_retailer, order.retailer_order_number, order.tracking_number,
      ...(order.purchase_order_items || []).flatMap((item) => [item.product_title, item.asin])].join(' ').toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (filter === 'needs_tracking') return !order.tracking_number;
    if (filter === 'in_transit') return ['pre_transit', 'in_transit', 'out_for_delivery', 'available_for_pickup'].includes(order.tracking_status);
    if (filter === 'delivered') return order.tracking_status === 'delivered' || order.status === 'delivered';
    if (filter === 'exception') return ['return_to_sender', 'failure', 'cancelled', 'error'].includes(order.tracking_status);
    return true;
  });
  if (!filtered.length) {
    $('#ordersList').innerHTML = '<div class="empty-state">No orders match this view.</div>';
    return;
  }
  $('#ordersList').innerHTML = filtered.map((order) => {
    const status = order.tracking_status || 'not_tracked';
    const stage = trackingStage(status);
    const items = order.purchase_order_items || [];
    const itemLines = items.map((item) => `<div class="order-item-line"><span>${escapeHtml(item.product_title)} · ${escapeHtml(item.asin || 'No ASIN')}</span><b>${Number(item.quantity || 0)} unit${Number(item.quantity) === 1 ? '' : 's'}</b></div>`).join('');
    const events = Array.isArray(order.tracking_events) ? order.tracking_events.slice(-3).reverse() : [];
    const latest = order.tracking_last_event || events[0]?.message || (order.tracking_number ? 'Waiting for the carrier’s first scan.' : 'Add the carrier tracking number when the retailer ships.');
    return `<article class="order-card">
      <div class="order-card-head">
        <div class="order-identity"><strong>${escapeHtml(order.source_retailer)}</strong><span>Order ${escapeHtml(order.retailer_order_number || 'number unavailable')} · ${formatDay(order.ordered_at)} · $${Number(order.total || 0).toFixed(2)}</span></div>
        <div class="order-shipment"><strong>${escapeHtml(latest)}</strong><span>${order.expected_delivery_at ? `Estimated ${formatDay(order.expected_delivery_at)}` : 'Estimated delivery unavailable'}${order.tracking_number ? ` · ${escapeHtml(order.carrier || 'Carrier')} ${escapeHtml(order.tracking_number)}` : ''}</span></div>
        <span class="tracking-status ${escapeHtml(status)}">${escapeHtml(trackingLabel(status))}</span>
      </div>
      <div class="shipment-timeline">${['Ordered','In transit','Out for delivery','Delivered'].map((label, index) => `<span class="shipment-step ${index <= stage ? 'complete' : ''}">${label}</span>`).join('')}</div>
      <div class="order-items">${itemLines || '<small>No product lines recorded.</small>'}</div>
      <form class="tracking-entry" data-order-tracking-form data-order-id="${escapeHtml(order.id)}">
        <input name="trackingNumber" value="${escapeHtml(order.tracking_number || '')}" placeholder="Carrier tracking number" required>
        <select name="carrier"><option value="">Auto-detect carrier</option>${['USPS','UPS','FedEx','DHLExpress','AmazonShipping','OnTrac','LaserShip'].map((carrier) => `<option ${order.carrier === carrier ? 'selected' : ''}>${carrier}</option>`).join('')}</select>
        <button class="primary-button" type="submit">${order.tracking_number ? 'Update tracking' : 'Start tracking'}</button>
      </form>
    </article>`;
  }).join('');
}

async function loadTrackedOrders() {
  const message = $('#ordersMessage');
  if (!supabaseAccessToken) {
    message.textContent = 'Sign in with Google to view your private order ledger.';
    return;
  }
  message.textContent = 'Loading orders…';
  try {
    const data = await studentApi('/api/student?resource=orders');
    trackedOrders = data.orders || [];
    $('#connectGmailButton').textContent = data.gmailConnection ? 'Shipping email connected' : 'Connect shipping email';
    $('#connectGmailButton').classList.toggle('ready', Boolean(data.gmailConnection));
    $('#trackingProviderNote').textContent = data.gmailConnection
      ? `Daily shipping-email checks are active for ${data.gmailConnection.google_email}.${data.gmailConnection.last_checked_at ? ` Last checked ${formatDate(data.gmailConnection.last_checked_at)}.` : ''}${data.gmailConnection.last_error ? ` Last error: ${data.gmailConnection.last_error}` : ''}`
      : (data.automaticTrackingConfigured
        ? 'Automatic carrier checks are active. Connect shipping email to discover tracking numbers automatically.'
        : 'Connect the inbox that receives retailer shipping confirmations. Only read-only Gmail access is requested.');
    $('#trackingProviderNote').classList.toggle('ready', data.automaticTrackingConfigured);
    message.textContent = '';
    renderTrackedOrders();
  } catch (error) {
    message.textContent = error.message;
  }
}

const showNotice = (message, error = false) => {
  notice.textContent = message;
  notice.classList.remove('hidden');
  notice.style.borderColor = error ? 'rgba(255,107,107,.3)' : '';
  notice.style.color = error ? '#ffaaaa' : '';
};

function renderRuns(runs) {
  const list = $('#runsList');
  if (!runs.length) {
    list.innerHTML = '<div class="empty-state">No indexed runs yet. The next run will appear here.</div>';
    $('#latestStatus').textContent = 'Ready';
    $('#latestDetail').textContent = 'Waiting for the next run';
    return;
  }
  const latest = runs[0];
  const statusLabels = {
    finalized: 'Complete', cancelled: 'Cancelled', awaiting_audit: 'Awaiting audit', analyzing: 'Analyzing',
  };
  $('#latestStatus').textContent = statusLabels[latest.status] || latest.status;
  $('#latestDetail').textContent = latest.outcome === 'legacy_run'
    ? `${latest.completedJobs}/${latest.totalJobs} checked · legacy matching`
    : `${latest.completedJobs}/${latest.totalJobs} checked · ${latest.qualifiedDeals} exact profitable match${latest.qualifiedDeals === 1 ? '' : 'es'}`;
  list.innerHTML = runs.map((run) => {
    const total = Math.max(1, Number(run.totalJobs || 0));
    const percent = Math.min(100, Math.round((Number(run.completedJobs || 0) / total) * 100));
    const deliveries = (run.delivery || []).filter((item) => item.delivered).length;
    const rejectionLabels = {
      no_amazon_match: 'no Amazon match', identity_mismatch: 'identity',
      product_code_mismatch: 'UPC/EAN', variant_mismatch: 'variant',
      product_type_mismatch: 'product type', exact_match_verification: 'exact identity check',
      buy_cost_over_limit: 'buy cost over $150',
      quantity_mismatch: 'quantity', blocked_brand: 'blocked brand',
      missing_amazon_price: 'missing price', price_spread: 'under spread',
      net_profit: 'net profit ≤ $1', missing_sales_velocity: 'missing sales',
      sales_velocity: 'under sales', missing_upc: 'missing UPC',
      unverified_variant: 'unverified variant', walmart_unavailable: 'Walmart unavailable',
      walmart_detail_unverified: 'detail identity unverified',
      walmart_detail_lookup_error: 'detail lookup error', other: 'other',
    };
    const outcomeLabels = {
      processing: 'Identity and economics checks are still running',
      profitable_products_found: 'Exact profitable products found',
      identity_not_established: 'Could not establish exact identity',
      exact_amazon_identity_not_established: 'Walmart UPCs were found, but no exact Amazon listing identity passed',
      no_profitable_products: 'Exact listing identities were found, but none passed every economics rule',
      legacy_run: 'Legacy title-matching run',
    };
    const rejectionSummary = Object.entries(run.rejectionCounts || {})
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} ${rejectionLabels[reason] || reason}`)
      .join(' · ');
    const funnel = run.funnel || {};
    const funnelItems = [
      ['Discovered', funnel.discovered], ['Initially eligible', funnel.initiallyEligible],
      ['Skipped: already seen', funnel.skippedRecentlyAnalyzed], ['Fresh candidates', funnel.freshCandidates],
      ['Details checked', funnel.detailPagesChecked], ['Walmart in stock', funnel.stockConfirmed],
      ['UPC confirmed', funnel.upcConfirmed], ['Amazon UPC result', funnel.amazonUpcMatchFound],
      ['Exact listing identity', funnel.exactAmazonMatchFound], ['Economics passed', funnel.economicsPassed],
      ['Auto-qualified', funnel.automaticallyQualified], ['Auto delivered', funnel.automaticallyDelivered],
      ['Manual review', funnel.manualReview],
    ];
    const comparisonRows = (run.rejectionDetails || []).slice(0, 12).map((item) => {
      const walmart = item.walmartIdentity || {};
      const amazon = item.comparisons?.[0] || {};
      const economics = Number.isFinite(Number(amazon.amazonPrice))
        ? ` · Amazon $${Number(amazon.amazonPrice).toFixed(2)} · ${Number(amazon.roi).toFixed(1)}% spread · $${Number(amazon.estimatedProfit).toFixed(2)} net · ${Math.round(Number(amazon.estimatedMonthlySales || 0)).toLocaleString('en-US')} sales`
        : '';
      return `<div class="identity-row">
        <div><b>Walmart${Number.isFinite(Number(walmart.currentPrice)) ? ` · $${Number(walmart.currentPrice).toFixed(2)}` : ''}</b><span>${escapeHtml(walmart.title || item.title)}</span><small>UPC ${escapeHtml(walmart.upc || 'not established')} · Variant ${escapeHtml(walmart.variantId || 'unknown')}</small></div>
        <div><b>Amazon comparison</b><span>${escapeHtml(amazon.amazonTitle || 'No exact coded listing')}</span><small>${escapeHtml(amazon.asin || 'No ASIN')} · ${escapeHtml(rejectionLabels[item.reason] || item.reason)}${escapeHtml(economics)}</small></div>
      </div>`;
    }).join('');
    const manualRows = (run.manualReview || []).slice(0, 12).map((item) => `<div class="review-row">
      <a href="${escapeHtml(item.walmartUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
      <small>${escapeHtml(rejectionLabels[item.reason] || item.reason)} · UPC ${escapeHtml(item.upc || 'missing')} · ${escapeHtml(item.seller || 'seller unknown')}</small>
    </div>`).join('');
    const auditRows = (run.qualifiedReview || []).map((item) => `<div class="identity-row qualified-row">
      <div><b>Walmart · $${Number(item.walmartPrice).toFixed(2)}</b><a href="${escapeHtml(item.walmartUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.walmartTitle)}</a><small>UPC ${escapeHtml(item.upc)} · Variant ${escapeHtml(item.variantId)}</small></div>
      <div><b>Amazon · $${Number(item.amazonPrice).toFixed(2)}</b><a href="${escapeHtml(item.amazonUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.amazonTitle)}</a><small>${Number(item.roi).toFixed(1)}% gross spread · $${Number(item.estimatedProfit).toFixed(2)} est. net · ${Math.round(Number(item.estimatedMonthlySales)).toLocaleString('en-US')} sales</small></div>
    </div>`).join('');
    const errorRows = (run.errorDetails || []).map((item) => `<div class="review-row">
      <span>${escapeHtml(item.title)}</span><small>Chunk ${escapeHtml(item.chunkIndex ?? 'unknown')} · ${escapeHtml(item.message)}</small>
    </div>`).join('');
    return `<div class="run-card">
      <div class="run-top"><div><div class="run-id">${escapeHtml(run.runId)}</div><span class="metric-detail">${formatDate(run.createdAt)}</span></div><span class="status ${['finalized','cancelled','awaiting_audit'].includes(run.status) ? run.status : ''}">${escapeHtml(run.status.replaceAll('_', ' '))}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
      <div class="run-stats"><span><b>${run.completedJobs}/${run.totalJobs}</b> analyzed</span><span><b>${run.qualifiedDeals}</b> qualified</span><span><b>${run.analysisErrors}</b> errors</span><span><b>${deliveries}</b> delivered</span></div>
      <div class="run-outcome">${escapeHtml(outcomeLabels[run.outcome] || run.outcome || 'Processing')}</div>
      <div class="funnel-grid">${funnelItems.map(([label, value]) => `<span><b>${value === null || value === undefined ? '—' : Number(value)}</b><small>${label}</small></span>`).join('')}</div>
      ${rejectionSummary ? `<div class="metric-detail">Rejected: ${escapeHtml(rejectionSummary)}</div>` : ''}
      ${run.sourcing ? `<div class="metric-detail">Sources: ${(run.sourcing.sourceUrls || []).length} · Discovery pool: up to ${Number(run.sourcing.discoveryPoolLimit || 0)} · ${Number(run.sourcing.excludedNoDealSignal || 0)} non-deals removed · ${Number(run.sourcing.excludedWalmartBrands || 0)} blocked-brand exclusions · ${Number(run.sourcing.excludedBuyCost || 0)} over buy-cost limit · ${Number(run.sourcing.notSelectedAfterLimit || 0)} fresh candidates held for a future run</div>` : ''}
      ${auditRows ? `<details class="run-details" ${run.auditMode ? 'open' : ''}><summary>${run.auditMode ? 'Audit exact qualified identities' : 'View qualified identities'} (${run.qualifiedReview.length})</summary>${auditRows}</details>` : ''}
      ${manualRows ? `<details class="run-details"><summary>Manual-review queue (${run.manualReview.length}${Number(funnel.manualReview) > run.manualReview.length ? '+' : ''})</summary>${manualRows}</details>` : ''}
      ${errorRows ? `<details class="run-details"><summary>Processing errors (${run.errorDetails.length})</summary>${errorRows}</details>` : ''}
      ${comparisonRows ? `<details class="run-details"><summary>Rejection identity comparisons</summary>${comparisonRows}</details>` : ''}
    </div>`;
  }).join('');
}

function renderStudents(students) {
  $('#studentCount').textContent = students.length;
  $('#studentsList').innerHTML = students.length ? students.map((student) => `<div class="student">
    <div class="avatar">${escapeHtml(String(student.name || '?').slice(0, 1).toUpperCase())}</div>
    <div class="student-info"><strong>${escapeHtml(student.name)}</strong><small>≥ ${escapeHtml(student.minRoi)}% gross spread · ≥ ${escapeHtml(student.minMonthlySales)} sales/mo</small></div>
    <span class="ready-dot" title="Discord configured"></span>
  </div>`).join('') : '<div class="empty-state">No active students</div>';
}

async function loadDashboard() {
  refreshButton.disabled = true;
  try {
    const data = await api('/api/admin');
    loginView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    lockButton.classList.remove('hidden');
    $('#keepaTokens').textContent = data.keepa.tokensLeft;
    $('#keepaDetail').textContent = `${data.keepa.refillRate} token/minute refill`;
    renderStudents(data.students || []);
    renderRuns(data.runs || []);
    loginError.textContent = '';
  } catch (error) {
    if (dashboardView.classList.contains('hidden')) loginError.textContent = error.message;
    else showNotice(error.message, true);
    if (/unauthorized/i.test(error.message)) lock();
    throw error;
  } finally { refreshButton.disabled = false; }
}

function lock() {
  secret = '';
  sessionStorage.removeItem('amzai_admin_secret');
  clearInterval(refreshTimer);
  dashboardView.classList.add('hidden');
  studentView.classList.add('hidden');
  loginView.classList.remove('hidden');
  lockButton.classList.add('hidden');
  secretInput.value = '';
}

const selectLoginTab = (studentMode) => {
  $('#studentTab').classList.toggle('active', studentMode);
  $('#adminTab').classList.toggle('active', !studentMode);
  studentLoginForm.classList.toggle('hidden', !studentMode);
  adminLoginForm.classList.toggle('hidden', studentMode);
};

function renderStorefronts(storefronts) {
  const list = $('#storefrontList');
  if (!supabaseAccessToken) {
    list.innerHTML = '<div class="empty-state">Sign in with Google to manage storefronts.</div>';
    return;
  }
  list.innerHTML = storefronts.length ? storefronts.map((item) => `<div class="storefront-row">
    <div><strong>${escapeHtml(item.label || item.seller_id)}</strong><small>${escapeHtml(item.seller_id)} · tracking new listings</small></div>
    <button class="remove-storefront" type="button" data-storefront-id="${escapeHtml(item.id)}">Remove</button>
  </div>`).join('') : '<div class="empty-state">No competitors tracked yet.</div>';
}

async function loadStorefronts() {
  if (!supabaseAccessToken) return renderStorefronts([]);
  const data = await studentApi('/api/storefronts');
  renderStorefronts(data.storefronts || []);
}

function renderSheetConnection(connection) {
  sheetConnection = connection || null;
  const badge = $('#sheetConnectionBadge');
  badge.textContent = connection ? 'Connected' : 'Not connected';
  badge.classList.toggle('ready', Boolean(connection));
  $('#sheetConnectionTitle').textContent = connection?.spreadsheet_title || 'No spreadsheet selected';
  $('#sheetConnectionDetail').textContent = connection
    ? `Order Tracking + Automated Order Expenses · connected ${formatDate(connection.updated_at)}`
    : 'Connect BeterAMZ MASTER to prepare order capture.';
  $('#connectSheetButton').textContent = sessionStorage.getItem('bbb_google_drive_ready') === 'true'
    ? 'Choose Google Sheet'
    : (connection ? 'Change Google Sheet' : 'Connect Google Sheet');
}

async function loadSheetConnection() {
  if (!supabaseAccessToken) return renderSheetConnection(null);
  const data = await studentApi('/api/student?resource=sheet');
  renderSheetConnection(data.connection);
}

async function authorizeGoogleSheetAccess() {
  sessionStorage.setItem('bbb_google_drive_pending', 'true');
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/`,
      scopes: 'https://www.googleapis.com/auth/drive.file',
      queryParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    },
  });
  if (error) throw error;
}

async function waitForGooglePicker() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (globalThis.gapi?.load) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!globalThis.gapi?.load) throw new Error('Google Picker did not load. Refresh the page and try again.');
  if (!globalThis.google?.picker) {
    await new Promise((resolve, reject) => globalThis.gapi.load('picker', {
      callback: resolve,
      onerror: () => reject(new Error('Google Picker could not be loaded.')),
      timeout: 5000,
      ontimeout: () => reject(new Error('Google Picker timed out. Refresh and try again.')),
    }));
  }
  if (!globalThis.google?.picker) throw new Error('Google Picker is unavailable. Refresh and try again.');
}

async function verifyAndSaveSpreadsheet(document) {
  const spreadsheetId = String(document.id || '').trim();
  const metadataResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`,
    { headers: { Authorization: `Bearer ${googleProviderToken}` } },
  );
  const metadata = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok) {
    sessionStorage.removeItem('bbb_google_drive_ready');
    throw new Error(metadata.error?.message || 'Google Sheet access expired. Connect Google again.');
  }
  const tabs = new Set((metadata.sheets || []).map((sheet) => sheet.properties?.title));
  const requiredTabs = ['Order Tracking', 'Automated Order Expenses', 'Backend'];
  const missingTabs = requiredTabs.filter((tab) => !tabs.has(tab));
  if (missingTabs.length) throw new Error(`That workbook is missing: ${missingTabs.join(', ')}`);
  const data = await studentApi('/api/student?resource=sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadsheetId,
      spreadsheetTitle: metadata.properties?.title || document.name || 'Google Sheet',
    }),
  });
  renderSheetConnection(data.connection);
  $('#sheetConnectionMessage').textContent = 'Spreadsheet connected. No order rows were changed.';
}

async function openGoogleSheetPicker() {
  await waitForGooglePicker();
  const { picker: pickerApi } = globalThis.google;
  const view = new pickerApi.DocsView(pickerApi.ViewId.SPREADSHEETS)
    .setIncludeFolders(false)
    .setSelectFolderEnabled(false);
  const picker = new pickerApi.PickerBuilder()
    .addView(view)
    .setOAuthToken(googleProviderToken)
    .setDeveloperKey(portalConfig.googlePicker.apiKey)
    .setAppId(portalConfig.googlePicker.projectNumber)
    .setOrigin(window.location.origin)
    .setCallback((data) => {
      if (data[pickerApi.Response.ACTION] !== pickerApi.Action.PICKED) return;
      const document = data[pickerApi.Response.DOCUMENTS]?.[0];
      if (!document) return;
      verifyAndSaveSpreadsheet(document).catch((error) => {
        $('#sheetConnectionMessage').textContent = error.message;
      });
    })
    .build();
  picker.setVisible(true);
}

const setCaptureMessage = (message, busy = false) => {
  $('#captureMessage').textContent = message;
  $('#captureStatusBadge').textContent = busy ? 'Working…' : 'Ready';
};

const fileToCompressedDataUrl = async (file) => {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG, or WebP screenshot.');
  if (file.size > 15_000_000) throw new Error('Screenshot is too large. Crop it and try again.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  let result = canvas.toDataURL('image/jpeg', 0.78);
  if (result.length > 3_200_000) result = canvas.toDataURL('image/jpeg', 0.58);
  if (result.length > 3_400_000) throw new Error('Screenshot is still too large. Crop it closer to the order details.');
  return result;
};

const localDateTimeValue = (value) => {
  const date = new Date(value || Date.now());
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const local = new Date(safe.getTime() - safe.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};

const setCaptureNumber = (selector, value) => {
  $(selector).value = Number.isFinite(Number(value)) ? Number(value) : '';
};

function renderSourceCapture(source) {
  const item = source.items?.[0] || {};
  $('#orderReviewForm').classList.remove('hidden');
  $('#captureRetailer').value = source.retailer || '';
  $('#captureOrderNumber').value = source.orderNumber || '';
  $('#captureOrderedAt').value = localDateTimeValue(source.orderedAt);
  $('#captureProductTitle').value = item.productTitle || '';
  $('#captureQuantity').value = item.quantity || 1;
  setCaptureNumber('#captureTotal', source.total ?? item.lineTotal);
  setCaptureNumber('#captureUnitCost', item.unitCost);
  setCaptureNumber('#captureSubtotal', source.subtotal);
  setCaptureNumber('#captureTax', source.tax);
  setCaptureNumber('#captureShipping', source.shipping);
  setCaptureNumber('#captureDiscount', source.discount);
  $('#captureCardIssuer').value = source.cardIssuer || '';
  $('#captureCardLastFour').value = source.cardLastFour || '';
  $('#captureBundle').value = item.isBundle ? 'true' : 'false';
  $('#captureConfidence').textContent = `${Math.round((source.confidence || 0) * 100)}% source confidence`;
}

function unlockAmazonCapture() {
  $('#amazonCaptureForm').classList.remove('capture-step-locked');
  $('#amazonCaptureForm').querySelectorAll('input,button').forEach((element) => { element.disabled = false; });
  $('#amazonFileName').textContent = 'No screenshot selected';
}

const googleSheetsFetch = async (url, options = {}) => {
  if (!googleProviderToken) throw new Error('Reconnect Google Sheet access before syncing.');
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${googleProviderToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Google Sheets request failed (${response.status})`);
  return data;
};

async function reportSheetSync(result, status, records, error = '') {
  return studentApi('/api/student?resource=capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'sync_status', status, orderId: result.order.id,
      connectionId: result.connection.id, records, error,
    }),
  });
}

async function syncConfirmedOrderToSheet(result, reviewed) {
  const { connection, order, item, cardAlias } = result;
  if (!connection) throw new Error('Order saved, but no Google Sheet is connected.');
  const spreadsheetId = connection.spreadsheet_id;
  const apiRoot = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const metadata = await googleSheetsFetch(`${apiRoot}?fields=sheets.properties(sheetId,title,gridProperties(rowCount))`);
  const orderSheet = metadata.sheets?.find((sheet) => sheet.properties?.title === connection.order_tracking_tab);
  const expensesSheet = metadata.sheets?.find((sheet) => sheet.properties?.title === connection.expenses_tab);
  if (!orderSheet || !expensesSheet) throw new Error('The connected workbook tabs changed. Reconnect the correct sheet.');
  const orderTab = `'${connection.order_tracking_tab.replaceAll("'", "''")}'`;
  const syncMarker = `[BBB:${order.id}]`;
  const notesColumn = await googleSheetsFetch(`${apiRoot}/values/${encodeURIComponent(`${orderTab}!N2:N`)}`);
  const existingOffset = (notesColumn.values || []).findIndex((row) => String(row?.[0] || '').includes(syncMarker));
  const orderColumn = existingOffset >= 0
    ? null
    : await googleSheetsFetch(`${apiRoot}/values/${encodeURIComponent(`${orderTab}!A2:A`)}`);
  const targetRow = existingOffset >= 0 ? existingOffset + 2 : 2 + (orderColumn.values?.length || 0);
  const rowCount = Number(orderSheet.properties.gridProperties?.rowCount || 0);
  const requests = [];
  if (targetRow > rowCount) {
    requests.push({ appendDimension: { sheetId: orderSheet.properties.sheetId, dimension: 'ROWS', length: Math.max(50, targetRow - rowCount) } });
  }
  if (existingOffset < 0 && targetRow > 2) {
    requests.push({
      copyPaste: {
        source: { sheetId: orderSheet.properties.sheetId, startRowIndex: targetRow - 2, endRowIndex: targetRow - 1, startColumnIndex: 0, endColumnIndex: 15 },
        destination: { sheetId: orderSheet.properties.sheetId, startRowIndex: targetRow - 1, endRowIndex: targetRow, startColumnIndex: 0, endColumnIndex: 15 },
        pasteType: 'PASTE_NORMAL',
        pasteOrientation: 'NORMAL',
      },
    });
  }
  if (requests.length) await googleSheetsFetch(`${apiRoot}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  const orderDate = new Date(order.ordered_at).toLocaleDateString('en-US');
  const notes = [reviewed.notes, reviewed.sourceUrl ? `Source: ${reviewed.sourceUrl}` : '', syncMarker].filter(Boolean).join(' · ');
  const rowValues = [[
    orderDate, order.source_retailer, item.product_title, 'NOT ADDED', item.asin,
    order.retailer_order_number || '', order.receiving_location || 'House', 'Unshipped', '',
    item.is_bundle ? 'Y' : 'N', Number(order.total), Number(item.quantity), `=K${targetRow}/L${targetRow}`,
    notes, 'N',
  ]];
  await googleSheetsFetch(`${apiRoot}/values/${encodeURIComponent(`${orderTab}!A${targetRow}:O${targetRow}`)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT', body: JSON.stringify({ range: `${orderTab}!A${targetRow}:O${targetRow}`, majorDimension: 'ROWS', values: rowValues }),
  });
  const expensesRow = targetRow + 3;
  const expensesTab = `'${connection.expenses_tab.replaceAll("'", "''")}'`;
  await googleSheetsFetch(`${apiRoot}/values/${encodeURIComponent(`${expensesTab}!E${expensesRow}`)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT', body: JSON.stringify({ range: `${expensesTab}!E${expensesRow}`, majorDimension: 'ROWS', values: [[cardAlias?.label || 'Other']] }),
  });
  const records = [
    { targetTab: 'Order Tracking', targetRow },
    { targetTab: 'Automated Order Expenses', targetRow: expensesRow },
  ];
  await reportSheetSync(result, 'synced', records);
  return { targetRow, expensesRow };
}

$('#sourceScreenshotInput').addEventListener('change', (event) => {
  $('#sourceFileName').textContent = event.target.files?.[0]?.name || 'No screenshot selected';
});

$('#amazonScreenshotInput').addEventListener('change', (event) => {
  $('#amazonFileName').textContent = event.target.files?.[0]?.name || 'No screenshot selected';
});

$('#sourceCaptureForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setCaptureMessage('Reading retailer, products, quantity, totals, and card alias…', true);
  try {
    if (!supabaseAccessToken) throw new Error('Sign in with Google to capture orders.');
    const imageData = await fileToCompressedDataUrl($('#sourceScreenshotInput').files?.[0]);
    const data = await studentApi('/api/student?resource=capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'extract_source', imageData, pageUrl: $('#sourcePageUrlInput').value }),
    });
    captureSessionId = data.sessionId;
    captureDraft = { source: data.source, amazon: null };
    pendingSheetSync = null;
    renderSourceCapture(data.source);
    $('#captureAsin').value = '';
    $('#captureAmazonTitle').value = '';
    $('#confirmCaptureButton').disabled = true;
    $('#confirmCaptureButton').textContent = 'Confirm and save order';
    unlockAmazonCapture();
    const extra = Math.max(0, (data.source.items?.length || 1) - 1);
    setCaptureMessage(extra ? `Order read. Review the first product; ${extra} additional item${extra === 1 ? '' : 's'} will be supported in the next multi-item update.` : 'Order read. Upload the matching Amazon listing next.');
  } catch (error) { setCaptureMessage(error.message); }
  finally { button.disabled = false; }
});

$('#amazonCaptureForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setCaptureMessage('Reading the exact Amazon listing and ASIN…', true);
  try {
    if (!captureSessionId) throw new Error('Capture the retailer order first.');
    const imageData = await fileToCompressedDataUrl($('#amazonScreenshotInput').files?.[0]);
    const data = await studentApi('/api/student?resource=capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'extract_amazon', sessionId: captureSessionId, imageData, pageUrl: $('#amazonPageUrlInput').value }),
    });
    captureDraft.amazon = data.amazon;
    $('#captureAsin').value = data.amazon.asin || '';
    $('#captureAmazonTitle').value = data.amazon.amazonTitle || '';
    $('#captureConfidence').textContent += ` · ${Math.round((data.amazon.confidence || 0) * 100)}% Amazon confidence`;
    $('#confirmCaptureButton').disabled = false;
    setCaptureMessage('Amazon listing matched. Review every field before confirming.');
  } catch (error) { setCaptureMessage(error.message); }
  finally { button.disabled = false; }
});

$('#orderReviewForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#confirmCaptureButton');
  button.disabled = true;
  if (pendingSheetSync) {
    setCaptureMessage('Retrying the Google Sheet sync…', true);
    try {
      const rows = await syncConfirmedOrderToSheet(pendingSheetSync.result, pendingSheetSync.reviewed);
      pendingSheetSync = null;
      button.textContent = 'Saved';
      $('#captureStatusBadge').textContent = 'Saved';
      $('#captureStatusBadge').classList.add('ready');
      $('#captureMessage').textContent = `Order saved and synced to Order Tracking row ${rows.targetRow}.`;
    } catch (error) {
      setCaptureMessage(`Order is safe in Supabase, but Sheet sync still needs attention: ${error.message}`);
      button.disabled = false;
    }
    return;
  }
  setCaptureMessage('Saving the confirmed order to your private ledger…', true);
  const item = captureDraft.source?.items?.[0] || {};
  const reviewed = {
    action: 'confirm', sessionId: captureSessionId,
    retailer: $('#captureRetailer').value, orderNumber: $('#captureOrderNumber').value,
    orderedAt: $('#captureOrderedAt').value, receivingLocation: $('#captureLocation').value,
    productTitle: $('#captureProductTitle').value, quantity: Number($('#captureQuantity').value),
    total: Number($('#captureTotal').value), unitCost: $('#captureUnitCost').value,
    subtotal: $('#captureSubtotal').value, tax: $('#captureTax').value,
    shipping: $('#captureShipping').value, discount: $('#captureDiscount').value,
    cardIssuer: $('#captureCardIssuer').value, cardLastFour: $('#captureCardLastFour').value,
    asin: $('#captureAsin').value, amazonTitle: $('#captureAmazonTitle').value,
    amazonUrl: $('#amazonPageUrlInput').value || captureDraft.amazon?.amazonUrl,
    sourceUrl: $('#sourcePageUrlInput').value || captureDraft.source?.sourceUrl,
    retailerSku: item.retailerSku, variant: item.variant || captureDraft.amazon?.variant,
    lineTotal: item.lineTotal, isBundle: $('#captureBundle').value === 'true',
    extractionConfidence: Math.min(captureDraft.source?.confidence || 0, captureDraft.amazon?.confidence || 0),
    notes: $('#captureNotes').value,
  };
  let result;
  try {
    result = await studentApi('/api/student?resource=capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewed),
    });
    setCaptureMessage('Order saved. Syncing it into your connected workbook…', true);
    const rows = await syncConfirmedOrderToSheet(result, reviewed);
    pendingSheetSync = null;
    button.textContent = 'Saved';
    $('#captureStatusBadge').textContent = 'Saved';
    $('#captureStatusBadge').classList.add('ready');
    $('#captureMessage').textContent = `Order saved and synced to Order Tracking row ${rows.targetRow}.`;
  } catch (error) {
    if (result?.connection) {
      await reportSheetSync(result, 'failed', [
        { targetTab: 'Order Tracking' }, { targetTab: 'Automated Order Expenses' },
      ], error.message).catch(() => {});
    }
    setCaptureMessage(result ? `Order saved to Supabase, but Sheet sync needs attention: ${error.message}` : error.message);
    if (result) {
      pendingSheetSync = { result, reviewed };
      button.textContent = 'Retry Google Sheet sync';
    }
    button.disabled = false;
  }
});

async function loadStudentPortal() {
  const data = await studentApi('/api/student');
  const student = data.student;
  loginView.classList.add('hidden');
  dashboardView.classList.add('hidden');
  studentView.classList.remove('hidden');
  lockButton.classList.add('hidden');
  $('#studentGreeting').textContent = `Welcome, ${student.name}.`;
  $('#minRoiInput').value = student.minRoi;
  $('#minSalesInput').value = student.minMonthlySales;
  $('#maxCostInput').value = student.maxCost;
  $('#excludedBrandsInput').value = (student.excludedBrands || []).join('\n');
  $('#webhookStatus').textContent = student.webhookConfigured
    ? '✓ Your private Discord destination is configured.'
    : 'Your Discord destination is not configured yet. Contact the Seller Syndicate team.';
  $('#webhookStatus').classList.toggle('ready', student.webhookConfigured);
  if (data.onboardingVideoUrl) {
    $('#onboardingVideo').src = data.onboardingVideoUrl;
    $('#onboardingVideo').classList.remove('hidden');
    $('#videoPlaceholder').classList.add('hidden');
  }
  await Promise.all([loadStorefronts(), loadSheetConnection()]);
}

$('#studentTab').addEventListener('click', () => selectLoginTab(true));
$('#adminTab').addEventListener('click', () => selectLoginTab(false));

$('#googleLoginButton').addEventListener('click', async () => {
  const errorElement = $('#studentLoginError');
  errorElement.textContent = '';
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/` },
  });
  if (error) errorElement.textContent = error.message;
});

studentLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorElement = $('#studentLoginError');
  errorElement.textContent = '';
  try {
    const response = await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#usernameInput').value.trim(), password: $('#passwordInput').value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Sign in failed');
    await loadStudentPortal();
  } catch (error) { errorElement.textContent = error.message; }
});

$('#preferencesForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#preferencesMessage');
  message.textContent = 'Saving…';
  try {
    const data = await studentApi('/api/student', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minRoi: Number($('#minRoiInput').value),
        minMonthlySales: Number($('#minSalesInput').value),
        maxCost: Number($('#maxCostInput').value),
        excludedBrands: $('#excludedBrandsInput').value,
      }),
    });
    message.textContent = 'Preferences saved.';
  } catch (error) { message.textContent = error.message; }
});

$('#storefrontForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#storefrontMessage');
  message.textContent = 'Adding…';
  try {
    if (!supabaseAccessToken) throw new Error('Sign in with Google to manage storefronts');
    await studentApi('/api/storefronts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sellerId: $('#storefrontSellerInput').value,
        label: $('#storefrontLabelInput').value,
      }),
    });
    event.currentTarget.reset();
    message.textContent = 'Storefront added. The first daily check creates its baseline.';
    await loadStorefronts();
  } catch (error) { message.textContent = error.message; }
});

$('#storefrontList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-storefront-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await studentApi('/api/storefronts', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: button.dataset.storefrontId }),
    });
    await loadStorefronts();
  } catch (error) { $('#storefrontMessage').textContent = error.message; button.disabled = false; }
});

$('#connectSheetButton').addEventListener('click', async () => {
  const status = $('#sheetConnectionMessage');
  status.textContent = '';
  try {
    if (!supabaseAccessToken || !supabaseClient) throw new Error('Sign in with Google first.');
    if (!portalConfig.googlePicker) throw new Error('Google Picker is not configured yet.');
    const permissionReady = sessionStorage.getItem('bbb_google_drive_ready') === 'true';
    if (!permissionReady || !googleProviderToken) {
      status.textContent = 'Opening Google permission screen…';
      await authorizeGoogleSheetAccess();
      return;
    }
    await openGoogleSheetPicker();
  } catch (error) {
    status.textContent = error.message;
  }
});

async function selectMemberTab(name) {
  document.querySelectorAll('[data-member-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.memberTab === name);
  });
  $('#memberOverviewPane').classList.toggle('hidden', name !== 'overview');
  $('#memberOrdersPane').classList.toggle('hidden', name !== 'orders');
  if (name === 'orders') await loadTrackedOrders();
}

document.querySelectorAll('[data-member-tab]').forEach((button) => {
  button.addEventListener('click', () => selectMemberTab(button.dataset.memberTab));
});
$('#refreshOrdersButton').addEventListener('click', () => loadTrackedOrders());
$('#connectGmailButton').addEventListener('click', async () => {
  const message = $('#ordersMessage');
  message.textContent = 'Opening Google permission screen…';
  try {
    const data = await studentApi('/api/student?resource=gmail');
    window.location.assign(data.authorizationUrl);
  } catch (error) {
    message.textContent = error.message;
  }
});
$('#orderSearchInput').addEventListener('input', renderTrackedOrders);
$('#orderStatusFilter').addEventListener('change', renderTrackedOrders);
$('#ordersList').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-order-tracking-form]');
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button');
  const message = $('#ordersMessage');
  button.disabled = true;
  message.textContent = 'Saving tracking number…';
  try {
    await studentApi('/api/student?resource=orders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: form.dataset.orderId,
        trackingNumber: form.elements.trackingNumber.value,
        carrier: form.elements.carrier.value,
      }),
    });
    message.textContent = 'Tracking saved. The daily carrier check will update its timeline.';
    await loadTrackedOrders();
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});

$('#studentLogoutButton').addEventListener('click', async () => {
  if (supabaseClient) await supabaseClient.auth.signOut().catch(() => {});
  supabaseAccessToken = '';
  googleProviderToken = '';
  sessionStorage.removeItem('bbb_google_drive_pending');
  sessionStorage.removeItem('bbb_google_drive_ready');
  await fetch('/api/auth', { method: 'DELETE' }).catch(() => {});
  studentView.classList.add('hidden'); loginView.classList.remove('hidden'); selectLoginTab(true);
});

adminLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  secret = secretInput.value.trim();
  sessionStorage.setItem('amzai_admin_secret', secret);
  try { await loadDashboard(); refreshTimer = setInterval(loadDashboard, 120000); }
  catch { sessionStorage.removeItem('amzai_admin_secret'); }
});
refreshButton.addEventListener('click', () => loadDashboard().catch(() => {}));
lockButton.addEventListener('click', lock);
runButton.addEventListener('click', async () => {
  if (!confirm('Start another sourcing run? This consumes scraper, Gemini, Keepa, and queue capacity.')) return;
  runButton.disabled = true;
  try {
    const data = await api('/api/cron');
    showNotice(`Run queued: ${data.candidates} candidates, about ${data.estimatedAnalysisMinutes} minutes.`);
    setTimeout(() => loadDashboard().catch(() => {}), 1200);
  } catch (error) { showNotice(error.message, true); }
  finally { runButton.disabled = false; }
});

async function initializePortal() {
  const query = new URLSearchParams(window.location.search);
  if (query.get('gmail') === 'connected') {
    sessionStorage.setItem('bbb_gmail_notice', 'Shipping email connected. Daily order updates are now active.');
    history.replaceState({}, '', '/');
  } else if (query.get('gmail') === 'error') {
    sessionStorage.setItem('bbb_gmail_notice', query.get('message') || 'Gmail connection failed.');
    history.replaceState({}, '', '/');
  }
  try {
    const response = await fetch('/api/auth');
    const publicConfig = await response.json();
    portalConfig = publicConfig;
    if (publicConfig.supabase && globalThis.supabase?.createClient) {
      supabaseClient = globalThis.supabase.createClient(publicConfig.supabase.url, publicConfig.supabase.anonKey);
      $('#googleLoginButton').disabled = false;
      const { data } = await supabaseClient.auth.getSession();
      supabaseAccessToken = data.session?.access_token || '';
      googleProviderToken = data.session?.provider_token || '';
      if (sessionStorage.getItem('bbb_google_drive_pending') === 'true' && googleProviderToken) {
        sessionStorage.removeItem('bbb_google_drive_pending');
        sessionStorage.setItem('bbb_google_drive_ready', 'true');
      }
      supabaseClient.auth.onAuthStateChange((_event, session) => {
        supabaseAccessToken = session?.access_token || '';
        googleProviderToken = session?.provider_token || '';
        if (sessionStorage.getItem('bbb_google_drive_pending') === 'true' && googleProviderToken) {
          sessionStorage.removeItem('bbb_google_drive_pending');
          sessionStorage.setItem('bbb_google_drive_ready', 'true');
        }
      });
    }
  } catch {}
  if (secret) return loadDashboard().then(() => { refreshTimer = setInterval(loadDashboard, 30000); }).catch(lock);
  return loadStudentPortal().then(() => {
    const gmailNotice = sessionStorage.getItem('bbb_gmail_notice');
    if (gmailNotice) {
      sessionStorage.removeItem('bbb_gmail_notice');
      selectMemberTab('orders');
      $('#ordersMessage').textContent = gmailNotice;
    }
  }).catch(() => { lock(); selectLoginTab(true); });
}

initializePortal();
