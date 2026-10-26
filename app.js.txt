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
let activeAccId   = null;   // which account we are viewing
let trades        = [];     // trades for active account
let editId        = null;
let filterResult  = 'all';
let filterAsset   = '';
let sortField     = 'datetime';
let sortDir       = 'desc';
let clearConfirm  = false;
let withdrawals   = [];
let equityChart   = null;
let currentScreenshot = null;
let miniCharts    = {};     // canvas chart instances on overview cards

// ── Helpers ───────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

const getContractSize = (ticker) => {
  const t = (ticker || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (t.includes('XAU')) return 100;
  if (t.includes('XAG')) return 5000;
  return 1;
};

const calcPnl = (t) => {
  const entry = +t.entryPrice || 0, exit = +t.exitPrice || 0;
  const lots  = +t.positionSize || 0, fees = +t.fees || 0;
  const cs    = getContractSize(t.ticker);
  const raw   = t.position === 'Long' ? (exit - entry) * lots * cs : (entry - exit) * lots * cs;
  return parseFloat((raw - fees).toFixed(2));
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
  if (!tradeList.length) return { totalPnl: 0, winRate: 0, wins: 0, losses: 0, total: 0, best: 0, worst: 0 };
  const totalPnl = tradeList.reduce((a, t) => a + t.pnl, 0);
  const wins     = tradeList.filter(t => t.pnl > 0).length;
  const losses   = tradeList.filter(t => t.pnl <= 0).length;
  const best     = Math.max(...tradeList.map(t => t.pnl));
  const worst    = Math.min(...tradeList.map(t => t.pnl));
  return { totalPnl: parseFloat(totalPnl.toFixed(2)), winRate: parseFloat(((wins / tradeList.length) * 100).toFixed(1)), wins, losses, total: tradeList.length, best, worst };
};

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

// ── Lightbox ──────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}
document.getElementById('lightboxClose').addEventListener('click', () => document.getElementById('lightbox').classList.add('hidden'));
document.getElementById('lightbox').addEventListener('click', (e) => { if (e.target === document.getElementById('lightbox')) document.getElementById('lightbox').classList.add('hidden'); });

// ── Screen switching ──────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');

  const mainNav     = document.getElementById('mainNav');
  const overviewNav = document.getElementById('overviewNav');
  const btnLabel    = document.getElementById('btnOpenFormLabel');

  if (name === 'overview') {
    mainNav.style.display     = 'none';
    overviewNav.style.display = 'flex';
    overviewNav.style.alignItems = 'center';
    overviewNav.style.gap     = '8px';
    overviewNav.innerHTML =
      '<button class="tab-btn active" id="ovTabAccounts">Accounts</button>' +
      '<button class="tab-btn" id="ovTabNotes">' +
      '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
      'Notes</button>';
    document.getElementById('btnOpenForm').style.display = 'none';
    document.getElementById('ovTabAccounts').addEventListener('click', function() {
      document.getElementById('ovTabAccounts').classList.add('active');
      document.getElementById('ovTabNotes').classList.remove('active');
      document.getElementById('overviewMain').style.display = 'block';
      document.getElementById('overviewNotes').style.display = 'none';
    });
    document.getElementById('ovTabNotes').addEventListener('click', function() {
      document.getElementById('ovTabNotes').classList.add('active');
      document.getElementById('ovTabAccounts').classList.remove('active');
      document.getElementById('overviewMain').style.display = 'none';
      document.getElementById('overviewNotes').style.display = 'block';
      renderAllNotes();
    });
    renderOverview();
  } else {
    mainNav.style.display     = 'flex';
    overviewNav.style.display = 'none';
    document.getElementById('btnOpenForm').style.display = 'flex';
    btnLabel.textContent = 'Log Trade';
    // show back button + account name in overviewNav area
    var accObj = accounts.find(a => a.id === activeAccId) || {};
    var accLabel = accObj.name + (accObj.step ? ' — ' + accObj.step : '');
    overviewNav.innerHTML =
      '<button class="back-btn" id="btnBack">' +
      '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>' +
      'Accounts</button>' +
      '<span class="account-label" style="margin-left:8px">' + accLabel + '</span>';
    overviewNav.style.display = 'flex';
    overviewNav.style.alignItems = 'center';
    document.getElementById('btnBack').addEventListener('click', () => {
      activeAccId = null; trades = [];
      showScreen('overview');
    });
    // reset to dashboard tab
    switchTab('dashboard');
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tabId));
  if (tabId === 'dashboard')   renderDashboard();
  if (tabId === 'trades')       renderTable();
  if (tabId === 'notes')        renderNotes();
  if (tabId === 'withdrawals')  renderWithdrawals();
}

document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

document.getElementById('logoHome').addEventListener('click', () => {
  if (activeAccId) { activeAccId = null; trades = []; showScreen('overview'); }
});

// ── Account Modal ─────────────────────────────────────────────
const accBackdrop = document.getElementById('accountModalBackdrop');

document.getElementById('btnNewAccount').addEventListener('click', () => {
  document.getElementById('fAccName').value = '';
  document.getElementById('fAccType').value = 'Instant';
  document.getElementById('fAccStep').value = 'Step 1';
  document.getElementById('fAccStepWrap').style.display = 'none';
  document.getElementById('fAccSize').value = '';
  accBackdrop.classList.remove('hidden');
});

document.getElementById('fAccType').addEventListener('change', function() {
  document.getElementById('fAccStepWrap').style.display = this.value === 'Challenge' ? 'flex' : 'none';
});
document.getElementById('btnCloseAccountModal').addEventListener('click', () => accBackdrop.classList.add('hidden'));
document.getElementById('btnCancelAccount').addEventListener('click',     () => accBackdrop.classList.add('hidden'));
accBackdrop.addEventListener('click', (e) => { if (e.target === accBackdrop) accBackdrop.classList.add('hidden'); });

document.getElementById('btnSaveAccount').addEventListener('click', () => {
  const name = document.getElementById('fAccName').value.trim();
  if (!name) { alert('Please enter an account name.'); return; }
  const type = document.getElementById('fAccType').value;
  const acc = {
    id:   uid(),
    name: name,
    type: type,
    step: type === 'Challenge' ? document.getElementById('fAccStep').value : null,
    size: parseFloat(document.getElementById('fAccSize').value) || 0,
  };
  accounts.push(acc);
  saveAccounts(accounts);
  accBackdrop.classList.add('hidden');
  renderOverview();
});

// ── Overview render ───────────────────────────────────────────
function renderOverview() {
  // destroy old mini charts
  Object.values(miniCharts).forEach(c => c.destroy());
  miniCharts = {};

  // Combined KPIs across all accounts
  const allTrades = accounts.reduce((arr, a) => arr.concat(loadTrades(a.id)), []);
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
    const t   = loadTrades(acc.id);
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
    return '<div class="account-card" data-accid="' + acc.id + '">' +
      '<div class="account-card-header">' +
        '<span class="account-name">' + acc.name + '</span>' +
        '<div style="display:flex;gap:4px;align-items:center">' +
          '<span class="account-type">' + acc.type + '</span>' +
          (acc.step ? '<span class="account-type" style="background:rgba(227,179,65,.15);color:var(--yellow)">' + acc.step + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="account-stats">' +
        '<div><div class="account-stat-label">Net P&L</div><div class="account-stat-value" style="color:' + pc + '">' + fmtMoney(s.totalPnl) + '</div></div>' +
        '<div><div class="account-stat-label">Win Rate</div><div class="account-stat-value">' + (t.length ? s.winRate + '%' : '—') + '</div></div>' +
        stat3 + stat4 +
      '</div>' +
      (t.length >= 2 ? '<div style="position:relative;height:60px;margin-top:10px"><canvas id="mini-' + acc.id + '"></canvas></div>' : '') +
      '<div class="account-card-footer">' +
        '<button class="open-btn" data-accid="' + acc.id + '">Open <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></button>' +
        '<button class="del-account-btn" data-delaccid="' + acc.id + '" title="Delete account"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>' +
      '</div>' +
    '</div>';
  }).join('');

  // Draw mini charts
  accounts.forEach(acc => {
    const t = loadTrades(acc.id);
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
    card.addEventListener('click', (e) => { if (!e.target.closest('.del-account-btn')) openAccount(card.dataset.accid); })
  );
  // Delete account
  document.querySelectorAll('.del-account-btn').forEach(btn =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.delaccid;
      const acc = accounts.find(a => a.id === id);
      if (!confirm('Delete account "' + acc.name + '" and all its trades?')) return;
      localStorage.removeItem(tradeKey(id));
      accounts = accounts.filter(a => a.id !== id);
      saveAccounts(accounts);
      renderOverview();
    })
  );
}

function openAccount(id) {
  activeAccId = id;
  trades      = loadTrades(id);
  withdrawals = loadWithdrawals(id);
  filterResult = 'all'; filterAsset = ''; sortField = 'datetime'; sortDir = 'desc'; notesFilter = 'all'; calYear = 0; calMonth = 0;
  // show/hide withdrawals tab based on account type
  var acc = accounts.find(function(a) { return a.id === id; }) || {};
  var canWithdraw = ['Funded','Live','Instant'].indexOf(acc.type) !== -1;
  document.getElementById('tabBtnWithdrawals').style.display = canWithdraw ? 'flex' : 'none';
  showScreen('account');
}

// ── Trade Modal ───────────────────────────────────────────────
const backdrop = document.getElementById('modalBackdrop');

function openModal(trade) {
  trade = trade || null;
  editId = trade ? trade.id : null;
  document.getElementById('modalTitle').textContent    = trade ? 'Edit Trade' : 'Log New Trade';
  document.getElementById('btnSubmitForm').textContent = trade ? 'Save Changes' : 'Log Trade';
  document.getElementById('fTicker').value   = trade ? trade.ticker       : 'XAUUSD';
  document.getElementById('fDatetime').value = trade ? trade.datetime     : localNow();
  document.getElementById('fPosition').value = trade ? trade.position     : 'Long';
  document.getElementById('fEntry').value    = trade ? trade.entryPrice   : '';
  document.getElementById('fExit').value     = trade ? trade.exitPrice    : '';
  document.getElementById('fSize').value     = trade ? trade.positionSize : '';
  document.getElementById('fFees').value     = trade ? trade.fees         : '0';
  document.getElementById('fTags').value     = trade ? trade.tags         : 'SMC + Price Action';
  document.getElementById('fNotes').value    = trade ? trade.notes        : '';
  currentScreenshot = (trade && trade.screenshot) ? trade.screenshot : null;
  setScreenshotPreview(currentScreenshot);
  updatePnlPreview();
  backdrop.classList.remove('hidden');
}

function closeModal() { backdrop.classList.add('hidden'); editId = null; }

document.getElementById('btnOpenForm').addEventListener('click', () => { if (activeAccId) openModal(); });
document.getElementById('btnCloseModal').addEventListener('click', closeModal);
document.getElementById('btnCancelForm').addEventListener('click', closeModal);
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

function updatePnlPreview() {
  const draft = {
    ticker: document.getElementById('fTicker').value,
    position: document.getElementById('fPosition').value,
    entryPrice: document.getElementById('fEntry').value,
    exitPrice: document.getElementById('fExit').value,
    positionSize: document.getElementById('fSize').value,
    fees: document.getElementById('fFees').value,
  };
  const pnl = calcPnl(draft);
  const el  = document.getElementById('pnlPreview');
  el.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
  el.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
}
['fTicker','fPosition','fEntry','fExit','fSize','fFees'].forEach(id =>
  document.getElementById(id).addEventListener('input', updatePnlPreview)
);

document.getElementById('btnSubmitForm').addEventListener('click', () => {
  const ticker = document.getElementById('fTicker').value.trim().toUpperCase();
  const entry  = document.getElementById('fEntry').value;
  const exit   = document.getElementById('fExit').value;
  const size   = document.getElementById('fSize').value;
  if (!ticker || !entry || !exit || !size) { alert('Please fill in Ticker, Entry, Exit, and Size.'); return; }
  const trade = {
    ticker, datetime: document.getElementById('fDatetime').value,
    position: document.getElementById('fPosition').value,
    entryPrice: entry, exitPrice: exit, positionSize: size,
    fees: document.getElementById('fFees').value || '0',
    tags: document.getElementById('fTags').value.trim(),
    notes: document.getElementById('fNotes').value.trim(),
  };
  trade.pnl = calcPnl(trade);
  if (currentScreenshot) trade.screenshot = currentScreenshot;
  if (editId) {
    trades = trades.map(t => t.id === editId ? Object.assign({}, trade, { id: editId }) : t);
  } else {
    trade.id = uid();
    trades.unshift(trade);
  }
  saveTrades(activeAccId, trades);
  closeModal();
  renderDashboard();
  renderTable();
  updateExportDesc();
});

// ── Dashboard ─────────────────────────────────────────────────
function renderDashboard() {
  renderKpis();
  renderCalendar();
  renderChart();
}

let calYear = 0, calMonth = 0;

function renderCalendar() {
  var now = new Date();
  if (!calYear)  { calYear = now.getFullYear(); calMonth = now.getMonth(); }
  var area = document.getElementById('calendarArea');
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Build daily PnL map: key = 'YYYY-MM-DD'
  var dayMap = {};
  trades.forEach(function(t) {
    var d = t.datetime ? t.datetime.slice(0, 10) : null;
    if (!d) return;
    dayMap[d] = (dayMap[d] || 0) + t.pnl;
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
  grid.innerHTML =
    kpiCard('Total P&L', '<span style="color:' + pc + '">' + fmtMoney(s.totalPnl) + '</span>', '', '#388bfd', trendIcon(s.totalPnl >= 0)) +
    kpiCard('Win Rate', s.winRate + '%', s.wins + 'W / ' + s.losses + 'L', '#26a641', targetIcon()) +
    kpiCard('Total Trades', s.total, '', '#e3b341', barIcon()) +
    (canWithdraw
      ? kpiCard('Withdrawn', '<span style="color:var(--yellow)">' + fmtMoney(totalWithdrawn) + '</span>', 'Net: <span style="color:' + (netBalance >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmtMoney(netBalance) + '</span>', '#e3b341', withdrawIcon())
      : kpiCard('Best / Worst', '<span class="green">' + fmtMoney(s.best) + '</span>', 'Worst: <span class="red">' + fmtMoney(s.worst) + '</span>', '#26a641', trendIcon(true)));
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

// ── Notes ────────────────────────────────────────────────────
let notesFilter    = 'all';
let allNotesFilter = 'all';

function renderNotes() {
  var list = trades.filter(function(t) { return t.notes && t.notes.trim(); });
  if (notesFilter === 'win')  list = list.filter(function(t) { return t.pnl > 0; });
  if (notesFilter === 'loss') list = list.filter(function(t) { return t.pnl <= 0; });
  list = list.slice().sort(function(a, b) { return new Date(b.datetime) - new Date(a.datetime); });

  document.getElementById('notesCount').textContent = list.length + ' note' + (list.length !== 1 ? 's' : '');
  var grid = document.getElementById('notesGrid');
  if (!list.length) {
    grid.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:48px;font-size:.85rem">No notes found. Add notes when logging trades.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var isWin = t.pnl > 0;
    var pnlColor = isWin ? 'var(--green)' : 'var(--red)';
    var borderCls = isWin ? 'win-border' : 'loss-border';
    var sideBadge = t.position === 'Long'
      ? '<span class="badge badge-long">Long</span>'
      : '<span class="badge badge-short">Short</span>';
    var pnlStr = (t.pnl >= 0 ? '+$' : '-$') + Math.abs(t.pnl).toFixed(2);
    var dateStr = new Date(t.datetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    html += '<div class="note-card">' +
      '<div class="note-card-header">' +
        (t.screenshot ? '<img class="thumb" src="' + t.screenshot + '" data-src="' + t.screenshot + '" style="width:44px;height:44px;flex-shrink:0" alt="chart" />' : '') +
        '<div class="note-card-meta">' +
          '<div class="note-card-title">' + t.ticker + ' &nbsp;' + sideBadge + ' &nbsp;<span style="color:' + pnlColor + ';font-size:.88rem">' + pnlStr + '</span></div>' +
          '<div class="note-card-sub">' + dateStr + (t.tags ? ' &nbsp;·&nbsp; ' + t.tags : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="note-card-body ' + borderCls + '">' + t.notes.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
      (t.screenshot ? '<img class="note-card-img" src="' + t.screenshot + '" data-src="' + t.screenshot + '" alt="screenshot" />' : '') +
    '</div>';
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.thumb, .note-card-img').forEach(function(img) {
    img.addEventListener('click', function() { openLightbox(img.dataset.src); });
  });
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
  var grid = document.getElementById('allNotesGrid');
  if (!list.length) {
    grid.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;color:var(--muted);padding:48px;font-size:.85rem">No notes found across any account.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var isWin = t.pnl > 0;
    var pnlColor = isWin ? 'var(--green)' : 'var(--red)';
    var borderCls = isWin ? 'win-border' : 'loss-border';
    var sideBadge = t.position === 'Long' ? '<span class="badge badge-long">Long</span>' : '<span class="badge badge-short">Short</span>';
    var pnlStr = (t.pnl >= 0 ? '+$' : '-$') + Math.abs(t.pnl).toFixed(2);
    var dateStr = new Date(t.datetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    html += '<div class="note-card">' +
      '<div class="note-card-header">' +
        (t.screenshot ? '<img class="thumb" src="' + t.screenshot + '" data-src="' + t.screenshot + '" style="width:44px;height:44px;flex-shrink:0" alt="chart" />' : '') +
        '<div class="note-card-meta">' +
          '<div class="note-card-title">' + t.ticker + ' &nbsp;' + sideBadge + ' &nbsp;<span style="color:' + pnlColor + ';font-size:.88rem">' + pnlStr + '</span></div>' +
          '<div class="note-card-sub">' + dateStr + ' &nbsp;&middot;&nbsp; <span style="color:var(--blue)">' + (t._accName || '') + '</span>' + (t.tags ? ' &nbsp;&middot;&nbsp; ' + t.tags : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="note-card-body ' + borderCls + '">' + t.notes.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
      (t.screenshot ? '<img class="note-card-img" src="' + t.screenshot + '" data-src="' + t.screenshot + '" alt="screenshot" />' : '') +
    '</div>';
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.thumb, .note-card-img').forEach(function(img) {
    img.addEventListener('click', function() { openLightbox(img.dataset.src); });
  });
}

document.querySelectorAll('[data-all-notes-filter]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('[data-all-notes-filter]').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    allNotesFilter = btn.dataset.allNotesFilter;
    renderAllNotes();
  });
});

// ── Withdrawals ───────────────────────────────────────────────
function renderWithdrawals() {
  var acc = accounts.find(function(a) { return a.id === activeAccId; }) || {};
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
  var rows = '';
  for (var i = 0; i < sorted.length; i++) {
    var w = sorted[i];
    var d = new Date(w.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    rows += '<tr>' +
      '<td style="color:var(--muted);font-size:.78rem">' + d + '</td>' +
      '<td class="fw7" style="color:var(--yellow)">-$' + w.amount.toFixed(2) + '</td>' +
      '<td style="color:var(--muted)">' + (w.note || '—') + '</td>' +
      '<td><button class="action-btn del" data-wid="' + w.id + '" title="Delete"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></td>' +
    '</tr>';
  }
  listEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';

  listEl.querySelectorAll('.action-btn.del').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (!confirm('Delete this withdrawal?')) return;
      withdrawals = withdrawals.filter(function(w) { return w.id !== btn.dataset.wid; });
      saveWithdrawals(activeAccId, withdrawals);
      renderWithdrawals();
      renderKpis();
    });
  });
}

var wBackdrop = document.getElementById('withdrawalModalBackdrop');
function openWithdrawalModal() {
  var today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  document.getElementById('fWDate').value   = today.toISOString().slice(0, 10);
  document.getElementById('fWAmount').value = '';
  document.getElementById('fWNote').value   = '';
  wBackdrop.classList.remove('hidden');
}
function closeWithdrawalModal() { wBackdrop.classList.add('hidden'); }
document.getElementById('btnAddWithdrawal').addEventListener('click', openWithdrawalModal);
document.getElementById('btnCloseWithdrawalModal').addEventListener('click', closeWithdrawalModal);
document.getElementById('btnCancelWithdrawal').addEventListener('click', closeWithdrawalModal);
wBackdrop.addEventListener('click', function(e) { if (e.target === wBackdrop) closeWithdrawalModal(); });
document.getElementById('btnSaveWithdrawal').addEventListener('click', function() {
  var amount = parseFloat(document.getElementById('fWAmount').value);
  var date   = document.getElementById('fWDate').value;
  if (!date || !amount || amount <= 0) { alert('Please enter a valid date and amount.'); return; }
  withdrawals.push({ id: uid(), date: date, amount: amount, note: document.getElementById('fWNote').value.trim() });
  saveWithdrawals(activeAccId, withdrawals);
  closeWithdrawalModal();
  renderWithdrawals();
  renderKpis();
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

// ── Trade Table ───────────────────────────────────────────────
function renderTable() {
  const assets = [...new Set(trades.map(t => t.ticker))].sort();
  const sel = document.getElementById('filterAsset');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All Assets</option>' +
    assets.map(a => '<option' + (a === prev ? ' selected' : '') + '>' + a + '</option>').join('');

  var list = trades.slice();
  if (filterResult === 'win')  list = list.filter(t => t.pnl > 0);
  if (filterResult === 'loss') list = list.filter(t => t.pnl <= 0);
  if (filterAsset) list = list.filter(t => t.ticker === filterAsset);
  list.sort((a, b) => {
    var av = sortField === 'datetime' ? new Date(a[sortField]) : a[sortField];
    var bv = sortField === 'datetime' ? new Date(b[sortField]) : b[sortField];
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  document.getElementById('tradeCount').textContent = list.length + ' trade' + (list.length !== 1 ? 's' : '');
  const tbody = document.getElementById('tradesTbody');
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No trades found.</td></tr>'; return; }

  var rows = '';
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var pc = t.pnl >= 0 ? 'green' : 'red';
    var sc = t.position === 'Long' ? 'badge-long' : 'badge-short';
    var tags = '';
    if (t.tags) { t.tags.split(',').forEach(function(g) { tags += '<span class="tag-chip">' + g.trim() + '</span>'; }); }
    else tags = '<span class="muted">—</span>';
    var thumb = t.screenshot ? '<img class="thumb" src="' + t.screenshot + '" data-src="' + t.screenshot + '" alt="chart" />' : '<span class="muted">—</span>';
    rows += '<tr>' +
      '<td style="color:var(--muted);font-size:.78rem">' + fmtDate(t.datetime) + '</td>' +
      '<td class="fw7">' + t.ticker + '</td>' +
      '<td><span class="badge ' + sc + '">' + t.position + '</span></td>' +
      '<td>$' + parseFloat(t.entryPrice).toLocaleString() + '</td>' +
      '<td>$' + parseFloat(t.exitPrice).toLocaleString() + '</td>' +
      '<td style="color:var(--muted)">' + t.positionSize + '</td>' +
      '<td class="' + pc + ' fw7">' + (t.pnl >= 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2) + '</td>' +
      '<td class="hide-sm">' + tags + '</td>' +
      '<td class="hide-sm">' + thumb + '</td>' +
      '<td><div class="action-btns">' +
        '<button class="action-btn edit" data-id="' + t.id + '" title="Edit"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
        '<button class="action-btn del" data-id="' + t.id + '" title="Delete"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/></svg></button>' +
      '</div></td></tr>';
  }
  tbody.innerHTML = rows;
}

document.getElementById('tradesTbody').addEventListener('click', (e) => {
  const thumb   = e.target.closest('.thumb');
  const editBtn = e.target.closest('.action-btn.edit');
  const delBtn  = e.target.closest('.action-btn.del');
  if (thumb)   { openLightbox(thumb.dataset.src); return; }
  if (editBtn) { var tr = trades.find(t => t.id === editBtn.dataset.id); if (tr) openModal(tr); }
  if (delBtn)  {
    if (!confirm('Delete this trade?')) return;
    trades = trades.filter(t => t.id !== delBtn.dataset.id);
    saveTrades(activeAccId, trades);
    renderTable(); renderDashboard(); updateExportDesc();
  }
});

document.querySelectorAll('.filter-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterResult = btn.dataset.result;
    renderTable();
  })
);

document.getElementById('filterAsset').addEventListener('change', (e) => { filterAsset = e.target.value; renderTable(); });

document.querySelectorAll('th.sortable').forEach(th =>
  th.addEventListener('click', () => {
    const field = th.dataset.sort;
    sortDir   = sortField === field ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    sortField = field;
    document.querySelectorAll('th.sortable').forEach(h => {
      const base = h.textContent.replace(/ [↑↓↕]$/, '').trim();
      h.textContent = base + (h.dataset.sort === sortField ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕');
    });
    renderTable();
  })
);

// ── Data Manager ──────────────────────────────────────────────
function updateExportDesc() {
  document.getElementById('exportDesc').textContent = 'Download all ' + trades.length + ' trade' + (trades.length !== 1 ? 's' : '') + ' as .json';
}

function showFlash(text, type) {
  type = type || 'success';
  const el = document.getElementById('flashMsg');
  el.className = 'flash ' + type; el.textContent = text; el.style.display = 'block';
  clearTimeout(el._t); el._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

document.getElementById('btnExport').addEventListener('click', () => {
  if (!trades.length) { showFlash('No trades to export.', 'error'); return; }
  const acc  = accounts.find(a => a.id === activeAccId);
  const blob = new Blob([JSON.stringify({ account: acc, trades }, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = (acc ? acc.name.replace(/\s+/g, '-') : 'account') + '-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(url);
  showFlash('Exported ' + trades.length + ' trades.');
});

document.getElementById('btnImport').addEventListener('click', () => {
  clearConfirm = false; document.getElementById('btnClear').textContent = 'Clear';
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      const list   = Array.isArray(parsed) ? parsed : (parsed.trades || []);
      if (!Array.isArray(list)) throw new Error();
      trades = list;
      saveTrades(activeAccId, trades);
      renderDashboard(); renderTable(); updateExportDesc();
      showFlash('Imported ' + trades.length + ' trades.');
    } catch { showFlash('Invalid JSON file.', 'error'); }
  };
  r.readAsText(file); e.target.value = '';
});

document.getElementById('btnClear').addEventListener('click', () => {
  if (!clearConfirm) {
    clearConfirm = true; document.getElementById('btnClear').textContent = 'Confirm?';
    setTimeout(() => { clearConfirm = false; document.getElementById('btnClear').textContent = 'Clear'; }, 3000);
    return;
  }
  trades = []; saveTrades(activeAccId, trades); clearConfirm = false;
  document.getElementById('btnClear').textContent = 'Clear';
  renderDashboard(); renderTable(); updateExportDesc();
  showFlash('All trades cleared.', 'error');
});

// ── Init ──────────────────────────────────────────────────────
showScreen('overview');
