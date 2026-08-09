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
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]);

const api = async (path) => {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${secret}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
};

const formatDate = (value) => value ? new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(value)) : 'Unknown time';

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
      return `<div class="identity-row">
        <div><b>Walmart</b><span>${escapeHtml(walmart.title || item.title)}</span><small>UPC ${escapeHtml(walmart.upc || 'not established')} · Variant ${escapeHtml(walmart.variantId || 'unknown')}</small></div>
        <div><b>Amazon comparison</b><span>${escapeHtml(amazon.amazonTitle || 'No exact coded listing')}</span><small>${escapeHtml(amazon.asin || 'No ASIN')} · ${escapeHtml(rejectionLabels[item.reason] || item.reason)}</small></div>
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
      ${run.sourcing ? `<div class="metric-detail">Discovery pool: up to ${Number(run.sourcing.discoveryPoolLimit || 0)} · ${Number(run.sourcing.notSelectedAfterLimit || 0)} fresh candidates held for a future run</div>` : ''}
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

async function loadStudentPortal() {
  const response = await fetch('/api/student');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Please sign in');
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
    : 'Your Discord destination is not configured yet. Contact the Syndicate team.';
  $('#webhookStatus').classList.toggle('ready', student.webhookConfigured);
  if (data.onboardingVideoUrl) {
    $('#onboardingVideo').src = data.onboardingVideoUrl;
    $('#onboardingVideo').classList.remove('hidden');
    $('#videoPlaceholder').classList.add('hidden');
  }
}

$('#studentTab').addEventListener('click', () => selectLoginTab(true));
$('#adminTab').addEventListener('click', () => selectLoginTab(false));

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
    const response = await fetch('/api/student', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minRoi: Number($('#minRoiInput').value),
        minMonthlySales: Number($('#minSalesInput').value),
        maxCost: Number($('#maxCostInput').value),
        excludedBrands: $('#excludedBrandsInput').value,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not save preferences');
    message.textContent = 'Preferences saved.';
  } catch (error) { message.textContent = error.message; }
});

$('#studentLogoutButton').addEventListener('click', async () => {
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

if (secret) loadDashboard().then(() => { refreshTimer = setInterval(loadDashboard, 30000); }).catch(lock);
else loadStudentPortal().catch(() => { lock(); selectLoginTab(true); });
