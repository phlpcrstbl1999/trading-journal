/* ============================================================
   Trading Journal — Multi-Account app.js
   Storage:
     tj_accounts          → array of account objects
     tj_trades_<id>       → array of trades per account
   ============================================================ */

// ── Storage ───────────────────────────────────────────────────
const ACC_KEY   = 'tj_accounts';
const tradeKey      = (id) => 'tj_trades_' + id;
const withdrawalKey = (id) => 'tj_withdrawals_' + id;
const loadWithdrawals = (id) => JSON.parse(localStorage.getItem(withdrawalKey(id)) || '[]');
const saveWithdrawals = (id, w) => localStorage.setItem(withdrawalKey(id), JSON.stringify(w));
const loadAccounts = () => JSON.parse(localStorage.getItem(ACC_KEY) || '[]');
const saveAccounts = (a) => localStorage.setItem(ACC_KEY, JSON.stringify(a));
const loadTrades   = (id) => JSON.parse(localStorage.getItem(tradeKey(id)) || '[]');
const saveTrades   = (id, t) => localStorage.setItem(tradeKey(id), JSON.stringify(t));

// ── State ─────────────────────────────────────────────────────
let accounts      = loadAccounts();
let activeAccId   = null;
let trades        = [];
let editId        = null;
let filterResult  = 'all';
let filterAsset   = '';
let sortField     = 'datetime';
let sortDir       = 'desc';
let clearConfirm  = false;
let withdrawals   = [];
let equityChart   = null;
let currentScreenshot = null;
let miniCharts    = {};
let currentOverviewTab = 'accounts';
let allFilterResult = 'all';
let allFilterAsset  = '';
let allFilterAccount = '';

// ── Helpers ───────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

const ASSETS_KEY = 'tj_assets';
const DEFAULT_ASSETS = [{ symbol: 'XAUUSD' }];

let _assetsCache = null;
function loadAssets() {
  if (_assetsCache) return _assetsCache;
  var stored = localStorage.getItem(ASSETS_KEY);
  if (!stored) { _assetsCache = DEFAULT_ASSETS.slice(); return _assetsCache; }
  var parsed = JSON.parse(stored);
  _assetsCache = parsed.map(function(a) {
    if (typeof a === 'string') return { symbol: a };
    return { symbol: a.symbol || a };
  });
  return _assetsCache;
}
function saveAssets(list) { _assetsCache = list; localStorage.setItem(ASSETS_KEY, JSON.stringify(list)); }

const getAsset = (ticker) => {
  return loadAssets().find(function(a) { return a.symbol === (ticker || '').toUpperCase(); }) || {};
};



const calcR = (t) => {
  if (!t.stopLoss || !+t.stopLoss) return null;
  const entry = +t.entryPrice, sl = +t.stopLoss;
  const risk  = Math.abs(entry - sl) * (+t.positionSize || 0);
  return risk > 0 ? parseFloat((t.pnl / risk).toFixed(2)) : null;
};

const fmtMoney = (n) => {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n >= 0 ? '+$' : '-$') + abs;
};

const fmtDate = (iso) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' });

const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

const accountStats = (tradeList) => {
  if (!tradeList.length) return { totalPnl: 0, winRate: 0, wins: 0, losses: 0, total: 0, best: 0, worst: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, maxDrawdown: 0, streak: 0, streakType: '' };
  const totalPnl   = tradeList.reduce((a, t) => a + t.pnl, 0);
  const winList    = tradeList.filter(t => t.pnl > 0);
  const lossList   = tradeList.filter(t => t.pnl <= 0);
  const best       = Math.max(...tradeList.map(t => t.pnl));
  const worst      = Math.min(...tradeList.map(t => t.pnl));
  const avgWin     = winList.length ? winList.reduce((a, t) => a + t.pnl, 0) / winList.length : 0;
  const avgLoss    = lossList.length ? Math.abs(lossList.reduce((a, t) => a + t.pnl, 0) / lossList.length) : 0;
  const grossProfit = winList.reduce((a, t) => a + t.pnl, 0);
  const grossLoss   = Math.abs(lossList.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? Infinity : 0;
  // avg R
  const rList = tradeList.map(t => calcR(t)).filter(r => r !== null);
  const avgR  = rList.length ? parseFloat((rList.reduce((a, r) => a + r, 0) / rList.length).toFixed(2)) : null;
  // max drawdown
  const sorted = tradeList.slice().sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  let peak = 0, cum = 0, maxDD = 0;
  sorted.forEach(t => { cum += t.pnl; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; });
  // current streak
  let streak = 0, streakType = '';
  for (let i = sorted.length - 1; i >= 0; i--) {
    const isWin = sorted[i].pnl > 0;
    if (streak === 0) { streakType = isWin ? 'W' : 'L'; streak = 1; }
    else if ((streakType === 'W') === isWin) streak++;
    else break;
  }
  return { totalPnl: parseFloat(totalPnl.toFixed(2)), winRate: parseFloat(((winList.length / tradeList.length) * 100).toFixed(1)), wins: winList.length, losses: lossList.length, total: tradeList.length, best, worst, avgWin: parseFloat(avgWin.toFixed(2)), avgLoss: parseFloat(avgLoss.toFixed(2)), profitFactor, avgR, maxDrawdown: parseFloat(maxDD.toFixed(2)), streak, streakType };
};

// ── Toast ────────────────────────────────────────────────────
function showToast(msg, type) {
  type = type || 'success';
  var t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(function() { t.classList.add('show'); });
  setTimeout(function() { t.classList.remove('show'); setTimeout(function() { t.remove(); }, 300); }, 2800);
}

// ── Assets ───────────────────────────────────────────────────
function populateAssetSelect(selected) {
  var list = loadAssets();
  var sel  = document.getElementById('fTicker');
  sel.innerHTML = list.map(function(a) {
    return '<option value="' + esc(a.symbol) + '"' + (a.symbol === selected ? ' selected' : '') + '>' +
      esc(a.symbol) +
    '</option>';
  }).join('');
}

var addAssetBackdrop = document.getElementById('addAssetModalBackdrop');
function openAddAssetModal(asset) {
  document.getElementById('addAssetModalTitle').textContent = asset ? 'Edit Asset' : 'Add Asset';
  document.getElementById('fNewAssetSymbol').value = asset ? asset.symbol : '';
  document.getElementById('fNewAssetSymbol').readOnly = !!asset;
  addAssetBackdrop.classList.remove('hidden');
  setTimeout(function() { document.getElementById('fNewAssetSymbol').focus(); }, 50);
}
function closeAddAssetModal() { document.getElementById('fNewAssetSymbol').readOnly = false; addAssetBackdrop.classList.add('hidden'); }
document.getElementById('btnCloseAddAssetModal').addEventListener('click', closeAddAssetModal);
document.getElementById('btnCancelAddAsset').addEventListener('click', closeAddAssetModal);
addAssetBackdrop.addEventListener('click', function(e) { if (e.target === addAssetBackdrop) closeAddAssetModal(); });
document.getElementById('btnSaveAddAsset').addEventListener('click', function() {
  var sym = document.getElementById('fNewAssetSymbol').value.trim().toUpperCase();
  if (!sym) { showToast('Please enter an asset symbol.', 'error'); return; }
  var list = loadAssets();
  var idx = list.findIndex(function(a) { return a.symbol === sym; });
  var asset = { symbol: sym };
  if (idx >= 0) list[idx] = asset; else list.push(asset);
  saveAssets(list);
  populateAssetSelect(sym);
  closeAddAssetModal();
});
document.getElementById('btnAddAsset').addEventListener('click', function() {
  var ticker = document.getElementById('fTicker').value;
  var existing = ticker ? getAsset(ticker) : null;
  openAddAssetModal(existing && existing.symbol ? existing : null);
});


// ── Screenshot helpers ────────────────────────────────────────
function setScreenshotPreview(src) {
  const area = document.getElementById('imgUploadArea');
  const wrap = document.getElementById('imgPreviewWrap');
  const prev = document.getElementById('imgPreview');
  if (src) { prev.src = src; wrap.style.display = 'block'; area.style.display = 'none'; }
  else { wrap.style.display = 'none'; area.style.display = 'block'; prev.src = ''; document.getElementById('fScreenshot').value = ''; }
}

document.getElementById('fScreenshot').addEventListener('change', (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  const r = new FileReader();
  r.onload = (ev) => { currentScreenshot = ev.target.result; setScreenshotPreview(currentScreenshot); };
  r.readAsDataURL(file);
});

document.getElementById('btnRemoveImg').addEventListener('click', () => { currentScreenshot = null; setScreenshotPreview(null); });

const uploadArea = document.getElementById('imgUploadArea');
uploadArea.addEventListener('dragover',  (e) => { e.preventDefault(); uploadArea.style.borderColor = 'var(--blue)'; });
uploadArea.addEventListener('dragleave', ()  => { uploadArea.style.borderColor = ''; });
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault(); uploadArea.style.borderColor = '';
  const file = e.dataTransfer.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  const r = new FileReader();
  r.onload = (ev) => { currentScreenshot = ev.target.result; setScreenshotPreview(currentScreenshot); };
  r.readAsDataURL(file);
});

// ── Custom Confirm Modal ─────────────────────────────────────
var _confirmCallback = null;
var confirmBackdrop = document.getElementById('confirmModalBackdrop');
function showConfirm(title, msg, onOk) {
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMsg').textContent = msg;
  _confirmCallback = onOk;
  confirmBackdrop.classList.remove('hidden');
}
function closeConfirm() { confirmBackdrop.classList.add('hidden'); _confirmCallback = null; }
document.getElementById('btnCloseConfirmModal').addEventListener('click', closeConfirm);
document.getElementById('btnConfirmCancel').addEventListener('click', closeConfirm);
confirmBackdrop.addEventListener('click', function(e) { if (e.target === confirmBackdrop) closeConfirm(); });
document.getElementById('btnConfirmOk').addEventListener('click', function() {
  if (_confirmCallback) _confirmCallback();
  closeConfirm();
});

// ── Lightbox ──────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}
document.getElementById('lightboxClose').addEventListener('click', () => document.getElementById('lightbox').classList.add('hidden'));
document.getElementById('lightbox').addEventListener('click', (e) => { if (e.target === document.getElementById('lightbox')) document.getElementById('lightbox').classList.add('hidden'); });

// ── Screen switching ──────────────────────────────────────────
let currentAccountTab = 'dashboard';

function switchAccountTab(tab) {
  currentAccountTab = tab;
  document.querySelectorAll('.acc-tab-panel').forEach(p => p.style.display = 'none');
  document.getElementById('tab-' + tab).style.display = 'block';
  document.querySelectorAll('[data-sidebar-acctab]').forEach(b => b.classList.toggle('active', b.dataset.acctab === tab));
  // also update desktop nav if present
  document.querySelectorAll('[data-accnavtab]').forEach(b => b.classList.toggle('active', b.dataset.accnavtab === tab));
  if (tab === 'dashboard') renderDashboard();
  else if (tab === 'trades') renderTrades();
  else if (tab === 'notes') renderNotes();
  else if (tab === 'withdrawals') renderWithdrawals();
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');

  const overviewNav = document.getElementById('overviewNav');
  const btnAdd      = document.getElementById('btnOpenForm');

  // Toggle sidebar panels
  document.getElementById('sidebarOverviewTabs').style.display = name === 'overview' ? 'flex' : 'none';
  document.getElementById('sidebarAccountTabs').style.display  = name === 'account'  ? 'flex' : 'none';
  document.getElementById('sidebarOverviewTabs').style.flexDirection = 'column';
  document.getElementById('sidebarAccountTabs').style.flexDirection  = 'column';

  if (name === 'overview') {
    activeAccId = null; trades = []; withdrawals = [];
    overviewNav.style.display = 'none';
    btnAdd.style.display = 'none';
    document.getElementById('btnLogWithdrawal').style.display = 'none';
    switchOverviewTab(currentOverviewTab);
  } else {
    var accObj   = accounts.find(a => a.id === activeAccId) || {};
    var accLabel = esc(accObj.name) + (accObj.step ? ' — ' + esc(accObj.step) : '');
    // Desktop nav for account
    overviewNav.innerHTML =
      '<button class="back-btn" id="btnBack">' +
      '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>' +
      'Accounts</button>' +
      '<span class="account-label" style="margin-left:8px">' + accLabel + '</span>' +
      '<div style="display:flex;gap:4px;margin-left:12px">' +
        ['dashboard','trades','notes','withdrawals'].map(t =>
          '<button class="tab-btn' + (t === currentAccountTab ? ' active' : '') + '" data-accnavtab="' + t + '">' +
          t.charAt(0).toUpperCase() + t.slice(1) + '</button>'
        ).join('') +
      '</div>';
    overviewNav.style.display = 'flex';
    overviewNav.style.alignItems = 'center';
    overviewNav.style.gap = '8px';
    overviewNav.querySelectorAll('[data-accnavtab]').forEach(function(btn) {
      btn.addEventListener('click', function() { switchAccountTab(btn.dataset.accnavtab); });
    });
    btnAdd.style.display = 'flex';
    document.getElementById('btnOpenFormLabel').textContent = 'Log Trade';
    var canW = ['Funded','Live','Instant'].indexOf(accObj.type) !== -1;
    document.getElementById('btnLogWithdrawal').style.display = canW ? 'flex' : 'none';
    document.getElementById('btnBack').addEventListener('click', () => {
      activeAccId = null; trades = [];
      showScreen('overview');
    });
    currentAccountTab = 'dashboard';
    switchAccountTab('dashboard');
  }
}

function switchOverviewTab(tab) {
  currentOverviewTab = tab;
  document.querySelectorAll('[data-ovtab]').forEach(b => b.classList.toggle('active', b.dataset.ovtab === tab));
  ['overviewMain','overviewNotes','overviewTrades','overviewWithdrawals','overviewData'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById('btnOpenForm').style.display = 'none';
  if (tab === 'accounts') {
    document.getElementById('overviewMain').style.display = 'block';
    renderOverview();
  } else if (tab === 'trades') {
    document.getElementById('overviewTrades').style.display = 'block';
    renderAllTrades();
  } else if (tab === 'notes') {
    document.getElementById('overviewNotes').style.display = 'block';
    renderAllNotes();
  } else if (tab === 'withdrawals') {
    document.getElementById('overviewWithdrawals').style.display = 'block';
    renderAllWithdrawals();
  } else if (tab === 'data') {
    document.getElementById('overviewData').style.display = 'block';
    updateAllExportDesc();
  }
  const overviewNav = document.getElementById('overviewNav');
  overviewNav.style.display = 'flex';
  overviewNav.style.alignItems = 'center';
  overviewNav.style.gap = '4px';
  overviewNav.style.flex = '1';
  // build nav once, then just update active class
  if (!overviewNav.dataset.built) {
    const tabDefs = [
      { id: 'accounts', label: 'Accounts' },
      { id: 'trades',   label: 'Trades' },
      { id: 'notes',    label: 'Notes' },
      { id: 'withdrawals', label: 'Withdrawals' },
      { id: 'data',     label: 'Data' },
    ];
    overviewNav.innerHTML = tabDefs.map(t =>
      '<button class="tab-btn" data-navtab="' + t.id + '">' + t.label + '</button>'
    ).join('');
    overviewNav.querySelectorAll('[data-navtab]').forEach(function(btn) {
      btn.addEventListener('click', function() { switchOverviewTab(btn.dataset.navtab); });
    });
    overviewNav.dataset.built = '1';
  }
  overviewNav.querySelectorAll('[data-navtab]').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.navtab === tab);
  });
}

document.getElementById('logoHome').addEventListener('click', () => {
  activeAccId = null; trades = []; showScreen('overview');
});

// ── Account Modal ─────────────────────────────────────────────
const accBackdrop = document.getElementById('accountModalBackdrop');
let editAccId = null;

function openAccountModal(acc) {
  editAccId = acc ? acc.id : null;
  document.getElementById('accModalTitle').textContent = acc ? 'Edit Account' : 'New Account';
  document.getElementById('btnSaveAccount').textContent = acc ? 'Save Changes' : 'Create Account';
  document.getElementById('fAccName').value     = acc ? acc.name : '';
  document.getElementById('fAccType').value     = acc ? acc.type : 'Instant';
  document.getElementById('fAccStep').value     = acc ? (acc.step || 'Step 1') : 'Step 1';
  document.getElementById('fAccStepWrap').style.display = (acc && acc.type === 'Challenge') ? 'flex' : 'none';
  document.getElementById('fAccSize').value     = acc ? (acc.size || '') : '';
  accBackdrop.classList.remove('hidden');
}

document.getElementById('btnNewAccount').addEventListener('click', () => openAccountModal(null));

document.getElementById('fAccType').addEventListener('change', function() {
  document.getElementById('fAccStepWrap').style.display = this.value === 'Challenge' ? 'flex' : 'none';
});
document.getElementById('btnCloseAccountModal').addEventListener('click', () => accBackdrop.classList.add('hidden'));
document.getElementById('btnCancelAccount').addEventListener('click',     () => accBackdrop.classList.add('hidden'));
accBackdrop.addEventListener('click', (e) => { if (e.target === accBackdrop) accBackdrop.classList.add('hidden'); });

document.getElementById('btnSaveAccount').addEventListener('click', () => {
  const name = document.getElementById('fAccName').value.trim();
  if (!name) { showToast('Please enter an account name.', 'error'); return; }
  const type = document.getElementById('fAccType').value;
  const data = {
    name:     name,
    type:     type,
    step:     type === 'Challenge' ? document.getElementById('fAccStep').value : null,
    size:     parseFloat(document.getElementById('fAccSize').value) || 0,
  };
  if (editAccId) {
    accounts = accounts.map(a => a.id === editAccId ? Object.assign({}, a, data) : a);
  } else {
    accounts.push(Object.assign({ id: uid() }, data));
  }
  saveAccounts(accounts);
  accBackdrop.classList.add('hidden');
  renderOverview();
});

// ── Overview render ───────────────────────────────────────────
function renderOverview() {
  // destroy old mini charts
  Object.values(miniCharts).forEach(c => c.destroy());
  miniCharts = {};

  const allTrades = accounts.reduce((arr, a) => {
    const t = loadTrades(a.id).map(function(tr) { tr._accId = a.id; return tr; });
    return arr.concat(t);
  }, []);
  const cs = accountStats(allTrades);
  const pnlColor = cs.totalPnl >= 0 ? 'var(--green)' : 'var(--red)';
  const allWithdrawn = accounts.reduce(function(sum, a) {
    return sum + loadWithdrawals(a.id).reduce(function(s, w) { return s + w.amount; }, 0);
  }, 0);
  document.getElementById('overviewKpiGrid').innerHTML =
    kpiCard('Total P&L', '<span style="color:' + pnlColor + '">' + fmtMoney(cs.totalPnl) + '</span>', '', '#388bfd', trendIcon(cs.totalPnl >= 0)) +
    kpiCard('Win Rate',  cs.winRate + '%', cs.wins + 'W / ' + cs.losses + 'L', '#26a641', targetIcon()) +
    kpiCard('Total Trades', cs.total, accounts.length + ' account' + (accounts.length !== 1 ? 's' : ''), '#e3b341', barIcon()) +
    kpiCard('Total Withdrawn', '<span style="color:var(--yellow)">' + fmtMoney(allWithdrawn) + '</span>', 'Net: <span style="color:' + (cs.totalPnl - allWithdrawn >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmtMoney(cs.totalPnl - allWithdrawn) + '</span>', '#e3b341', withdrawIcon());

  // Account cards
  const grid = document.getElementById('accountsGrid');
  if (!accounts.length) {
    grid.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:40px">No accounts yet. Click "+ New Account" to get started.</div>';
    return;
  }
  grid.innerHTML = accounts.map(acc => {
    const t   = allTrades.filter(function(tr) { return tr._accId === acc.id; });
    const w   = loadWithdrawals(acc.id);
    const s   = accountStats(t);
    const pc  = s.totalPnl >= 0 ? 'var(--green)' : 'var(--red)';
    const pct = acc.size ? ((s.totalPnl / acc.size) * 100).toFixed(2) + '%' : '';
    const canW = ['Funded','Live','Instant'].indexOf(acc.type) !== -1;
    const totalW = w.reduce(function(sum, x) { return sum + x.amount; }, 0);
    const stat3 = canW
      ? '<div><div class="account-stat-label">Withdrawn</div><div class="account-stat-value" style="color:var(--yellow)">' + (totalW > 0 ? '-$' + totalW.toFixed(2) : '—') + '</div></div>'
      : '<div><div class="account-stat-label">Trades</div><div class="account-stat-value">' + s.total + '</div></div>';
    const stat4 = canW
      ? '<div><div class="account-stat-label">Trades</div><div class="account-stat-value">' + s.total + '</div></div>'
      : '<div><div class="account-stat-label">Return</div><div class="account-stat-value" style="color:' + pc + '">' + (pct || '—') + '</div></div>';
    return '<div class="account-card" data-accid="' + esc(acc.id) + '">' +
      '<div class="account-card-header">' +
        '<span class="account-name">' + esc(acc.name) + '</span>' +
        '<div style="display:flex;gap:4px;align-items:center">' +
          '<span class="account-type">' + esc(acc.type) + '</span>' +
          (acc.step ? '<span class="account-type" style="background:rgba(227,179,65,.15);color:var(--yellow)">' + esc(acc.step) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="account-stats">' +
        '<div><div class="account-stat-label">Net P&L</div><div class="account-stat-value" style="color:' + pc + '">' + fmtMoney(s.totalPnl) + '</div></div>' +
        '<div><div class="account-stat-label">Win Rate</div><div class="account-stat-value">' + (t.length ? s.winRate + '%' : '—') + '</div></div>' +
        '<div><div class="account-stat-label">Leverage</div><div class="account-stat-value">1:' + (acc.leverage || 1) + '</div></div>' +
        stat3 + stat4 +
      '</div>' +
      (t.length >= 2 ? '<div style="position:relative;height:60px;margin-top:10px"><canvas id="mini-' + acc.id + '"></canvas></div>' : '') +
      '<div class="account-card-footer">' +
        '<button class="open-btn" data-accid="' + esc(acc.id) + '">Open <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></button>' +
        '<div style="display:flex;gap:4px">' +
          '<button class="edit-account-btn" data-editaccid="' + esc(acc.id) + '" title="Edit account"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
          '<button class="del-account-btn" data-delaccid="' + esc(acc.id) + '" title="Delete account"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // Draw mini charts
  accounts.forEach(acc => {
    const t = allTrades.filter(function(tr) { return tr._accId === acc.id; });
    if (t.length < 2) return;
    const sorted = [...t].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    let cum = 0;
    const data = sorted.map(tr => { cum += tr.pnl; return parseFloat(cum.toFixed(2)); });
    const lc   = data[data.length - 1] >= 0 ? '#26a641' : '#f85149';
    const ctx  = document.getElementById('mini-' + acc.id);
    if (!ctx) return;
    miniCharts[acc.id] = new Chart(ctx, {
      type: 'line',
      data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: lc, borderWidth: 1.5, fill: false, tension: 0.3, pointRadius: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, animation: false }
    });
  });

  // Open account
  document.querySelectorAll('.open-btn').forEach(btn =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); openAccount(btn.dataset.accid); })
  );
  // Card click also opens
  document.querySelectorAll('.account-card').forEach(card =>
    card.addEventListener('click', (e) => { if (!e.target.closest('.del-account-btn') && !e.target.closest('.edit-account-btn')) openAccount(card.dataset.accid); })
  );
  // Edit account
  document.querySelectorAll('.edit-account-btn').forEach(btn =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const acc = accounts.find(a => a.id === btn.dataset.editaccid);
      if (acc) openAccountModal(acc);
    })
  );
  // Delete account
  document.querySelectorAll('.del-account-btn').forEach(btn =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.delaccid;
      const acc = accounts.find(a => a.id === id);
      showConfirm('Delete Account', 'Delete account "' + acc.name + '" and all its trades? This cannot be undone.', function() {
        localStorage.removeItem(tradeKey(id));
        localStorage.removeItem(withdrawalKey(id));
        accounts = accounts.filter(a => a.id !== id);
        saveAccounts(accounts);
        renderOverview();
      });
    })
  );
}

function openAccount(id) {
  activeAccId = id;
  trades      = loadTrades(id);
  withdrawals = loadWithdrawals(id);
  filterResult = 'all'; filterAsset = ''; sortField = 'datetime'; sortDir = 'desc'; notesFilter = 'all'; calYear = 0; calMonth = 0;
  showScreen('account');
}

// ── Trade Modal ───────────────────────────────────────────────
const backdrop = document.getElementById('modalBackdrop');

function openModal(trade) {
  trade = trade || null;
  editId = trade ? trade.id : null;
  document.getElementById('modalTitle').textContent    = trade ? 'Edit Trade' : 'Log New Trade';
  document.getElementById('btnSubmitForm').textContent = trade ? 'Save Changes' : 'Log Trade';
  populateAssetSelect(trade ? trade.ticker : (loadAssets()[0] || {}).symbol);
  document.getElementById('fDatetime').value = trade ? trade.datetime     : localNow();
  document.getElementById('fPosition').value = trade ? trade.position     : 'Long';
  document.getElementById('fEntry').value    = trade ? trade.entryPrice   : '';
  document.getElementById('fExit').value     = trade ? trade.exitPrice    : '';
  document.getElementById('fSize').value     = trade ? trade.positionSize : '';
  document.getElementById('fFees').value     = trade ? trade.fees         : '0';
  document.getElementById('fStopLoss').value = trade ? (trade.stopLoss || '') : '';
  document.getElementById('fPnl').value      = trade ? trade.pnl : '';
  document.getElementById('fTags').value     = trade ? trade.tags         : '';
  document.getElementById('fNotes').value    = trade ? trade.notes        : '';
  currentScreenshot = (trade && trade.screenshot) ? trade.screenshot : null;
  setScreenshotPreview(currentScreenshot);
  backdrop.classList.remove('hidden');
}

function closeModal() { backdrop.classList.add('hidden'); editId = null; }

document.getElementById('btnOpenForm').addEventListener('click', () => {
  if (!activeAccId) { showToast('Open an account first.', 'error'); return; }
  openModal();
});
document.getElementById('btnLogWithdrawal').addEventListener('click', () => { if (activeAccId) openWithdrawalModal(); });
document.getElementById('btnCloseModal').addEventListener('click', closeModal);
document.getElementById('btnCancelForm').addEventListener('click', closeModal);
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });



document.getElementById('btnSubmitForm').addEventListener('click', () => {
  const ticker = document.getElementById('fTicker').value.trim().toUpperCase();
  const entry  = document.getElementById('fEntry').value;
  const exit   = document.getElementById('fExit').value;
  const size   = document.getElementById('fSize').value;
  if (!ticker || !entry || !exit || !size) { showToast('Please fill in Ticker, Entry, Exit, and Size.', 'error'); return; }
  if (+entry <= 0 || +exit <= 0) { showToast('Entry and Exit prices must be greater than 0.', 'error'); return; }
  if (+size <= 0) { showToast('Position size must be greater than 0.', 'error'); return; }
  if (+document.getElementById('fFees').value < 0) { showToast('Fees cannot be negative.', 'error'); return; }
  const pnlVal = document.getElementById('fPnl').value;
  if (pnlVal === '' || pnlVal === null) { showToast('Please enter the Net P&L.', 'error'); return; }
  const trade = {
    ticker, datetime: document.getElementById('fDatetime').value,
    position: document.getElementById('fPosition').value,
    entryPrice: entry, exitPrice: exit, positionSize: size,
    fees: document.getElementById('fFees').value || '0',
    stopLoss: document.getElementById('fStopLoss').value || '',
    tags: document.getElementById('fTags').value.trim(),
    notes: document.getElementById('fNotes').value.trim(),
  };
  trade.pnl = parseFloat(pnlVal) || 0;
  if (currentScreenshot) trade.screenshot = currentScreenshot;
  if (editId) {
    trades = trades.map(t => t.id === editId ? Object.assign({}, trade, { id: editId }) : t);
  } else {
    trade.id = uid();
    trades.unshift(trade);
  }
  saveTrades(activeAccId, trades);
  var totalSaved = accounts.reduce(function(n, a) { return n + loadTrades(a.id).length; }, 0);
  if (totalSaved > 0 && totalSaved % 10 === 0) {
    showToast('💾 ' + totalSaved + ' trades logged — consider exporting a backup!', 'success');
  }
  closeModal();
  if (currentAccountTab === 'trades') renderTrades();
  else if (currentAccountTab === 'notes') renderNotes();
  else renderDashboard();
});

// ── Dashboard ─────────────────────────────────────────────────
function renderDashboard() {
  renderKpis();
  renderCalendar();
  renderChart();
}

// ── Account Trades tab ────────────────────────────────────────
function renderTrades() {
  var assets = [...new Set(trades.map(t => t.ticker))].sort();
  var sel = document.getElementById('filterAsset');
  var prev = sel.value;
  sel.innerHTML = '<option value="">All Assets</option>' +
    assets.map(a => '<option' + (a === prev ? ' selected' : '') + '>' + esc(a) + '</option>').join('');
  var list = trades.slice();
  if (filterResult === 'win')  list = list.filter(t => t.pnl > 0);
  if (filterResult === 'loss') list = list.filter(t => t.pnl <= 0);
  if (filterAsset) list = list.filter(t => t.ticker === filterAsset);
  list.sort(function(a, b) {
    var av = a[sortField], bv = b[sortField];
    if (sortField === 'datetime') { av = new Date(av); bv = new Date(bv); }
    else { av = +av || 0; bv = +bv || 0; }
    return sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });
  document.getElementById('tradeCount').textContent = list.length + ' trade' + (list.length !== 1 ? 's' : '');
  var tbody = document.getElementById('tradesTbody');
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No trades found.</td></tr>'; return; }
  // sortable headers
  document.querySelectorAll('#tradesTable th[data-sort]').forEach(function(th) {
    th.classList.toggle('sort-asc', sortField === th.dataset.sort && sortDir === 'asc');
    th.classList.toggle('sort-desc', sortField === th.dataset.sort && sortDir === 'desc');
    th.onclick = function() {
      if (sortField === th.dataset.sort) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortField = th.dataset.sort; sortDir = th.dataset.sort === 'datetime' ? 'desc' : 'desc'; }
      renderTrades();
    };
  });
  tbody.innerHTML = list.map(function(t) {
    var pc = t.pnl >= 0 ? 'green' : 'red';
    var sc = t.position === 'Long' ? 'badge-long' : 'badge-short';
    var r  = calcR(t);
    var pnlCell = (t.pnl >= 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2) + (r !== null ? '<span style="color:var(--muted);font-size:.72rem;margin-left:4px">(' + (r >= 0 ? '+' : '') + r + 'R)</span>' : '');
    var tags = t.tags ? t.tags.split(',').map(g => '<span class="tag-chip">' + esc(g.trim()) + '</span>').join('') : '<span class="muted">—</span>';
    var thumb = t.screenshot ? '<img class="thumb" src="' + t.screenshot + '" data-src="' + t.screenshot + '" alt="chart" />' : '<span class="muted">—</span>';
    return '<tr>' +
      '<td style="color:var(--muted);font-size:.78rem">' + fmtDate(t.datetime) + '</td>' +
      '<td class="fw7">' + esc(t.ticker) + '</td>' +
      '<td><span class="badge ' + sc + '">' + esc(t.position) + '</span></td>' +
      '<td>$' + parseFloat(t.entryPrice).toLocaleString() + '</td>' +
      '<td>$' + parseFloat(t.exitPrice).toLocaleString() + '</td>' +
      '<td style="color:var(--muted)">' + esc(String(t.positionSize)) + '</td>' +
      '<td class="' + pc + ' fw7">' + pnlCell + '</td>' +
      '<td class="hide-sm">' + tags + '</td>' +
      '<td class="hide-sm">' + thumb + '</td>' +
      '<td><div class="action-btns">' +
        '<button class="action-btn edit" data-edit-id="' + esc(t.id) + '" title="Edit"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
        '<button class="action-btn del" data-del-id="' + esc(t.id) + '" title="Delete"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
  tbody.querySelectorAll('.thumb').forEach(img => img.addEventListener('click', () => openLightbox(img.dataset.src)));
  tbody.querySelectorAll('[data-edit-id]').forEach(btn => btn.addEventListener('click', () => {
    var trade = trades.find(t => t.id === btn.dataset.editId); if (trade) openModal(trade);
  }));
  tbody.querySelectorAll('[data-del-id]').forEach(btn => btn.addEventListener('click', () => {
    showConfirm('Delete Trade', 'Delete this trade? This cannot be undone.', function() {
      trades = trades.filter(t => t.id !== btn.dataset.delId);
      saveTrades(activeAccId, trades); renderTrades();
    });
  }));
}

document.getElementById('filterAsset').addEventListener('change', function(e) { filterAsset = e.target.value; renderTrades(); });
document.querySelectorAll('[data-result]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('[data-result]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); filterResult = btn.dataset.result; renderTrades();
  });
});

// ── Account Withdrawals tab ───────────────────────────────────
function renderWithdrawals() {
  var total = withdrawals.reduce(function(s, w) { return s + w.amount; }, 0);
  document.getElementById('withdrawalSummary').innerHTML =
    '<div class="card kpi-card" style="max-width:260px">' +
    '<div class="kpi-icon" style="background:#e3b34122">' + withdrawIcon() + '</div>' +
    '<div><div class="kpi-label">Total Withdrawn</div>' +
    '<div class="kpi-value" style="color:var(--yellow)">' + fmtMoney(total) + '</div>' +
    '<div class="kpi-sub">' + withdrawals.length + ' withdrawal' + (withdrawals.length !== 1 ? 's' : '') + '</div></div></div>';
  var listEl = document.getElementById('withdrawalList');
  if (!withdrawals.length) {
    listEl.innerHTML = '<div class="card" style="text-align:center;color:var(--muted);padding:40px;font-size:.85rem">No withdrawals yet.</div>';
    return;
  }
  var sorted = withdrawals.slice().sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  var rows = sorted.map(function(w) {
    var d = new Date(w.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return '<tr><td style="color:var(--muted);font-size:.78rem">' + d + '</td>' +
      '<td class="fw7" style="color:var(--yellow)">-$' + w.amount.toFixed(2) + '</td>' +
      '<td style="color:var(--muted)">' + (w.note || '—') + '</td>' +
      '<td><button class="action-btn del" data-del-w-id="' + esc(w.id) + '" title="Delete"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></td></tr>';
  }).join('');
  listEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  listEl.querySelectorAll('[data-del-w-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      showConfirm('Delete Withdrawal', 'Delete this withdrawal?', function() {
        withdrawals = withdrawals.filter(w => w.id !== btn.dataset.delWId);
        saveWithdrawals(activeAccId, withdrawals); renderWithdrawals(); renderKpis();
      });
    });
  });
}

let calYear = 0, calMonth = 0;

function renderCalendar() {
  var now = new Date();
  if (!calYear)  { calYear = now.getFullYear(); calMonth = now.getMonth(); }
  var area = document.getElementById('calendarArea');
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Build daily PnL map and count map: key = 'YYYY-MM-DD'
  var dayMap = {}, countMap = {};
  trades.forEach(function(t) {
    var d = t.datetime ? t.datetime.slice(0, 10) : null;
    if (!d) return;
    dayMap[d]   = (dayMap[d] || 0) + t.pnl;
    countMap[d] = (countMap[d] || 0) + 1;
  });

  var firstDay = new Date(calYear, calMonth, 1).getDay();
  var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  var todayStr = now.toISOString().slice(0, 10);

  // Day-of-week headers
  var html = '<div class="cal-header">' +
    '<div class="cal-nav">' +
      '<button id="calPrev">&#8249;</button>' +
      '<button id="calNext">&#8250;</button>' +
    '</div>' +
    '<div class="cal-title">' + MONTHS[calMonth] + ' ' + calYear + '</div>' +
    '<button id="calToday" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--muted);padding:4px 10px;font-size:.78rem;cursor:pointer;">Today</button>' +
  '</div>' +
  '<div class="cal-grid">';

  DAYS.forEach(function(d) { html += '<div class="cal-dow">' + d + '</div>'; });

  // Empty cells before first day
  for (var e = 0; e < firstDay; e++) html += '<div class="cal-day empty"></div>';

  for (var day = 1; day <= daysInMonth; day++) {
    var key = calYear + '-' + String(calMonth + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    var pnl = dayMap[key];
    var cls = 'cal-day';
    if (key === todayStr) cls += ' today';
    if (pnl !== undefined) cls += pnl >= 0 ? ' win' : ' loss';
    html += '<div class="' + cls + '">' +
      '<span class="cal-day-num">' + day + '</span>' +
      (countMap[key] ? '<span class="cal-day-count">' + countMap[key] + ' trade' + (countMap[key] > 1 ? 's' : '') + '</span>' : '') +
      (pnl !== undefined ? '<span class="cal-day-pnl">' + (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2) + '</span>' : '') +
    '</div>';
  }
  html += '</div>';
  area.innerHTML = html;

  document.getElementById('calPrev').addEventListener('click', function() {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', function() {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar();
  });
  document.getElementById('calToday').addEventListener('click', function() {
    calYear = now.getFullYear(); calMonth = now.getMonth(); renderCalendar();
  });
}

function renderKpis() {
  const grid = document.getElementById('kpiGrid');
  if (!trades.length) {
    grid.innerHTML = '<div class="card kpi-card" style="grid-column:1/-1;justify-content:center;color:var(--muted);font-size:.85rem">No trades yet. Click "Log Trade" to start.</div>';
    return;
  }
  const s = accountStats(trades);
  const pc = s.totalPnl >= 0 ? 'var(--green)' : 'var(--red)';
  const acc = accounts.find(function(a) { return a.id === activeAccId; }) || {};
  const canWithdraw = ['Funded','Live','Instant'].indexOf(acc.type) !== -1;
  const totalWithdrawn = withdrawals.reduce(function(sum, w) { return sum + w.amount; }, 0);
  const netBalance = s.totalPnl - totalWithdrawn;
  const pfColor = s.profitFactor >= 1.5 ? 'var(--green)' : s.profitFactor >= 1 ? 'var(--yellow)' : 'var(--red)';
  const streakColor = s.streakType === 'W' ? 'var(--green)' : 'var(--red)';
  const streakLabel = s.streak ? s.streak + ' ' + (s.streakType === 'W' ? 'Win' : 'Loss') + (s.streak > 1 ? 's' : '') : '—';
  grid.innerHTML =
    kpiCard('Total P&L', '<span style="color:' + pc + '">' + fmtMoney(s.totalPnl) + '</span>', '', '#388bfd', trendIcon(s.totalPnl >= 0)) +
    kpiCard('Win Rate', s.winRate + '%', s.wins + 'W / ' + s.losses + 'L', '#26a641', targetIcon()) +
    kpiCard('Total Trades', s.total, '', '#e3b341', barIcon()) +
    (canWithdraw
      ? kpiCard('Withdrawn', '<span style="color:var(--yellow)">' + fmtMoney(totalWithdrawn) + '</span>', 'Net: <span style="color:' + (netBalance >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmtMoney(netBalance) + '</span>', '#e3b341', withdrawIcon())
      : kpiCard('Best / Worst', '<span class="green">' + fmtMoney(s.best) + '</span>', 'Worst: <span class="red">' + fmtMoney(s.worst) + '</span>', '#26a641', trendIcon(true))) +
    kpiCard('Profit Factor', '<span style="color:' + pfColor + '">' + (s.profitFactor === Infinity ? '∞' : s.profitFactor) + '</span>', '', '#388bfd', targetIcon()) +
    kpiCard('Avg Win', '<span class="green">+$' + s.avgWin.toFixed(2) + '</span>', 'Avg Loss: <span class="red">-$' + s.avgLoss.toFixed(2) + '</span>', '#26a641', trendIcon(true)) +
    kpiCard('Max Drawdown', '<span class="red">-$' + s.maxDrawdown.toFixed(2) + '</span>', '', '#f85149', trendIcon(false)) +
    (s.avgR !== null
      ? kpiCard('Avg R', '<span style="color:' + (s.avgR >= 0 ? 'var(--green)' : 'var(--red)') + '">' + (s.avgR >= 0 ? '+' : '') + s.avgR + 'R</span>', 'Current Streak: <span style="color:' + streakColor + '">' + streakLabel + '</span>', '#e3b341', barIcon())
      : kpiCard('Current Streak', '<span style="color:' + streakColor + '">' + streakLabel + '</span>', '', '#e3b341', barIcon()));
}

function kpiCard(label, value, sub, color, icon) {
  return '<div class="card kpi-card">' +
    '<div class="kpi-icon" style="background:' + color + '22">' + icon + '</div>' +
    '<div><div class="kpi-label">' + label + '</div><div class="kpi-value">' + value + '</div>' +
    (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div></div>';
}
function trendIcon(up) {
  var c = up ? 'var(--green)' : 'var(--red)';
  var p = up ? '23 6 13.5 15.5 8.5 10.5 1 18' : '23 18 13.5 8.5 8.5 13.5 1 6';
  var a = up ? '<polyline points="17 6 23 6 23 12"/>' : '<polyline points="17 18 23 18 23 12"/>';
  return '<svg width="18" height="18" fill="none" stroke="' + c + '" stroke-width="2" viewBox="0 0 24 24"><polyline points="' + p + '"/>' + a + '</svg>';
}
function targetIcon() { return '<svg width="18" height="18" fill="none" stroke="var(--blue)" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>'; }
function barIcon()    { return '<svg width="18" height="18" fill="none" stroke="var(--yellow)" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'; }
function withdrawIcon() { return '<svg width="18" height="18" fill="none" stroke="var(--yellow)" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>'; }

// ── All Trades (overview) ────────────────────────────────────────────
let allTradesPage = 0;
const ALL_TRADES_PAGE_SIZE = 50;

function renderAllTrades() {
  var allTrades = accounts.reduce(function(arr, a) {
    var t = loadTrades(a.id);
    t.forEach(function(tr) { tr._accId = a.id; tr._accName = a.name; });
    return arr.concat(t);
  }, []);
  var accSel = document.getElementById('allFilterAccount');
  var prevAcc = accSel.value;
  accSel.innerHTML = '<option value="">All Accounts</option>' +
    accounts.map(function(a) { return '<option value="' + esc(a.id) + '"' + (a.id === prevAcc ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join('');
  var assets = [...new Set(allTrades.map(function(t) { return t.ticker; }))].sort();
  var assetSel = document.getElementById('allFilterAsset');
  var prevAsset = assetSel.value;
  assetSel.innerHTML = '<option value="">All Assets</option>' +
    assets.map(function(a) { return '<option' + (a === prevAsset ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('');
  var list = allTrades.slice();
  if (allFilterResult === 'win')  list = list.filter(function(t) { return t.pnl > 0; });
  if (allFilterResult === 'loss') list = list.filter(function(t) { return t.pnl <= 0; });
  if (allFilterAsset)   list = list.filter(function(t) { return t.ticker === allFilterAsset; });
  if (allFilterAccount) list = list.filter(function(t) { return t._accId === allFilterAccount; });
  list.sort(function(a, b) { return new Date(b.datetime) - new Date(a.datetime); });
  var totalPages = Math.ceil(list.length / ALL_TRADES_PAGE_SIZE) || 1;
  if (allTradesPage >= totalPages) allTradesPage = totalPages - 1;
  var pageList = list.slice(allTradesPage * ALL_TRADES_PAGE_SIZE, (allTradesPage + 1) * ALL_TRADES_PAGE_SIZE);
  document.getElementById('allTradeCount').textContent = list.length + ' trade' + (list.length !== 1 ? 's' : '') + (totalPages > 1 ? ' · Page ' + (allTradesPage + 1) + ' of ' + totalPages : '');
  var tbody = document.getElementById('allTradesTbody');
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No trades found.</td></tr>'; return; }
  var rows = '';
  for (var i = 0; i < pageList.length; i++) {
    var t = pageList[i];
    var pc = t.pnl >= 0 ? 'green' : 'red';
    var sc = t.position === 'Long' ? 'badge-long' : 'badge-short';
    var tags = '';
    if (t.tags) t.tags.split(',').forEach(function(g) { tags += '<span class="tag-chip">' + esc(g.trim()) + '</span>'; });
    else tags = '<span class="muted">—</span>';
    var thumb = t.screenshot ? '<img class="thumb" src="' + t.screenshot + '" data-src="' + t.screenshot + '" alt="chart" />' : '<span class="muted">—</span>';
    rows += '<tr>' +
      '<td style="color:var(--muted);font-size:.78rem">' + fmtDate(t.datetime) + '</td>' +
      '<td style="color:var(--blue);font-size:.78rem">' + esc(t._accName || '') + '</td>' +
      '<td class="fw7">' + esc(t.ticker) + '</td>' +
      '<td><span class="badge ' + sc + '">' + esc(t.position) + '</span></td>' +
      '<td>$' + parseFloat(t.entryPrice).toLocaleString() + '</td>' +
      '<td>$' + parseFloat(t.exitPrice).toLocaleString() + '</td>' +
      '<td style="color:var(--muted)">' + esc(String(t.positionSize)) + '</td>' +
      '<td class="' + pc + ' fw7">' + (t.pnl >= 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2) + '</td>' +
      '<td class="hide-sm">' + tags + '</td>' +
      '<td class="hide-sm">' + thumb + '</td>' +
      '<td><div class="action-btns">' +
        '<button class="action-btn edit" data-all-edit-id="' + esc(t.id) + '" data-all-edit-acc="' + esc(t._accId) + '" title="Edit"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
        '<button class="action-btn del" data-all-del-id="' + esc(t.id) + '" data-all-del-acc="' + esc(t._accId) + '" title="Delete"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>' +
      '</div></td>' +
    '</tr>';
  }
  if (totalPages > 1) {
    rows += '<tr><td colspan="11" style="text-align:center;padding:12px"><button class="btn btn-ghost" id="btnPrevPage"' + (allTradesPage === 0 ? ' disabled' : '') + '>&#171; Prev</button> <button class="btn btn-ghost" id="btnNextPage"' + (allTradesPage >= totalPages - 1 ? ' disabled' : '') + '>Next &#187;</button></td></tr>';
  }
  tbody.innerHTML = rows;
  if (totalPages > 1) {
    var pb = document.getElementById('btnPrevPage'); if (pb) pb.addEventListener('click', function() { allTradesPage--; renderAllTrades(); });
    var nb = document.getElementById('btnNextPage'); if (nb) nb.addEventListener('click', function() { allTradesPage++; renderAllTrades(); });
  }
  tbody.querySelectorAll('.thumb').forEach(function(img) { img.addEventListener('click', function() { openLightbox(img.dataset.src); }); });
  tbody.querySelectorAll('[data-all-edit-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var accId = btn.dataset.allEditAcc; var tradeId = btn.dataset.allEditId;
      activeAccId = accId; trades = loadTrades(accId); withdrawals = loadWithdrawals(accId);
      var trade = trades.find(function(t) { return t.id === tradeId; });
      if (trade) openModal(trade);
    });
  });
  tbody.querySelectorAll('[data-all-del-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var accId = btn.dataset.allDelAcc; var tradeId = btn.dataset.allDelId;
      showConfirm('Delete Trade', 'Delete this trade? This cannot be undone.', function() {
        var t = loadTrades(accId).filter(function(x) { return x.id !== tradeId; });
        saveTrades(accId, t); if (accId === activeAccId) trades = t; renderAllTrades();
      });
    });
  });
}

document.getElementById('allFilterAsset').addEventListener('change', function(e) { allFilterAsset = e.target.value; allTradesPage = 0; renderAllTrades(); });
document.getElementById('allFilterAccount').addEventListener('change', function(e) { allFilterAccount = e.target.value; allTradesPage = 0; renderAllTrades(); });
document.querySelectorAll('[data-all-result]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('[data-all-result]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    allFilterResult = btn.dataset.allResult;
    allTradesPage = 0;
    renderAllTrades();
  });
});

// ── All Withdrawals (overview) ────────────────────────────────
function renderAllWithdrawals() {
  var allW = accounts.reduce(function(arr, a) {
    var w = loadWithdrawals(a.id);
    w.forEach(function(x) { x._accName = a.name; });
    return arr.concat(w);
  }, []);
  var total = allW.reduce(function(s, w) { return s + w.amount; }, 0);

  document.getElementById('allWithdrawalSummary').innerHTML =
    '<div class="card kpi-card" style="max-width:260px">' +
    '<div class="kpi-icon" style="background:#e3b34122">' + withdrawIcon() + '</div>' +
    '<div><div class="kpi-label">Total Withdrawn</div>' +
    '<div class="kpi-value" style="color:var(--yellow)">' + fmtMoney(total) + '</div>' +
    '<div class="kpi-sub">' + allW.length + ' withdrawal' + (allW.length !== 1 ? 's' : '') + ' across ' + accounts.length + ' account' + (accounts.length !== 1 ? 's' : '') + '</div></div></div>';

  var listEl = document.getElementById('allWithdrawalList');
  if (!allW.length) {
    listEl.innerHTML = '<div class="card" style="text-align:center;color:var(--muted);padding:40px;font-size:.85rem">No withdrawals yet.</div>';
    return;
  }
  var sorted = allW.slice().sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  var rows = '';
  for (var i = 0; i < sorted.length; i++) {
    var w = sorted[i];
    var d = new Date(w.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    rows += '<tr><td style="color:var(--muted);font-size:.78rem">' + d + '</td>' +
      '<td style="color:var(--blue);font-size:.78rem">' + (w._accName || '') + '</td>' +
      '<td class="fw7" style="color:var(--yellow)">-$' + w.amount.toFixed(2) + '</td>' +
      '<td style="color:var(--muted)">' + (w.note || '—') + '</td></tr>';
  }
  listEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Account</th><th>Amount</th><th>Note</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── All Data (overview) ───────────────────────────────────────
function updateAllExportDesc() {
  var total = accounts.reduce(function(n, a) { return n + loadTrades(a.id).length; }, 0);
  document.getElementById('allExportDesc').textContent = 'Download all ' + total + ' trade' + (total !== 1 ? 's' : '') + ' across ' + accounts.length + ' account' + (accounts.length !== 1 ? 's' : '');
}

function showAllFlash(text, type) {
  type = type || 'success';
  var el = document.getElementById('allFlashMsg');
  el.className = 'flash ' + type; el.textContent = text; el.style.display = 'block';
  clearTimeout(el._t); el._t = setTimeout(function() { el.style.display = 'none'; }, 3500);
}

document.getElementById('btnAllExport').addEventListener('click', function() {
  var data = {
    assets: loadAssets(),
    accounts: accounts.map(function(a) { return { account: a, trades: loadTrades(a.id), withdrawals: loadWithdrawals(a.id) }; })
  };
  if (!data.accounts.length) { showAllFlash('No accounts to export.', 'error'); return; }
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'trading-journal-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(url);
  showAllFlash('Exported all accounts.');
});

document.getElementById('btnAllImport').addEventListener('click', function() {
  document.getElementById('allFileInput').click();
});

document.getElementById('allFileInput').addEventListener('change', function(e) {
  var file = e.target.files?.[0]; if (!file) return;
  var r = new FileReader();
  r.onload = function(ev) {
    try {
      var parsed = JSON.parse(ev.target.result);
      // support both old array format and new { assets, accounts } format
      var accountList = Array.isArray(parsed) ? parsed : (parsed.accounts || []);
      if (!Array.isArray(accountList)) throw new Error();
      if (parsed.assets && Array.isArray(parsed.assets)) saveAssets(parsed.assets);
      accountList.forEach(function(item) {
        if (!item.account || !item.account.id) return;
        if (!accounts.find(function(a) { return a.id === item.account.id; })) accounts.push(item.account);
        if (Array.isArray(item.trades)) saveTrades(item.account.id, item.trades);
        if (Array.isArray(item.withdrawals)) saveWithdrawals(item.account.id, item.withdrawals);
      });
      saveAccounts(accounts);
      showAllFlash('Import successful.');
      updateAllExportDesc();
    } catch(err) { showAllFlash('Invalid JSON file.', 'error'); }
  };
  r.readAsText(file); e.target.value = '';
});

// ── Notes ────────────────────────────────────────────────────
let notesFilter    = 'all';
let allNotesFilter = 'all';

function buildNoteCardHtml(t, showAccount) {
  var isWin     = t.pnl > 0;
  var pnlColor  = isWin ? 'var(--green)' : 'var(--red)';
  var borderCls = isWin ? 'win-border' : 'loss-border';
  var sideBadge = t.position === 'Long' ? '<span class="badge badge-long">Long</span>' : '<span class="badge badge-short">Short</span>';
  var pnlStr    = (t.pnl >= 0 ? '+$' : '-$') + Math.abs(t.pnl).toFixed(2);
  var dateStr   = new Date(t.datetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  var sub       = dateStr;
  if (showAccount && t._accName) sub += ' &nbsp;&middot;&nbsp; <span style="color:var(--blue)">' + t._accName + '</span>';
  if (t.tags) sub += ' &nbsp;&middot;&nbsp; ' + t.tags;
  return '<div class="note-card">' +
    '<div class="note-card-header">' +
      (t.screenshot ? '<img class="thumb" src="' + t.screenshot + '" data-src="' + t.screenshot + '" style="width:44px;height:44px;flex-shrink:0" alt="chart" />' : '') +
      '<div class="note-card-meta">' +
        '<div class="note-card-title">' + t.ticker + ' &nbsp;' + sideBadge + ' &nbsp;<span style="color:' + pnlColor + ';font-size:.88rem">' + pnlStr + '</span></div>' +
        '<div class="note-card-sub">' + sub + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="note-card-body ' + borderCls + '">' + t.notes.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
    (t.screenshot ? '<img class="note-card-img" src="' + t.screenshot + '" data-src="' + t.screenshot + '" alt="screenshot" />' : '') +
  '</div>';
}

function renderNotesList(list, gridId, emptyMsg) {
  var grid = document.getElementById(gridId);
  if (!list.length) { grid.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:48px;font-size:.85rem">' + emptyMsg + '</div>'; return; }
  grid.innerHTML = list.map(function(t) { return buildNoteCardHtml(t, gridId === 'allNotesGrid'); }).join('');
  grid.querySelectorAll('.thumb, .note-card-img').forEach(function(img) {
    img.addEventListener('click', function() { openLightbox(img.dataset.src); });
  });
}

function renderNotes() {
  var list = trades.filter(function(t) { return t.notes && t.notes.trim(); });
  if (notesFilter === 'win')  list = list.filter(function(t) { return t.pnl > 0; });
  if (notesFilter === 'loss') list = list.filter(function(t) { return t.pnl <= 0; });
  list = list.slice().sort(function(a, b) { return new Date(b.datetime) - new Date(a.datetime); });
  document.getElementById('notesCount').textContent = list.length + ' note' + (list.length !== 1 ? 's' : '');
  renderNotesList(list, 'notesGrid', 'No notes found. Add notes when logging trades.');
}

document.querySelectorAll('[data-notes-filter]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('[data-notes-filter]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    notesFilter = btn.dataset.notesFilter;
    renderNotes();
  });
});

function renderAllNotes() {
  var allTrades = accounts.reduce(function(arr, a) {
    var t = loadTrades(a.id);
    t.forEach(function(tr) { tr._accName = a.name; });
    return arr.concat(t);
  }, []);
  var list = allTrades.filter(function(t) { return t.notes && t.notes.trim(); });
  if (allNotesFilter === 'win')  list = list.filter(function(t) { return t.pnl > 0; });
  if (allNotesFilter === 'loss') list = list.filter(function(t) { return t.pnl <= 0; });
  list = list.slice().sort(function(a, b) { return new Date(b.datetime) - new Date(a.datetime); });
  document.getElementById('allNotesCount').textContent = list.length + ' note' + (list.length !== 1 ? 's' : '');
  renderNotesList(list, 'allNotesGrid', 'No notes found across any account.');
}

document.querySelectorAll('[data-all-notes-filter]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('[data-all-notes-filter]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    allNotesFilter = btn.dataset.allNotesFilter;
    renderAllNotes();
  });
});

var wBackdrop = document.getElementById('withdrawalModalBackdrop');
function openWithdrawalModal() {
  var today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  document.getElementById('fWDate').value   = today.toISOString().slice(0, 10);
  document.getElementById('fWAmount').value = '';
  document.getElementById('fWNote').value   = '';
  wBackdrop.classList.remove('hidden');
}
function closeWithdrawalModal() { wBackdrop.classList.add('hidden'); }
document.getElementById('btnCloseWithdrawalModal').addEventListener('click', closeWithdrawalModal);
document.getElementById('btnCancelWithdrawal').addEventListener('click', closeWithdrawalModal);
wBackdrop.addEventListener('click', function(e) { if (e.target === wBackdrop) closeWithdrawalModal(); });
document.getElementById('btnSaveWithdrawal').addEventListener('click', function() {
  var amount = parseFloat(document.getElementById('fWAmount').value);
  var date   = document.getElementById('fWDate').value;
  if (!date || !amount || amount <= 0) { showToast('Please enter a valid date and amount.', 'error'); return; }
  withdrawals.push({ id: uid(), date: date, amount: amount, note: document.getElementById('fWNote').value.trim() });
  saveWithdrawals(activeAccId, withdrawals);
  closeWithdrawalModal();
  renderKpis();
  if (currentAccountTab === 'withdrawals') renderWithdrawals();
});

function renderChart() {
  const area = document.getElementById('chartArea');
  if (trades.length < 2) {
    area.innerHTML = '<div class="chart-empty">Add at least 2 trades to see the equity curve.</div>';
    if (equityChart) { equityChart.destroy(); equityChart = null; }
    return;
  }
  const sorted = [...trades].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  let cum = 0;
  const labels = [], data = [];
  sorted.forEach(t => {
    cum += t.pnl;
    labels.push(new Date(t.datetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    data.push(parseFloat(cum.toFixed(2)));
  });
  const lc = data[data.length - 1] >= 0 ? '#26a641' : '#f85149';
  if (equityChart) { equityChart.destroy(); equityChart = null; }
  area.innerHTML = '<div style="position:relative;height:220px"><canvas id="equityCanvas"></canvas></div>';
  const ctx  = document.getElementById('equityCanvas').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 220);
  grad.addColorStop(0, lc + '55'); grad.addColorStop(1, lc + '00');
  equityChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: lc, borderWidth: 2, backgroundColor: grad, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: lc }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#21262d', borderColor: '#30363d', borderWidth: 1, titleColor: '#8b949e', bodyColor: lc, callbacks: { label: (c) => ' ' + fmtMoney(c.parsed.y) } } },
      scales: {
        x: { grid: { color: '#30363d' }, ticks: { color: '#8b949e', font: { size: 11 } } },
        y: { grid: { color: '#30363d' }, ticks: { color: '#8b949e', font: { size: 11 }, callback: (v) => '$' + v } }
      }
    }
  });
}





// ── Init ──────────────────────────────────────────────────────
showScreen('overview');
