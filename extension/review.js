const APP_ORIGIN = 'https://app.sellersyndicate.org';
const $ = (selector) => document.querySelector(selector);
let publicConfig = null;
let authSession = null;
let pendingCapture = null;
let workflow = { sessionId: '', source: null, amazon: null, sourcePageUrl: '', amazonPageUrl: '' };
let pendingSheetSync = null;

const setStatus = (message, error = false) => {
  const element = $('#statusMessage');
  element.textContent = message;
  element.classList.toggle('error', error);
};

const base64Url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function loadPublicConfig() {
  const response = await fetch(`${APP_ORIGIN}/api/auth`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.supabase) throw new Error('Buy Box Bandit login configuration is unavailable.');
  publicConfig = data;
  return data;
}

async function exchangePkceCode(code, verifier) {
  const response = await fetch(`${publicConfig.supabase.url}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: { apikey: publicConfig.supabase.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.msg || data.message || 'Could not complete Google sign-in.');
  return data;
}

async function signIn() {
  if (!publicConfig) await loadPublicConfig();
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = await sha256Base64Url(verifier);
  const redirectTo = chrome.identity.getRedirectURL('supabase');
  const authorize = new URL(`${publicConfig.supabase.url}/auth/v1/authorize`);
  authorize.searchParams.set('provider', 'google');
  authorize.searchParams.set('redirect_to', redirectTo);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 's256');
  authorize.searchParams.set('scopes', 'https://www.googleapis.com/auth/drive.file');
  authorize.searchParams.set('access_type', 'offline');
  authorize.searchParams.set('prompt', 'consent');
  const callbackUrl = await chrome.identity.launchWebAuthFlow({ url: authorize.toString(), interactive: true });
  if (!callbackUrl) throw new Error('Google sign-in was cancelled.');
  const callback = new URL(callbackUrl);
  const authError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  if (authError) throw new Error(authError);
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Google did not return an authorization code.');
  const session = await exchangePkceCode(code, verifier);
  authSession = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    provider_token: session.provider_token || '',
    expires_at: Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600),
    user: session.user || null,
  };
  await chrome.storage.local.set({ bbb_extension_session: authSession });
  await verifyMembership();
  renderAuth();
}

async function refreshSession() {
  if (!authSession?.refresh_token) return null;
  if (!publicConfig) await loadPublicConfig();
  const response = await fetch(`${publicConfig.supabase.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: publicConfig.supabase.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: authSession.refresh_token }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.msg || 'Your session expired. Sign in again.');
  authSession = {
    ...authSession,
    access_token: data.access_token,
    refresh_token: data.refresh_token || authSession.refresh_token,
    provider_token: data.provider_token || authSession.provider_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
    user: data.user || authSession.user,
  };
  await chrome.storage.local.set({ bbb_extension_session: authSession });
  return authSession;
}

async function validSession() {
  if (!authSession) return null;
  if (Number(authSession.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60) await refreshSession();
  return authSession;
}

async function api(path, options = {}, retry = true) {
  const session = await validSession();
  if (!session?.access_token) throw new Error('Sign in with Google first.');
  const response = await fetch(`${APP_ORIGIN}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${session.access_token}`, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && retry && session.refresh_token) {
    await refreshSession();
    return api(path, options, false);
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function verifyMembership() {
  await api('/api/student?resource=capture');
}

function renderAuth() {
  const signedIn = Boolean(authSession?.access_token);
  $('#signInView').classList.toggle('hidden', signedIn);
  $('#captureView').classList.toggle('hidden', !signedIn);
  $('#signedInLabel').textContent = authSession?.user?.email ? `Signed in as ${authSession.user.email}` : 'Signed in securely';
  $('#analyzeButton').disabled = !signedIn || !pendingCapture;
}

async function signOut() {
  if (authSession?.access_token && publicConfig?.supabase) {
    await fetch(`${publicConfig.supabase.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: publicConfig.supabase.anonKey, Authorization: `Bearer ${authSession.access_token}` },
    }).catch(() => {});
  }
  authSession = null;
  await chrome.storage.local.remove('bbb_extension_session');
  renderAuth();
}

async function compressCapture(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  let compressed = canvas.toDataURL('image/jpeg', 0.78);
  if (compressed.length > 3_200_000) compressed = canvas.toDataURL('image/jpeg', 0.58);
  if (compressed.length > 3_400_000) throw new Error('Capture is too large. Zoom in or crop the page before trying again.');
  return compressed;
}

function selectedKind() {
  return document.querySelector('input[name="captureKind"]:checked')?.value || 'source';
}

function selectKind(kind) {
  const radio = document.querySelector(`input[name="captureKind"][value="${kind}"]`);
  if (radio) radio.checked = true;
  $('#captureTypePill').textContent = kind === 'amazon' ? 'Amazon listing' : 'Retailer order';
  $('#captureTitle').textContent = kind === 'amazon' ? 'Review Amazon capture' : 'Review retailer capture';
}

function renderPendingCapture() {
  const hasCapture = Boolean(pendingCapture?.imageData);
  $('#emptyPreview').classList.toggle('hidden', hasCapture);
  $('#capturePreview').classList.toggle('hidden', !hasCapture);
  if (hasCapture) $('#capturePreview').src = pendingCapture.imageData;
  $('#pageTitle').textContent = pendingCapture?.pageTitle || 'No captured page';
  $('#pageUrl').textContent = pendingCapture?.pageUrl || 'Press Command+Shift+Y on a webpage';
  const nextKind = workflow.sessionId && workflow.source && !workflow.amazon ? 'amazon' : 'source';
  selectKind(nextKind);
  $('#analyzeButton').disabled = !authSession || !hasCapture;
}

const localDateTime = (value) => {
  const date = new Date(value || Date.now());
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Date(safe.getTime() - safe.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const setNumber = (selector, value) => { $(selector).value = Number.isFinite(Number(value)) ? Number(value) : ''; };

function renderReview() {
  const source = workflow.source;
  const amazon = workflow.amazon;
  if (!source) return;
  const item = source.items?.[0] || {};
  $('#reviewForm').classList.toggle('hidden', !amazon);
  $('#retailerInput').value = source.retailer || '';
  $('#orderNumberInput').value = source.orderNumber || '';
  $('#orderedAtInput').value = localDateTime(source.orderedAt);
  $('#productTitleInput').value = item.productTitle || '';
  $('#quantityInput').value = item.quantity || 1;
  setNumber('#totalInput', source.total ?? item.lineTotal);
  setNumber('#unitCostInput', item.unitCost);
  setNumber('#subtotalInput', source.subtotal);
  setNumber('#taxInput', source.tax);
  setNumber('#shippingInput', source.shipping);
  setNumber('#discountInput', source.discount);
  $('#cardIssuerInput').value = source.cardIssuer || '';
  $('#cardLastFourInput').value = source.cardLastFour || '';
  $('#bundleInput').value = item.isBundle ? 'true' : 'false';
  $('#asinInput').value = amazon?.asin || '';
  $('#amazonTitleInput').value = amazon?.amazonTitle || '';
  const confidence = [source.confidence, amazon?.confidence].filter((value) => Number.isFinite(Number(value)));
  $('#confidenceLabel').textContent = confidence.length ? `${Math.round(Math.min(...confidence) * 100)}% minimum confidence` : 'Review required';
}

async function analyzeCapture() {
  if (!pendingCapture) throw new Error('Capture a browser tab first.');
  const kind = selectedKind();
  const imageData = await compressCapture(pendingCapture.imageData);
  if (kind === 'source') {
    setStatus('Reading retailer, order number, products, units, totals, and card alias…');
    const result = await api('/api/student?resource=capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'extract_source', imageData, pageUrl: pendingCapture.pageUrl }),
    });
    workflow = {
      sessionId: result.sessionId, source: result.source, amazon: null,
      sourcePageUrl: pendingCapture.pageUrl, amazonPageUrl: '',
    };
    await chrome.storage.local.set({ bbb_capture_workflow: workflow });
    renderReview();
    selectKind('amazon');
    const extra = Math.max(0, (result.source.items?.length || 1) - 1);
    setStatus(extra
      ? `Retailer order read. This MVP will commit the first product; ${extra} additional item${extra === 1 ? '' : 's'} remain uncommitted.`
      : 'Retailer order read. Go to its exact Amazon listing and press the shortcut again.');
    return;
  }
  if (!workflow.sessionId || !workflow.source) throw new Error('Capture the retailer order before the Amazon listing.');
  setStatus('Reading the exact Amazon listing and ASIN…');
  const result = await api('/api/student?resource=capture', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'extract_amazon', sessionId: workflow.sessionId, imageData, pageUrl: pendingCapture.pageUrl }),
  });
  workflow.amazon = result.amazon;
  workflow.amazonPageUrl = pendingCapture.pageUrl;
  await chrome.storage.local.set({ bbb_capture_workflow: workflow });
  renderReview();
  setStatus('Amazon listing matched. Review and edit every field before committing.');
}

async function googleFetch(url, options = {}) {
  if (!authSession?.provider_token) throw new Error('Google Sheet permission expired. Sign out and reconnect Google.');
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${authSession.provider_token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Google Sheets request failed (${response.status})`);
  return data;
}

async function reportSheetSync(result, status, records, error = '') {
  return api('/api/student?resource=capture', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'sync_status', status, orderId: result.order.id, connectionId: result.connection.id, records, error }),
  });
}

async function syncOrder(result, reviewed) {
  const { connection, order, item, cardAlias } = result;
  if (!connection) throw new Error('No Google Sheet is connected to this account.');
  const root = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(connection.spreadsheet_id)}`;
  const metadata = await googleFetch(`${root}?fields=sheets.properties(sheetId,title,gridProperties(rowCount))`);
  const orderSheet = metadata.sheets?.find((sheet) => sheet.properties?.title === connection.order_tracking_tab);
  const expenseSheet = metadata.sheets?.find((sheet) => sheet.properties?.title === connection.expenses_tab);
  if (!orderSheet || !expenseSheet) throw new Error('The connected workbook tabs changed. Reconnect the correct workbook.');
  const orderTab = `'${connection.order_tracking_tab.replaceAll("'", "''")}'`;
  const marker = `[BBB:${order.id}]`;
  const notesColumn = await googleFetch(`${root}/values/${encodeURIComponent(`${orderTab}!N2:N`)}`);
  const existingOffset = (notesColumn.values || []).findIndex((row) => String(row?.[0] || '').includes(marker));
  const orderColumn = existingOffset >= 0 ? null : await googleFetch(`${root}/values/${encodeURIComponent(`${orderTab}!A2:A`)}`);
  const targetRow = existingOffset >= 0 ? existingOffset + 2 : 2 + (orderColumn.values?.length || 0);
  const requests = [];
  const rowCount = Number(orderSheet.properties.gridProperties?.rowCount || 0);
  if (targetRow > rowCount) requests.push({ appendDimension: { sheetId: orderSheet.properties.sheetId, dimension: 'ROWS', length: Math.max(50, targetRow - rowCount) } });
  if (existingOffset < 0 && targetRow > 2) requests.push({
    copyPaste: {
      source: { sheetId: orderSheet.properties.sheetId, startRowIndex: targetRow - 2, endRowIndex: targetRow - 1, startColumnIndex: 0, endColumnIndex: 15 },
      destination: { sheetId: orderSheet.properties.sheetId, startRowIndex: targetRow - 1, endRowIndex: targetRow, startColumnIndex: 0, endColumnIndex: 15 },
      pasteType: 'PASTE_NORMAL', pasteOrientation: 'NORMAL',
    },
  });
  if (requests.length) await googleFetch(`${root}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  const notes = [reviewed.notes, reviewed.sourceUrl ? `Source: ${reviewed.sourceUrl}` : '', marker].filter(Boolean).join(' · ');
  const values = [[
    new Date(order.ordered_at).toLocaleDateString('en-US'), order.source_retailer, item.product_title,
    'NOT ADDED', item.asin, order.retailer_order_number || '', order.receiving_location || 'House',
    'Unshipped', '', item.is_bundle ? 'Y' : 'N', Number(order.total), Number(item.quantity),
    `=K${targetRow}/L${targetRow}`, notes, 'N',
  ]];
  await googleFetch(`${root}/values/${encodeURIComponent(`${orderTab}!A${targetRow}:O${targetRow}`)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT', body: JSON.stringify({ range: `${orderTab}!A${targetRow}:O${targetRow}`, majorDimension: 'ROWS', values }),
  });
  const expensesRow = targetRow + 3;
  const expensesTab = `'${connection.expenses_tab.replaceAll("'", "''")}'`;
  await googleFetch(`${root}/values/${encodeURIComponent(`${expensesTab}!E${expensesRow}`)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT', body: JSON.stringify({ range: `${expensesTab}!E${expensesRow}`, majorDimension: 'ROWS', values: [[cardAlias?.label || 'Other']] }),
  });
  const records = [{ targetTab: 'Order Tracking', targetRow }, { targetTab: 'Automated Order Expenses', targetRow: expensesRow }];
  await reportSheetSync(result, 'synced', records);
  return targetRow;
}

function reviewedPayload() {
  const item = workflow.source?.items?.[0] || {};
  return {
    action: 'confirm', sessionId: workflow.sessionId,
    retailer: $('#retailerInput').value, orderNumber: $('#orderNumberInput').value,
    orderedAt: $('#orderedAtInput').value, receivingLocation: $('#locationInput').value,
    productTitle: $('#productTitleInput').value, quantity: Number($('#quantityInput').value),
    total: Number($('#totalInput').value), unitCost: $('#unitCostInput').value,
    subtotal: $('#subtotalInput').value, tax: $('#taxInput').value,
    shipping: $('#shippingInput').value, discount: $('#discountInput').value,
    cardIssuer: $('#cardIssuerInput').value, cardLastFour: $('#cardLastFourInput').value,
    asin: $('#asinInput').value, amazonTitle: $('#amazonTitleInput').value,
    amazonUrl: workflow.amazonPageUrl || workflow.amazon?.amazonUrl,
    sourceUrl: workflow.sourcePageUrl || workflow.source?.sourceUrl,
    retailerSku: item.retailerSku, variant: item.variant || workflow.amazon?.variant,
    lineTotal: item.lineTotal, isBundle: $('#bundleInput').value === 'true',
    extractionConfidence: Math.min(workflow.source?.confidence || 0, workflow.amazon?.confidence || 0),
    notes: $('#notesInput').value,
  };
}

async function commitOrder(event) {
  event.preventDefault();
  const button = $('#commitButton');
  button.disabled = true;
  if (pendingSheetSync) {
    try {
      setStatus('Retrying Google Sheet sync…');
      const row = await syncOrder(pendingSheetSync.result, pendingSheetSync.reviewed);
      pendingSheetSync = null;
      await chrome.storage.local.remove('bbb_pending_sheet_sync');
      button.textContent = 'Saved';
      setStatus(`Order committed and synced to Order Tracking row ${row}.`);
    } catch (error) { setStatus(`Order is safe in Supabase, but Sheet sync still needs attention: ${error.message}`, true); button.disabled = false; }
    return;
  }
  let result;
  const reviewed = reviewedPayload();
  try {
    setStatus('Saving confirmed order to your private Supabase ledger…');
    result = await api('/api/student?resource=capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewed),
    });
    setStatus('Order saved. Syncing the reviewed row to Google Sheets…');
    const row = await syncOrder(result, reviewed);
    button.textContent = 'Saved';
    setStatus(`Order committed and synced to Order Tracking row ${row}.`);
    workflow = { sessionId: '', source: null, amazon: null, sourcePageUrl: '', amazonPageUrl: '' };
    await chrome.storage.local.remove(['bbb_capture_workflow', 'bbb_pending_capture']);
  } catch (error) {
    if (result?.connection) {
      await reportSheetSync(result, 'failed', [{ targetTab: 'Order Tracking' }, { targetTab: 'Automated Order Expenses' }], error.message).catch(() => {});
    }
    if (result) {
      pendingSheetSync = { result, reviewed };
      await chrome.storage.local.set({ bbb_pending_sheet_sync: pendingSheetSync });
      button.textContent = 'Retry Google Sheet sync';
      setStatus(`Order is safe in Supabase, but Sheet sync needs attention: ${error.message}`, true);
    } else {
      setStatus(error.message, true);
    }
    button.disabled = false;
  }
}

async function resetWorkflow() {
  workflow = { sessionId: '', source: null, amazon: null, sourcePageUrl: '', amazonPageUrl: '' };
  pendingCapture = null;
  pendingSheetSync = null;
  await chrome.storage.local.remove(['bbb_capture_workflow', 'bbb_pending_capture', 'bbb_pending_sheet_sync', 'bbb_capture_error']);
  $('#reviewForm').classList.add('hidden');
  setStatus('Workflow cleared. Press the shortcut on a retailer order page.');
  renderPendingCapture();
}

async function loadState() {
  $('#redirectUrl').textContent = chrome.identity.getRedirectURL('supabase');
  const stored = await chrome.storage.local.get([
    'bbb_extension_session', 'bbb_pending_capture', 'bbb_capture_workflow', 'bbb_pending_sheet_sync', 'bbb_capture_error',
  ]);
  authSession = stored.bbb_extension_session || null;
  pendingCapture = stored.bbb_pending_capture || null;
  workflow = stored.bbb_capture_workflow || workflow;
  pendingSheetSync = stored.bbb_pending_sheet_sync || null;
  if (stored.bbb_capture_error) {
    setStatus(stored.bbb_capture_error, true);
    await chrome.storage.local.remove('bbb_capture_error');
  }
  await loadPublicConfig();
  if (authSession) {
    try { await verifyMembership(); }
    catch { authSession = null; await chrome.storage.local.remove('bbb_extension_session'); }
  }
  renderAuth();
  renderPendingCapture();
  renderReview();
  if (pendingSheetSync) {
    $('#reviewForm').classList.remove('hidden');
    $('#commitButton').textContent = 'Retry Google Sheet sync';
  }
}

$('#signInButton').addEventListener('click', async () => {
  $('#signInButton').disabled = true;
  try { await signIn(); setStatus('Signed in. Capture a retailer order page.'); }
  catch (error) { setStatus(error.message, true); }
  finally { $('#signInButton').disabled = false; }
});
$('#signOutButton').addEventListener('click', () => signOut().catch((error) => setStatus(error.message, true)));
$('#copyRedirectButton').addEventListener('click', async () => {
  await navigator.clipboard.writeText(chrome.identity.getRedirectURL('supabase'));
  $('#copyRedirectButton').textContent = 'Copied';
});
$('#resetButton').addEventListener('click', () => resetWorkflow().catch((error) => setStatus(error.message, true)));
$('#analyzeButton').addEventListener('click', async () => {
  $('#analyzeButton').disabled = true;
  try { await analyzeCapture(); }
  catch (error) { setStatus(error.message, true); }
  finally { $('#analyzeButton').disabled = !pendingCapture; }
});
document.querySelectorAll('input[name="captureKind"]').forEach((radio) => radio.addEventListener('change', () => selectKind(selectedKind())));
$('#reviewForm').addEventListener('submit', commitOrder);
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'capture-ready') return;
  chrome.storage.local.get('bbb_pending_capture').then((stored) => {
    pendingCapture = stored.bbb_pending_capture || null;
    renderPendingCapture();
    setStatus('New screenshot captured. Review it before analyzing.');
  });
});

loadState().catch((error) => setStatus(error.message, true));
