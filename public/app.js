// ── Constants ─────────────────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];

let selectedDest    = null;
let debounceTimer   = null;
let previewResults  = [];
let _clerk          = null;
let _appInitialized = false; // guard against Clerk listener firing showApp multiple times

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await initAuth();
});

async function initAuth() {
  try {
    // Clerk script is injected in <head> by the server — browser starts
    // downloading it immediately alongside CSS/JS. Just wait for it to be ready.
    const clerk = await waitForClerk();

    if (!clerk) {
      // No Clerk configured → dev mode, skip auth
      showApp({ firstName: 'Dev', email: 'dev@localhost' });
      return;
    }

    await clerk.load();
    _clerk = clerk;

    if (_clerk.user) showApp(_clerk.user);
    else             showLanding();

    _clerk.addListener(({ user }) => {
      if (user) { document.getElementById('landing').hidden = true; showApp(user); }
      else      { document.getElementById('app').hidden     = true; showLanding(); }
    });
  } catch (err) {
    console.error('Auth init failed:', err);
    document.getElementById('landing').hidden = false;
    document.getElementById('sign-in-btn').textContent = '⚠️ Error — please refresh';
  }
}

// Poll for window.Clerk (injected by server into <head>, loads async).
// Resolves quickly — usually Clerk is ready before DOMContentLoaded fires.
function waitForClerk(timeout = 6000) {
  if (window.Clerk) return Promise.resolve(window.Clerk);
  return new Promise(resolve => {
    const start = Date.now();
    const tick  = setInterval(() => {
      if (window.Clerk) { clearInterval(tick); resolve(window.Clerk); return; }
      if (Date.now() - start > timeout) { clearInterval(tick); resolve(null); }
    }, 20);
  });
}

// ── Landing ───────────────────────────────────────────────────────────────────
function showLanding() {
  document.getElementById('landing').hidden = false;
  document.getElementById('app').hidden     = true;

  document.getElementById('sign-in-btn').onclick = () => {
    if (_clerk) _clerk.openSignIn();
  };
}

// ── App ───────────────────────────────────────────────────────────────────────
function showApp(user) {
  document.getElementById('landing').hidden = true;
  document.getElementById('app').hidden     = false;

  // Always update the user avatar (safe to call repeatedly)
  const initials = user.firstName
    ? user.firstName[0].toUpperCase()
    : (user.primaryEmailAddress?.emailAddress?.[0] || user.email?.[0] || '?').toUpperCase();
  document.getElementById('user-initials').textContent = initials;
  document.getElementById('user-btn').onclick = async () => {
    if (_clerk) await _clerk.signOut();
  };

  // Guard: only set up event listeners and intervals once.
  // Clerk's addListener fires on every auth state change (token refresh, etc.)
  // which would stack duplicate submit listeners → duplicate alert creation.
  if (_appInitialized) return;
  _appInitialized = true;

  populateMonthSelects();
  setupBookByPicker();
  setupTargetDatePicker();
  setupDateModeToggle();
  setupAlertModeToggle();
  setupPreviewViewToggle();
  setupTabs();
  loadAlerts();
  setupForm();
  setupDrawer();
  setupHowDrawer();

  setInterval(loadAlerts, 120_000);
}

// ── Tabs (Alerts | Explore) ───────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.top-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.top-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('tab-alerts').hidden  = tab !== 'alerts';
      document.getElementById('tab-explore').hidden = tab !== 'explore';
      if (tab === 'explore') loadExplore();
    });
  });
}

// ── Target-date picker ───────────────────────────────────────────────────────
function setupTargetDatePicker() {
  const input = document.getElementById('target-date');
  const btn   = document.getElementById('target-date-btn');
  const label = document.getElementById('target-date-label');

  // Default min = today
  input.min = new Date().toISOString().slice(0, 10);

  btn.addEventListener('click', () => {
    try { input.showPicker(); } catch { input.click(); }
  });

  input.addEventListener('change', () => {
    if (input.value) {
      label.textContent = formatDate(input.value);
      if (selectedDest) setTimeout(fetchPreview, 200);
    } else {
      label.textContent = 'Pick target date';
    }
  });
}

// ── Date mode toggle (target vs window) ───────────────────────────────────────
function setupDateModeToggle() {
  setupToggleGroup('date-mode-group', 'date-mode', (val) => {
    document.getElementById('target-date-wrap').hidden = val !== 'target';
    document.getElementById('window-wrap').hidden      = val !== 'window';
    if (selectedDest) setTimeout(fetchPreview, 200);
  });
  setupToggleGroup('flex-group', 'flex-days', () => { if (selectedDest) setTimeout(fetchPreview, 200); });
}

// ── Alert mode toggle (threshold vs deal watcher) ─────────────────────────────
function setupAlertModeToggle() {
  setupToggleGroup('mode-group', 'alert-mode', (val) => {
    document.getElementById('threshold-wrap').hidden    = val !== 'threshold';
    document.getElementById('deal-watcher-wrap').hidden = val !== 'deal';
    document.getElementById('threshold').required       = val === 'threshold';
  });
  // Default: threshold required
  document.getElementById('threshold').required = true;
}

// ── Preview view toggle (list vs calendar) ────────────────────────────────────
let _calendarLoaded = false;
function setupPreviewViewToggle() {
  const buttons = document.querySelectorAll('.preview-view-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.getElementById('preview-list').hidden     = view !== 'list';
      document.getElementById('preview-calendar').hidden = view !== 'calendar';
      if (view === 'calendar' && !_calendarLoaded && selectedDest) loadCalendarView();
    });
  });
}

// ── Month selects ─────────────────────────────────────────────────────────────
function populateMonthSelects() {
  const startEl     = document.getElementById('month-start');
  const endEl       = document.getElementById('month-end');
  const yearStartEl = document.getElementById('year-start');
  const yearEndEl   = document.getElementById('year-end');

  MONTHS.forEach((m, i) => {
    startEl.add(new Option(m, i + 1));
    endEl.add(new Option(m, i + 1));
  });

  // Offer current year + next 2 years
  const curYear = new Date().getFullYear();
  for (let y = curYear; y <= curYear + 2; y++) {
    yearStartEl.add(new Option(y, y));
    yearEndEl.add(new Option(y, y));
  }

  // Defaults: June → August of next reasonable year
  const now    = new Date();
  const defYear = now.getMonth() >= 5 ? curYear + 1 : curYear; // if past June, default to next year
  startEl.value     = 6;
  endEl.value       = 8;
  yearStartEl.value = defYear;
  yearEndEl.value   = defYear;
}

// ── Book-by calendar picker ───────────────────────────────────────────────────
function setupBookByPicker() {
  const input    = document.getElementById('book-by');
  const btn      = document.getElementById('book-by-btn');
  const clearBtn = document.getElementById('book-by-clear');
  const label    = document.getElementById('book-by-label');

  btn.addEventListener('click', () => {
    try { input.showPicker(); } catch { input.click(); }
  });

  input.addEventListener('change', () => {
    if (input.value) {
      label.textContent   = formatDate(input.value);
      clearBtn.hidden     = false;
    } else {
      label.textContent   = 'No deadline';
      clearBtn.hidden     = true;
    }
  });

  clearBtn.addEventListener('click', () => {
    input.value         = '';
    label.textContent   = 'No deadline';
    clearBtn.hidden     = true;
  });
}

// ── Alerts ────────────────────────────────────────────────────────────────────
const ALERT_LIMIT = 5;

async function loadAlerts() {
  const grid = document.getElementById('alerts-grid');
  try {
    const alerts = await api('/api/alerts');

    const activeCount = alerts.filter(a => a.active !== 0).length;

    // Update section heading with count
    const heading = document.querySelector('#alerts-section h2');
    if (heading) {
      heading.innerHTML = activeCount
        ? `Your alerts <span class="alert-count">${activeCount} / ${ALERT_LIMIT}</span>`
        : 'Your alerts';
    }

    // Show/hide limit warning banner
    let banner = document.getElementById('alert-limit-banner');
    if (activeCount >= ALERT_LIMIT) {
      if (!banner) {
        banner = document.createElement('p');
        banner.id = 'alert-limit-banner';
        banner.className = 'alert-limit-msg';
        grid.parentElement.insertBefore(banner, grid);
      }
      banner.textContent = '⚠️ You\'ve reached the 5-alert limit. Delete an alert to add a new one.';
    } else {
      banner?.remove();
    }

    if (!alerts.length) {
      grid.innerHTML = '<p class="muted empty-msg">No alerts yet — add one above.</p>';
      return;
    }
    grid.innerHTML = '';
    alerts.forEach(a => grid.appendChild(buildAlertCard(a)));
  } catch (err) {
    grid.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function buildAlertCard(alert) {
  const price     = alert.latest_price;
  const bestPrice = alert.best_price;
  const threshold = alert.threshold;
  const hasPrice  = price != null;

  let priceClass = 'price-unknown';
  if (hasPrice) {
    if (price < threshold)            priceClass = 'price-below';
    else if (price < threshold * 1.1) priceClass = 'price-near';
    else                               priceClass = 'price-above';
  }

  const priceDisplay = hasPrice
    ? `<span class="price-display ${priceClass}">$${price.toFixed(0)}</span><span class="muted"> CAD</span>`
    : `<span class="price-display price-unknown">Not yet checked</span>`;


  const STOPS_LABEL = { 0: 'Any stops', 1: 'Non-stop', 2: '≤1 stop', 3: '≤2 stops' };
  const stopsLabel  = STOPS_LABEL[alert.stops ?? 0] ?? 'Any stops';
  const tripLabel   = alert.trip_type === 'oneway' ? 'One way' : 'Round trip';
  const priceLabel  = alert.taxes_included === 0 ? 'base fare' : 'all-in';
  const isDealMode  = alert.alert_mode === 'deal';
  const flexLabel   = alert.flex_days > 0 ? ` · ±${alert.flex_days}d` : '';
  const dateLabel   = alert.target_date
    ? formatDate(alert.target_date) + flexLabel
    : (alert.month_start === alert.month_end
        ? SHORT_MONTHS[alert.month_start - 1] + flexLabel
        : `${SHORT_MONTHS[alert.month_start - 1]} – ${SHORT_MONTHS[alert.month_end - 1]}${flexLabel}`);

  const isExpired = alert.active === 0;

  const card = document.createElement('div');
  card.className = isExpired ? 'alert-card alert-card--expired' : 'alert-card';
  card.dataset.id = alert.id;

  const statusBadge = isExpired
    ? `<span class="expired-badge">Expired</span>`
    : `<div class="active-badge" title="Active"></div>`;

  const deadlineRow = alert.book_by
    ? `<div class="deadline-row"><span class="deadline-badge">${isExpired ? 'Deadline passed' : 'Book by'} ${formatDate(alert.book_by)}</span></div>`
    : '';

  const actionsHtml = isExpired
    ? `<button class="btn btn-sm btn-danger delete-btn" data-id="${alert.id}">Delete</button>`
    : `
      <button class="btn btn-sm btn-ghost check-btn"    data-id="${alert.id}">Check now</button>
      <button class="btn btn-sm btn-ghost analysis-btn" data-id="${alert.id}">Analysis</button>
      <button class="btn btn-sm btn-danger delete-btn"  data-id="${alert.id}">Delete</button>
    `;

  const alertSummary = isDealMode
    ? `🔥 Deal Watcher active`
    : `Alert below $${threshold} CAD/person · ${priceLabel}`;

  card.innerHTML = `
    ${statusBadge}
    <div class="card-top">
      <div class="destination">YYC → ${alert.dest_label}</div>
      <div class="route-label">${dateLabel} · ${tripLabel} · ${stopsLabel}</div>
      <div class="route-label">${alertSummary}</div>
      ${deadlineRow}
    </div>
    <div class="card-price">
      ${priceDisplay}
      ${bestPrice && bestPrice !== price ? `<div class="threshold-label">Best ever: $${bestPrice.toFixed(0)}</div>` : ''}
      ${isExpired ? '' : `
        <div id="trend-line-${alert.id}" class="trend-line"></div>
        <div id="advice-chip-${alert.id}" class="advice-chip-wrap"></div>
        <div id="why-panel-${alert.id}"   class="why-panel-wrap"></div>
      `}
    </div>
    <div class="card-meta">
      ${alert.last_checked ? 'Checked ' + timeAgo(alert.last_checked) : 'Never checked'}
    </div>
    <div class="card-actions">
      ${actionsHtml}
    </div>
  `;

  if (!isExpired) {
    card.querySelector('.check-btn').addEventListener('click',    () => triggerCheck(alert.id));
    card.querySelector('.analysis-btn').addEventListener('click', () => openAnalysis(alert.id, alert.dest_label));
  }
  card.querySelector('.delete-btn').addEventListener('click', () => deleteAlert(alert.id));

  if (!isExpired) setTimeout(() => loadAdviceChip(alert.id), 0);
  return card;
}

async function loadAdviceChip(alertId) {
  const trendEl  = document.getElementById(`trend-line-${alertId}`);
  const adviceEl = document.getElementById(`advice-chip-${alertId}`);
  const whyEl    = document.getElementById(`why-panel-${alertId}`);
  if (!trendEl || !adviceEl) return;
  try {
    const { trend, advice, reasons = [] } = await api(`/api/alerts/${alertId}/analysis`);
    if (!trend || trend.observations < 3) { adviceEl.innerHTML = ''; return; }
    if (trend && trend.observations >= 5) {
      const arrowMap = { rising: '▲', falling: '▼', stable: '→' };
      const classMap = { rising: 'trend-rising', falling: 'trend-falling', stable: 'trend-stable' };
      trendEl.innerHTML = `
        <span class="trend-arrow ${classMap[trend.direction]}">
          ${arrowMap[trend.direction]} ${trend.direction} $${Math.abs(trend.slopePerDay)}/day
        </span>
        <span class="muted"> · ${trend.observations} check${trend.observations === 1 ? '' : 's'}</span>
      `;
    }
    const chipClass = { buy_now:'chip-buy', consider:'chip-consider', wait:'chip-wait', monitor:'chip-monitor' }[advice.action] || 'chip-monitor';
    const labelMap  = { buy_now:'Buy now', consider:'Consider', wait:'Wait', monitor:'Monitor' };
    adviceEl.innerHTML = `
      <div class="advice-inline ${chipClass}-inline">
        <span class="advice-chip ${chipClass}">${labelMap[advice.action]}</span>
        <span class="advice-inline-msg">${advice.message}</span>
        ${reasons.length ? `<button type="button" class="why-toggle" data-id="${alertId}" aria-expanded="false">Why?</button>` : ''}
      </div>
    `;

    // Build the collapsed Why panel
    if (whyEl && reasons.length) {
      whyEl.innerHTML = `
        <ul class="why-list" hidden>
          ${reasons.map(r => `
            <li class="why-item why-${r.tone}">
              <span class="why-icon">${r.icon}</span>
              <span class="why-text">${r.text}</span>
            </li>`).join('')}
        </ul>
      `;
      const toggleBtn = adviceEl.querySelector('.why-toggle');
      const listEl    = whyEl.querySelector('.why-list');
      toggleBtn?.addEventListener('click', () => {
        const open = !listEl.hidden;
        listEl.hidden = open;
        toggleBtn.setAttribute('aria-expanded', String(!open));
        toggleBtn.textContent = open ? 'Why?' : 'Hide';
      });
    }
  } catch { /* non-critical */ }
}

async function triggerCheck(id) {
  const card = document.querySelector(`.alert-card[data-id="${id}"]`);
  const btn  = card?.querySelector('.check-btn');
  if (btn) { btn.innerHTML = '<span class="spinner"></span> Checking…'; btn.disabled = true; }
  if (card) card.classList.add('loading');
  try {
    await api(`/api/alerts/${id}/check`, { method: 'POST' });
    await loadAlerts();
  } catch (err) {
    showFormError(err.message);
  }
}

async function deleteAlert(id) {
  if (!confirm('Delete this alert?')) return;
  await api(`/api/alerts/${id}`, { method: 'DELETE' });
  await loadAlerts();
}

// ── Destination autocomplete ──────────────────────────────────────────────────
const destInput   = document.getElementById('dest-input');
const destIata    = document.getElementById('dest-iata');
const destLabelEl = document.getElementById('dest-label-hidden');
const suggestions = document.getElementById('dest-suggestions');

destInput?.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = destInput.value.trim();
  if (q.length < 2) { hideSuggestions(); selectedDest = null; destIata.value = ''; updatePreviewBtn(); return; }
  debounceTimer = setTimeout(() => fetchSuggestions(q), 250);
});
destInput?.addEventListener('blur', () => setTimeout(hideSuggestions, 200));

// Re-fetch preview when month/year range changes (if dest already selected)
['month-start', 'month-end', 'year-start', 'year-end'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => {
    if (selectedDest) setTimeout(fetchPreview, 300);
  });
});

async function fetchSuggestions(q) {
  try {
    const results = await fetch(`/api/destinations/search?q=${encodeURIComponent(q)}`).then(r => r.json());
    renderSuggestions(results);
  } catch { hideSuggestions(); }
}

function renderSuggestions(items) {
  suggestions.innerHTML = '';
  if (!items.length) { hideSuggestions(); return; }
  items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item.label;
    li.addEventListener('mousedown', () => selectDest(item));
    suggestions.appendChild(li);
  });
  suggestions.hidden = false;
}

function selectDest(item) {
  selectedDest = item;
  destInput.value   = item.label;
  destIata.value    = item.iata;
  destLabelEl.value = item.cityName || item.name;
  hideSuggestions();
  updatePreviewBtn();
  // Auto-preview as soon as destination is chosen
  setTimeout(fetchPreview, 300);
}

function hideSuggestions() { suggestions.hidden = true; suggestions.innerHTML = ''; }
function updatePreviewBtn() { /* preview-btn removed; no-op */ }

// ── Preview prices ────────────────────────────────────────────────────────────
async function fetchPreview() {
  if (!selectedDest) return;
  _calendarLoaded = false; // invalidate cached calendar when inputs change
  const dateMode   = document.getElementById('date-mode').value;
  const targetDate = document.getElementById('target-date').value;
  const flexDays   = Number(document.getElementById('flex-days').value);
  const monthStart = Number(document.getElementById('month-start').value);
  const monthEnd   = Number(document.getElementById('month-end').value);
  const yearStart  = Number(document.getElementById('year-start').value);
  const yearEnd    = Number(document.getElementById('year-end').value);
  const stops      = Number(document.getElementById('stops').value);
  const tripType   = document.getElementById('trip-type').value;
  const section    = document.getElementById('preview-section');
  const list       = document.getElementById('preview-list');

  // Target mode but no date picked yet → don't hit the API
  if (dateMode === 'target' && !targetDate) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.innerHTML = '<div class="preview-loading"><span class="spinner"></span> Finding prices…</div>';

  const params = new URLSearchParams({
    dest:     selectedDest.iata,
    stops:    String(stops),
    tripType,
    flexDays: String(flexDays),
  });
  if (dateMode === 'target') {
    params.set('targetDate', targetDate);
  } else {
    params.set('monthStart', String(monthStart));
    params.set('monthEnd',   String(monthEnd));
    params.set('yearStart',  String(yearStart));
    params.set('yearEnd',    String(yearEnd));
  }

  try {
    const { results, insights } = await api(`/api/flights/search?${params}`);
    previewResults = results;
    renderPreview(results);

    // Render price insights from the search response (no second API call needed)
    const section = document.getElementById('preview-section');
    let panel = document.getElementById('price-history-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'price-history-panel';
      section.appendChild(panel);
    }
    const cheapestDate = results.length ? (results[0].departure_at?.slice(0, 10) || '') : '';
    renderInsightsPanel(panel, insights, cheapestDate);
  } catch (err) {
    list.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

// ── Calendar heatmap ──────────────────────────────────────────────────────────
async function loadCalendarView() {
  if (!selectedDest) return;
  const container = document.getElementById('preview-calendar');
  container.innerHTML = '<div class="preview-loading"><span class="spinner"></span> Building calendar…</div>';

  const dateMode   = document.getElementById('date-mode').value;
  const targetDate = document.getElementById('target-date').value;
  const monthStart = Number(document.getElementById('month-start').value);
  const yearStart  = Number(document.getElementById('year-start').value);
  const stops      = Number(document.getElementById('stops').value);
  const tripType   = document.getElementById('trip-type').value;

  // Pick month/year: target mode → derive from target date; window mode → earliest month/year
  let year  = yearStart;
  let month = monthStart;
  if (dateMode === 'target' && targetDate) {
    [year, month] = targetDate.split('-').map(Number);
  }

  try {
    const params = new URLSearchParams({
      dest: selectedDest.iata, year: String(year), month: String(month),
      stops: String(stops), tripType,
    });
    const { byDay } = await api(`/api/flights/calendar?${params}`);
    _calendarLoaded = true;
    renderCalendar(container, year, month, byDay);
  } catch (err) {
    container.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function renderCalendar(container, year, month, byDay) {
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow    = new Date(year, month - 1, 1).getDay(); // 0=Sun

  const prices = Object.values(byDay).map(r => r.price).filter(Boolean);
  if (!prices.length) {
    container.innerHTML = `<p class="muted">No calendar data — try adjusting stops or trip type.</p>`;
    return;
  }
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const mid = (lo + hi) / 2;

  const tintFor = (p) => {
    if (p <= lo * 1.08)  return 'cal-lo';     // green — within 8% of lowest
    if (p >= hi * 0.95)  return 'cal-hi';     // red   — top 5% of range
    if (p > mid)         return 'cal-warm';
    return 'cal-cool';
  };

  const pad = n => String(n).padStart(2, '0');
  const dayCells = [];
  for (let i = 0; i < firstDow; i++) dayCells.push(`<div class="cal-cell cal-empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso  = `${year}-${pad(month)}-${pad(d)}`;
    const r    = byDay[iso];
    if (r?.price) {
      const tint = tintFor(r.price);
      const link = r.deep_link || '#';
      dayCells.push(`
        <a class="cal-cell ${tint}" href="${link}" target="_blank" rel="noopener noreferrer" title="$${Math.round(r.price)} CAD · ${r.airline || '—'}">
          <span class="cal-day">${d}</span>
          <span class="cal-price">$${Math.round(r.price)}</span>
        </a>`);
    } else {
      dayCells.push(`<div class="cal-cell cal-blank"><span class="cal-day">${d}</span></div>`);
    }
  }

  container.innerHTML = `
    <div class="cal-header">
      <span class="cal-title">${MONTH_NAMES[month - 1]} ${year}</span>
      <span class="cal-legend">
        <span class="cal-swatch cal-lo"></span> Low
        <span class="cal-swatch cal-cool"></span> Typical
        <span class="cal-swatch cal-hi"></span> High
      </span>
    </div>
    <div class="cal-dow">
      <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
    </div>
    <div class="cal-grid">${dayCells.join('')}</div>
    <p class="muted cal-hint">Tap a day to book it on Google Flights. Sampled every other day.</p>
  `;
}

// ── Explore tab ───────────────────────────────────────────────────────────────
async function loadExplore() {
  const grid   = document.getElementById('explore-grid');
  const theme  = document.getElementById('explore-theme').value;
  const month  = document.getElementById('explore-month').value;
  const maxP   = document.getElementById('explore-max').value;
  grid.innerHTML = '<div class="preview-loading"><span class="spinner"></span> Loading destinations…</div>';

  const params = new URLSearchParams();
  if (theme) params.set('theme', theme);
  if (month) params.set('month', month);
  if (maxP)  params.set('maxPrice', maxP);

  try {
    const { results } = await api(`/api/explore?${params}`);
    if (!results.length) {
      grid.innerHTML = `<p class="muted empty-msg">No destinations match those filters yet. The sweep runs weekly — check back soon, or loosen the filters.</p>`;
      return;
    }
    grid.innerHTML = results.map(r => {
      const THEME_ICON = { beach:'🏝', europe:'🗼', asia:'🗾', us:'🇺🇸', canada:'🍁', adventure:'🌋' };
      const icon = THEME_ICON[r.theme] || '✈';
      const date = r.lowest_date ? new Date(r.lowest_date + 'T12:00:00').toLocaleDateString('en-CA', { month:'short', day:'numeric', year:'numeric' }) : '';
      return `
        <div class="explore-card-item">
          <div class="explore-card-top">
            <span class="explore-theme">${icon}</span>
            <span class="explore-dest">YYC → ${r.dest_label}</span>
          </div>
          <div class="explore-price">$${Math.round(r.lowest_price)} <span class="explore-cad">CAD</span></div>
          <div class="explore-meta">${date}${r.airline ? ' · ' + r.airline : ''}</div>
          <div class="explore-actions">
            ${r.deep_link ? `<a class="btn btn-sm btn-ghost" href="${r.deep_link}" target="_blank" rel="noopener noreferrer">Book ↗</a>` : ''}
            <button class="btn btn-sm btn-primary explore-watch-btn" data-iata="${r.iata}" data-label="${r.dest_label}" data-date="${r.lowest_date || ''}">Watch route</button>
          </div>
        </div>
      `;
    }).join('');

    // Wire "Watch route" buttons — switch to Alerts tab, prefill form
    grid.querySelectorAll('.explore-watch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const iata  = btn.dataset.iata;
        const label = btn.dataset.label;
        const date  = btn.dataset.date;
        prefillAlertForm({ iata, label, date });
        // Switch to Alerts tab
        document.querySelector('.top-nav-btn[data-tab="alerts"]').click();
      });
    });
  } catch (err) {
    grid.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function prefillAlertForm({ iata, label, date }) {
  selectedDest = { iata, cityName: label, name: label, label: `${label} (${iata})` };
  document.getElementById('dest-input').value       = `${label} (${iata})`;
  document.getElementById('dest-iata').value        = iata;
  document.getElementById('dest-label-hidden').value = label;
  if (date) {
    document.getElementById('target-date').value = date;
    document.getElementById('target-date-label').textContent = formatDate(date);
  }
  setTimeout(fetchPreview, 200);
  // Scroll form into view
  document.getElementById('alert-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Explore filter listeners (wired once DOM is ready)
document.addEventListener('DOMContentLoaded', () => {
  ['explore-theme', 'explore-month', 'explore-max'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', loadExplore);
  });
});

function renderPreview(results) {
  const list        = document.getElementById('preview-list');
  const taxesMode   = Number(document.getElementById('taxes-included').value); // 1=all-in, 0=base
  const isBaseFare  = taxesMode === 0;

  if (!results.length) {
    list.innerHTML = '<p class="muted" style="font-size:.85rem">No flights found for this route/date range.</p>';
    return;
  }

  const modeLabel = isBaseFare
    ? '<span class="preview-mode-tag">Showing est. base fare (÷1.15)</span>'
    : '<span class="preview-mode-tag">Showing all-in price (taxes included)</span>';

  list.innerHTML = `<p class="preview-hint-top">Tap a price to set it as your alert threshold: ${modeLabel}</p>`;

  results.slice(0, 6).forEach(r => {
    // All SerpApi prices are all-in. Divide by TAX_FACTOR to estimate base fare.
    const displayPrice = isBaseFare ? r.price / TAX_FACTOR : r.price;

    const chip = document.createElement('div');
    chip.className = 'preview-chip';
    const dep = r.departure_at
      ? new Date(r.departure_at).toLocaleDateString('en-CA', { month:'short', day:'numeric' })
      : '—';
    chip.innerHTML = `
      <button type="button" class="preview-chip-select">
        <span class="preview-price">$${displayPrice.toFixed(0)} CAD</span>
        <span class="preview-meta">${dep} · ${r.airline || 'Various airlines'}</span>
      </button>
      ${r.deep_link
        ? `<a href="${r.deep_link}" target="_blank" rel="noopener noreferrer" class="preview-book-btn">Book ↗</a>`
        : ''}
    `;
    chip.querySelector('.preview-chip-select').addEventListener('click', () => {
      document.getElementById('threshold').value = displayPrice.toFixed(0);
      list.querySelectorAll('.preview-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
    });
    list.appendChild(chip);
  });
}

const TAX_FACTOR = 1.15; // approximate tax multiplier for display adjustment

function renderInsightsPanel(panel, ins, date) {
  if (!ins || !ins.price_history?.length) { panel.innerHTML = ''; return; }

  const history = ins.price_history; // [[unix_sec, price], ...]
  const prices  = history.map(h => h[1]);
  const low     = ins.typical_price_range?.[0] ?? Math.min(...prices);
  const high    = ins.typical_price_range?.[1] ?? Math.max(...prices);
  const current = prices[prices.length - 1];
  const level   = ins.price_level || 'typical';

  const levelLabel = { low: '🟢 Low', typical: '🟡 Typical', high: '🔴 High' }[level] || level;
  const levelClass = { low: 'ph-level-low', typical: 'ph-level-typical', high: 'ph-level-high' }[level] || '';

  // Gauge: position current price along low→high range
  const pct = Math.min(100, Math.max(0, ((current - low) / (high - low || 1)) * 100));

  // Build 60-day sparkline
  const chart = buildInsightsSparkline(history, low, high, current);

  const depFormatted = new Date(date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });

  panel.innerHTML = `
    <div class="ph-panel">
      <div class="ph-header">
        <div>
          <div class="ph-title">Price history · <span class="muted">departing ${depFormatted}</span></div>
          <div class="ph-level ${levelClass}">${levelLabel} — $${current} CAD is ${level} for this route</div>
        </div>
      </div>
      <div class="ph-gauge-wrap">
        <div class="ph-gauge-track">
          <div class="ph-gauge-fill" style="left:0;width:${pct}%"></div>
          <div class="ph-gauge-dot" style="left:${pct}%"></div>
        </div>
        <div class="ph-gauge-labels">
          <span class="ph-gauge-lo">$${low}</span>
          <span class="ph-gauge-hi">$${high}</span>
        </div>
        <div class="ph-gauge-hint">typical range</div>
      </div>
      <div class="ph-chart-wrap">${chart}</div>
    </div>
  `;
}

function buildInsightsSparkline(history, low, high, current) {
  const W = 480, H = 100, PX = 8, PY = 20;
  const prices = history.map(h => h[1]);
  const pad    = (Math.max(...prices) - Math.min(...prices)) * 0.18 || 15;
  const minP   = Math.min(...prices) - pad;
  const maxP   = Math.max(...prices) + pad;

  const sx = i => PX + (i / (prices.length - 1)) * (W - PX * 2);
  const sy = p => H - PY - ((p - minP) / (maxP - minP)) * (H - PY * 2);

  const pathD = prices.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(p).toFixed(1)}`).join(' ');
  const fillD = `${pathD} L${sx(prices.length-1).toFixed(1)},${(H-PY).toFixed(1)} L${PX},${(H-PY).toFixed(1)} Z`;

  // Low / high range band
  const bandTop    = sy(high).toFixed(1);
  const bandHeight = (sy(low) - sy(high)).toFixed(1);

  const lastX = sx(prices.length - 1).toFixed(1);
  const lastY = sy(current).toFixed(1);

  // Label every ~2 weeks
  const labelIdxs = [0, Math.floor(prices.length * 0.33), Math.floor(prices.length * 0.67), prices.length - 1];
  const labels = labelIdxs.map(i => {
    const ts  = history[i][0] * 1000;
    const lbl = new Date(ts).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    return `<text x="${sx(i).toFixed(1)}" y="${H}" font-size="9" fill="var(--muted)" text-anchor="middle">${lbl}</text>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" class="ph-sparkline" role="img" aria-label="60-day price history">
      <rect x="${PX}" y="${bandTop}" width="${W - PX*2}" height="${bandHeight}"
            fill="var(--accent)" opacity="0.07" rx="2"/>
      <path d="${fillD}" fill="var(--accent)" opacity="0.08"/>
      <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lastX}" cy="${lastY}" r="5" fill="var(--accent)"/>
      <circle cx="${lastX}" cy="${lastY}" r="9" fill="var(--accent)" opacity="0.2"/>
      ${labels}
    </svg>`;
}

// ── Toggle groups ─────────────────────────────────────────────────────────────
function setupToggleGroup(groupId, hiddenId, onChange) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(hiddenId).value = btn.dataset.value;
    onChange?.(btn.dataset.value);
  });
}

// ── Form ──────────────────────────────────────────────────────────────────────
function setupForm() {
  const form = document.getElementById('alert-form');
  setupToggleGroup('trip-type-group', 'trip-type', () => { if (selectedDest) setTimeout(fetchPreview, 300); });
  setupToggleGroup('stops-group',     'stops',     () => { if (selectedDest) setTimeout(fetchPreview, 300); });
  setupToggleGroup('taxes-group',     'taxes-included', () => { if (previewResults.length) renderPreview(previewResults); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideFormError();
    if (!selectedDest) { showFormError('Please select a destination from the dropdown.'); return; }

    const userEmail = _clerk?.user?.primaryEmailAddress?.emailAddress
                   || _clerk?.user?.emailAddresses?.[0]?.emailAddress
                   || 'alerts@yycflights.ca';

    const dateMode   = document.getElementById('date-mode').value;
    const targetDate = document.getElementById('target-date').value;
    const alertMode  = document.getElementById('alert-mode').value;

    if (dateMode === 'target' && !targetDate) {
      showFormError('Please pick a target date (or switch to date window mode).');
      return;
    }

    // Derive month_start/month_end from target date so backend + analysis still work
    let monthStart, monthEnd;
    if (dateMode === 'target') {
      const [, m] = targetDate.split('-').map(Number);
      monthStart = m;
      monthEnd   = m;
    } else {
      monthStart = Number(document.getElementById('month-start').value);
      monthEnd   = Number(document.getElementById('month-end').value);
    }

    const body = {
      destination: selectedDest.iata,
      dest_label:  selectedDest.cityName || selectedDest.name,
      month_start: monthStart,
      month_end:   monthEnd,
      threshold:   alertMode === 'threshold' ? Number(document.getElementById('threshold').value) : 0,
      email:       userEmail,
      book_by:        document.getElementById('book-by').value || null,
      stops:          Number(document.getElementById('stops').value),
      trip_type:      document.getElementById('trip-type').value,
      taxes_included: Number(document.getElementById('taxes-included').value),
      target_date:    dateMode === 'target' ? targetDate : null,
      flex_days:      Number(document.getElementById('flex-days').value),
      alert_mode:     alertMode,
    };

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';

    try {
      const alert = await api('/api/alerts', { method: 'POST', body });

      // Reset form
      form.reset();
      selectedDest = null;
      destIata.value = '';
      document.getElementById('preview-section').hidden = true;
      document.getElementById('trip-type').value = 'round';
      document.getElementById('stops').value = '0';
      document.getElementById('taxes-included').value = '1';
      document.getElementById('date-mode').value  = 'target';
      document.getElementById('flex-days').value  = '0';
      document.getElementById('alert-mode').value = 'threshold';
      document.getElementById('target-date').value = '';
      document.getElementById('target-date-label').textContent = 'Pick target date';
      document.getElementById('target-date-wrap').hidden = false;
      document.getElementById('window-wrap').hidden      = true;
      document.getElementById('threshold-wrap').hidden    = false;
      document.getElementById('deal-watcher-wrap').hidden = true;
      document.querySelectorAll('.toggle-group').forEach(g => {
        g.querySelectorAll('.toggle-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
      });
      document.getElementById('taxes-group')?.querySelectorAll('.toggle-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
      previewResults = [];
      _calendarLoaded = false;
      await triggerCheck(alert.id);
    } catch (err) {
      showFormError(err.message);
    } finally {
      btn.disabled  = false;
      btn.innerHTML = 'Save alert';
    }
  });
}

function showFormError(msg) { const el = document.getElementById('form-error'); el.textContent = msg; el.hidden = false; }
function hideFormError()    { document.getElementById('form-error').hidden = true; }

// ── How It Works drawer ───────────────────────────────────────────────────────
function setupHowDrawer() {
  const howDrawer = document.getElementById('how-drawer');
  document.getElementById('how-btn').addEventListener('click', () => {
    howDrawer.hidden = false;
    document.getElementById('overlay').hidden = false;
    document.body.style.overflow = 'hidden';
  });
  document.getElementById('how-drawer-close').addEventListener('click', closeHowDrawer);
}

function closeHowDrawer() {
  document.getElementById('how-drawer').hidden = true;
  // Only clear overlay if results drawer is also closed
  if (document.getElementById('results-drawer').hidden) {
    document.getElementById('overlay').hidden = true;
    document.body.style.overflow = '';
  }
}

// ── Drawer ────────────────────────────────────────────────────────────────────
function setupDrawer() {
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('overlay').addEventListener('click', () => { closeDrawer(); closeHowDrawer(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); closeHowDrawer(); } });
}

function openDrawer(title, contentHtml) {
  document.getElementById('drawer-title').textContent = title;
  document.getElementById('drawer-content').innerHTML = contentHtml;
  document.getElementById('results-drawer').hidden    = false;
  document.getElementById('overlay').hidden           = false;
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  document.getElementById('results-drawer').hidden = true;
  // Only hide overlay if how-drawer is also closed
  if (document.getElementById('how-drawer').hidden) {
    document.getElementById('overlay').hidden = true;
    document.body.style.overflow = '';
  }
}

// ── Analysis drawer ───────────────────────────────────────────────────────────
async function openAnalysis(alertId, label) {
  openDrawer(`YYC → ${label} — analysis`, '<div class="drawer-loading"><span class="spinner"></span> Loading…</div>');
  try {
    const { trend, advice, history, alert } = await api(`/api/alerts/${alertId}/analysis`);
    document.getElementById('drawer-content').innerHTML = '';
    renderAnalysis(trend, advice, history, alert);
  } catch (err) {
    document.getElementById('drawer-content').innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function renderAnalysis(trend, advice, history, alert) {
  const el = document.getElementById('drawer-content');

  const chipClass = { buy_now:'chip-buy', consider:'chip-consider', wait:'chip-wait', monitor:'chip-monitor' }[advice.action] || 'chip-monitor';
  const labelMap  = { buy_now:'🟢 Buy now', consider:'🟡 Consider', wait:'🔵 Wait', monitor:'⚪ Monitor' };
  const arrowMap  = { rising:'▲', falling:'▼', stable:'→' };
  const trendCls  = { rising:'trend-rising', falling:'trend-falling', stable:'trend-stable' };

  const adviceHtml = `
    <div class="analysis-advice ${chipClass}-bg">
      <span class="advice-chip ${chipClass}">${labelMap[advice.action]}</span>
      <p class="advice-message">${advice.message}</p>
      ${advice.detail ? `<p class="advice-detail">${advice.detail}</p>` : ''}
    </div>`;

  const chartHtml = history.length >= 2
    ? `<div class="chart-wrap">${buildSparkline(history, alert.threshold, advice)}</div>` : '';

  let statsHtml = '';
  if (trend) {
    const rows = [
      ['Trend', `<span class="trend-arrow ${trendCls[trend.direction]}">${arrowMap[trend.direction]} ${trend.direction} $${Math.abs(trend.slopePerDay)}/day</span>`],
      ['Current price', `$${trend.current} CAD`],
      ['Low / avg / high', `<span class="price-below">$${trend.min}</span> / $${trend.avg} / <span class="price-above">$${trend.max}</span>`],
      ['Your threshold', `$${alert.threshold} CAD`],
      ['Data collected', `<span class="muted">${trend.observations} days</span>`],
    ];

    if (advice.daysUntilDeadline !== null)
      rows.push(['Days to deadline', `<span class="${advice.daysUntilDeadline < 14 ? 'price-near' : ''}">${advice.daysUntilDeadline}d</span>`]);

    if (advice.projectedAtDeadline !== null) {
      const diff = advice.projectedSavings ?? 0;
      const cls  = diff > 0 ? 'price-above' : 'price-below';
      const sign = diff > 0 ? '+' : '';
      rows.push(['Projected at deadline', `<span class="${cls}">~$${advice.projectedAtDeadline}</span> <span class="muted">(${sign}$${diff})</span>`]);
    }

    if (advice.bookingWindow?.label) {
      const bwClass = { sweet_spot:'price-below', approaching:'', too_early:'muted', late:'price-near', last_minute:'price-above' }[advice.bookingWindow.status] || '';
      rows.push(['Booking window', `<span class="${bwClass}">${advice.bookingWindow.label}</span>`]);
    }

    statsHtml = `
      <div class="analysis-stats">
        ${rows.map(([label, val]) => `
          <div class="analysis-row">
            <span class="analysis-label">${label}</span>
            <span class="analysis-value">${val}</span>
          </div>`).join('')}
      </div>`;
  } else {
    statsHtml = `
      <div class="analysis-stats">
        <p class="muted" style="font-size:.875rem">
          Not enough history yet — need at least 2 check-days.<br>
          Click "Check now" to start building history.
        </p>
      </div>`;
  }

  const historyRows = history.slice().reverse().map(r =>
    `<tr><td>${r.day}</td><td class="price-cell">$${r.min_price} CAD</td></tr>`
  ).join('');

  el.innerHTML = `
    ${adviceHtml}
    ${chartHtml}
    ${statsHtml}
    ${history.length
      ? `<h3 style="margin:0 0 10px">Daily low price history</h3>
         <div class="table-scroll">
           <table class="results-table">
             <thead><tr><th>Date</th><th>Cheapest (CAD)</th></tr></thead>
             <tbody>${historyRows}</tbody>
           </table>
         </div>`
      : ''}`;
}

// ── SVG Sparkline ─────────────────────────────────────────────────────────────
function buildSparkline(history, threshold, advice) {
  const W = 480, H = 130, PX = 4, PY = 28;
  const prices  = history.map(h => h.min_price);
  const allVals = [...prices, threshold];
  if (advice?.projectedAtDeadline) allVals.push(advice.projectedAtDeadline);

  const rawMin = Math.min(...allVals);
  const rawMax = Math.max(...allVals);
  const pad    = (rawMax - rawMin) * 0.15 || 25;
  const minP   = rawMin - pad;
  const maxP   = rawMax + pad;

  const sx = i => PX + (i / (prices.length - 1)) * (W - PX * 2);
  const sy = p => H - PY - ((p - minP) / (maxP - minP)) * (H - PY * 2);

  const pathD = prices.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(p).toFixed(1)}`).join(' ');
  const fillD = `${pathD} L${sx(prices.length - 1).toFixed(1)},${(H - PY).toFixed(1)} L${PX},${(H - PY).toFixed(1)} Z`;
  const ty    = sy(threshold).toFixed(1);
  const lastX = sx(prices.length - 1).toFixed(1);
  const lastY = sy(prices[prices.length - 1]).toFixed(1);

  let projLine = '';
  if (advice?.projectedAtDeadline && advice.daysUntilDeadline > 0) {
    const projX = Math.min(sx(prices.length - 1) + (W - PX * 2) * 0.22, W - PX);
    projLine = `
      <line x1="${lastX}" y1="${lastY}" x2="${projX.toFixed(1)}" y2="${sy(advice.projectedAtDeadline).toFixed(1)}"
            stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.45"/>
      <circle cx="${projX.toFixed(1)}" cy="${sy(advice.projectedAtDeadline).toFixed(1)}" r="3"
              fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.45"/>`;
  }

  return `
    <svg viewBox="0 0 ${W} ${H}" class="sparkline-chart" role="img" aria-label="Price trend chart">
      <line x1="${PX}" y1="${ty}" x2="${W - PX}" y2="${ty}"
            stroke="var(--red)" stroke-width="1" stroke-dasharray="5,3" opacity="0.55"/>
      <text x="${W - PX - 2}" y="${ty}" dy="-4" font-size="9" fill="var(--red)"
            text-anchor="end" opacity="0.75">threshold $${threshold}</text>
      <path d="${fillD}" fill="var(--accent)" opacity="0.06"/>
      <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
      ${projLine}
      <circle cx="${lastX}" cy="${lastY}" r="7" fill="var(--accent)" opacity="0.18"/>
      <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--accent)"/>
      <text x="${PX}" y="${H}" font-size="9" fill="var(--muted)">${history[0].day.slice(5)}</text>
      <text x="${W - PX}" y="${H}" font-size="9" fill="var(--muted)" text-anchor="end">${history[history.length-1].day.slice(5)}</text>
      <text x="${PX + 2}" y="${sy(rawMax) - 4}" font-size="9" fill="var(--muted)">$${Math.round(rawMax)}</text>
      <text x="${PX + 2}" y="${sy(rawMin) + 12}" font-size="9" fill="var(--muted)">$${Math.round(rawMin)}</text>
    </svg>`;
}

// ── API helper (auto-attaches Clerk token) ────────────────────────────────────
async function api(path, opts = {}) {
  const headers = {};
  if (opts.body) headers['Content-Type'] = 'application/json';

  if (_clerk?.session) {
    const token = await _clerk.session.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res  = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body:   opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function timeAgo(iso) {
  const diff  = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function formatDate(isoDate) {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('en-CA', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}
