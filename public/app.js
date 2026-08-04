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
  $('#latestStatus').textContent = latest.status === 'finalized' ? 'Complete' : (latest.status === 'cancelled' ? 'Cancelled' : 'Analyzing');
  $('#latestDetail').textContent = `${latest.completedJobs}/${latest.totalJobs} jobs · ${latest.qualifiedDeals} qualified`;
  list.innerHTML = runs.map((run) => {
    const total = Math.max(1, Number(run.totalJobs || 0));
    const percent = Math.min(100, Math.round((Number(run.completedJobs || 0) / total) * 100));
    const deliveries = (run.delivery || []).filter((item) => item.delivered).length;
    const rejectionLabels = {
      no_amazon_match: 'no Amazon match', identity_mismatch: 'identity',
      product_code_mismatch: 'UPC/EAN', variant_mismatch: 'variant',
      product_type_mismatch: 'product type', excluded_fragrance: 'fragrance excluded',
      quantity_mismatch: 'quantity', blocked_brand: 'blocked brand',
      missing_amazon_price: 'missing price', price_spread: 'under spread',
      missing_sales_velocity: 'missing sales', sales_velocity: 'under sales', other: 'other',
    };
    const rejectionSummary = Object.entries(run.rejectionCounts || {})
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} ${rejectionLabels[reason] || reason}`)
      .join(' · ');
    return `<div class="run-card">
      <div class="run-top"><div><div class="run-id">${escapeHtml(run.runId)}</div><span class="metric-detail">${formatDate(run.createdAt)}</span></div><span class="status ${['finalized','cancelled'].includes(run.status) ? run.status : ''}">${escapeHtml(run.status)}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
      <div class="run-stats"><span><b>${run.completedJobs}/${run.totalJobs}</b> analyzed</span><span><b>${run.qualifiedDeals}</b> qualified</span><span><b>${run.analysisErrors}</b> errors</span><span><b>${deliveries}</b> delivered</span></div>
      ${rejectionSummary ? `<div class="metric-detail">Rejected: ${escapeHtml(rejectionSummary)}</div>` : ''}
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
