// ── Constants ─────────────────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];

let selectedDest   = null;
let debounceTimer  = null;
let previewResults = [];
let _clerk         = null;

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

  // Set user initials in header
  const initials = user.firstName
    ? user.firstName[0].toUpperCase()
    : (user.primaryEmailAddress?.emailAddress?.[0] || user.email?.[0] || '?').toUpperCase();
  document.getElementById('user-initials').textContent = initials;

  // Sign out button
  document.getElementById('user-btn').onclick = async () => {
    if (_clerk) await _clerk.signOut();
  };

  // Boot the app
  populateMonthSelects();
  setupBookByPicker();
  loadAlerts();
  setupForm();
  setupDrawer();

  setInterval(loadAlerts, 120_000);
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

    // Update section heading with count
    const heading = document.querySelector('#alerts-section h2');
    if (heading) {
      heading.innerHTML = alerts.length
        ? `Your alerts <span class="alert-count">${alerts.length} / ${ALERT_LIMIT}</span>`
        : 'Your alerts';
    }

    // Show/hide limit warning banner
    let banner = document.getElementById('alert-limit-banner');
    if (alerts.length >= ALERT_LIMIT) {
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

  const monthRange = alert.month_start === alert.month_end
    ? SHORT_MONTHS[alert.month_start - 1]
    : `${SHORT_MONTHS[alert.month_start - 1]} – ${SHORT_MONTHS[alert.month_end - 1]}`;

  const STOPS_LABEL = { 0: 'Any stops', 1: 'Non-stop', 2: '≤1 stop', 3: '≤2 stops' };
  const stopsLabel  = STOPS_LABEL[alert.stops ?? 0] ?? 'Any stops';
  const tripLabel   = alert.trip_type === 'oneway' ? 'One way' : 'Round trip';
  const priceLabel  = alert.taxes_included === 0 ? 'base fare' : 'all-in';

  const card = document.createElement('div');
  card.className = 'alert-card';
  card.dataset.id = alert.id;
  card.innerHTML = `
    <div class="active-badge" title="Active"></div>
    <div class="card-top">
      <div class="destination">YYC → ${alert.dest_label}</div>
      <div class="route-label">${monthRange} · ${tripLabel} · ${stopsLabel}</div>
      <div class="route-label">Alert below $${threshold} CAD/person · ${priceLabel}</div>
      ${alert.book_by ? `<div class="deadline-row"><span class="deadline-badge">Book by ${formatDate(alert.book_by)}</span></div>` : ''}
    </div>
    <div class="card-price">
      ${priceDisplay}
      ${bestPrice && bestPrice !== price ? `<div class="threshold-label">Best ever: $${bestPrice.toFixed(0)}</div>` : ''}
      <div id="trend-line-${alert.id}" class="trend-line"></div>
      <div id="advice-chip-${alert.id}" class="advice-chip-wrap"></div>
    </div>
    <div class="card-meta">
      ${alert.last_checked ? 'Checked ' + timeAgo(alert.last_checked) : 'Never checked'}
    </div>
    <div class="card-actions">
      <button class="btn btn-sm btn-ghost check-btn"    data-id="${alert.id}">Check now</button>
      <button class="btn btn-sm btn-ghost analysis-btn" data-id="${alert.id}">Analysis</button>
      <button class="btn btn-sm btn-danger delete-btn"  data-id="${alert.id}">Delete</button>
    </div>
  `;

  card.querySelector('.check-btn').addEventListener('click',    () => triggerCheck(alert.id));
  card.querySelector('.analysis-btn').addEventListener('click', () => openAnalysis(alert.id, alert.dest_label));
  card.querySelector('.delete-btn').addEventListener('click',   () => deleteAlert(alert.id));

  setTimeout(() => loadAdviceChip(alert.id), 0);
  return card;
}

async function loadAdviceChip(alertId) {
  const trendEl  = document.getElementById(`trend-line-${alertId}`);
  const adviceEl = document.getElementById(`advice-chip-${alertId}`);
  if (!trendEl || !adviceEl) return;
  try {
    const { trend, advice } = await api(`/api/alerts/${alertId}/analysis`);
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
      </div>
    `;
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
  const monthStart = Number(document.getElementById('month-start').value);
  const monthEnd   = Number(document.getElementById('month-end').value);
  const yearStart  = Number(document.getElementById('year-start').value);
  const yearEnd    = Number(document.getElementById('year-end').value);
  const stops      = Number(document.getElementById('stops').value);
  const tripType   = document.getElementById('trip-type').value;
  const section    = document.getElementById('preview-section');
  const list       = document.getElementById('preview-list');

  section.hidden = false;
  list.innerHTML = '<div class="preview-loading"><span class="spinner"></span> Finding prices…</div>';

  try {
    const results = await api(
      `/api/flights/search?dest=${encodeURIComponent(selectedDest.iata)}&monthStart=${monthStart}&monthEnd=${monthEnd}&yearStart=${yearStart}&yearEnd=${yearEnd}&stops=${stops}&tripType=${tripType}`
    );
    previewResults = results;
    renderPreview(results);
  } catch (err) {
    list.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function renderPreview(results) {
  const list = document.getElementById('preview-list');
  if (!results.length) {
    list.innerHTML = '<p class="muted" style="font-size:.85rem">No flights found for this route/date range.</p>';
    return;
  }
  list.innerHTML = '<p class="preview-hint-top">Tap a price to set it as your alert threshold:</p>';
  results.slice(0, 6).forEach(r => {
    const chip = document.createElement('div');
    chip.className = 'preview-chip';
    const dep = r.departure_at
      ? new Date(r.departure_at).toLocaleDateString('en-CA', { month:'short', day:'numeric' })
      : '—';
    chip.innerHTML = `
      <button type="button" class="preview-chip-select">
        <span class="preview-price">$${r.price.toFixed(0)} CAD</span>
        <span class="preview-meta">${dep} · ${r.airline || 'Various airlines'}</span>
      </button>
      ${r.deep_link
        ? `<a href="${r.deep_link}" target="_blank" rel="noopener noreferrer" class="preview-book-btn">Book ↗</a>`
        : ''}
    `;
    chip.querySelector('.preview-chip-select').addEventListener('click', () => {
      document.getElementById('threshold').value = r.price.toFixed(0);
      list.querySelectorAll('.preview-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
    });
    list.appendChild(chip);
  });
}

// ── Toggle groups ─────────────────────────────────────────────────────────────
function setupToggleGroup(groupId, hiddenId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(hiddenId).value = btn.dataset.value;
  });
}

// ── Form ──────────────────────────────────────────────────────────────────────
function setupForm() {
  const form = document.getElementById('alert-form');
  setupToggleGroup('trip-type-group', 'trip-type');
  setupToggleGroup('stops-group', 'stops');
  setupToggleGroup('taxes-group', 'taxes-included');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideFormError();
    if (!selectedDest) { showFormError('Please select a destination from the dropdown.'); return; }

    const userEmail = _clerk?.user?.primaryEmailAddress?.emailAddress
                   || _clerk?.user?.emailAddresses?.[0]?.emailAddress
                   || 'alerts@yycflights.ca';

    const body = {
      destination: selectedDest.iata,
      dest_label:  selectedDest.cityName || selectedDest.name,
      month_start: Number(document.getElementById('month-start').value),
      month_end:   Number(document.getElementById('month-end').value),
      threshold:   Number(document.getElementById('threshold').value),
      email:       userEmail,
      book_by:        document.getElementById('book-by').value || null,
      stops:          Number(document.getElementById('stops').value),
      trip_type:      document.getElementById('trip-type').value,
      taxes_included: Number(document.getElementById('taxes-included').value),
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
      document.querySelectorAll('.toggle-group').forEach(g => {
        g.querySelectorAll('.toggle-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
      });
      document.getElementById('taxes-group')?.querySelectorAll('.toggle-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
      previewResults = [];
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

// ── Drawer ────────────────────────────────────────────────────────────────────
function setupDrawer() {
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
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
  document.getElementById('overlay').hidden        = true;
  document.body.style.overflow = '';
}

// ── History drawer ────────────────────────────────────────────────────────────
async function openHistory(alertId, label) {
  openDrawer(`YYC → ${label} — history`, '<div class="drawer-loading"><span class="spinner"></span> Loading…</div>');
  try {
    const results = await api(`/api/flights/results/${alertId}`);
    document.getElementById('drawer-content').innerHTML = '';
    renderResults(results);
  } catch (err) {
    document.getElementById('drawer-content').innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function renderResults(results) {
  const el = document.getElementById('drawer-content');
  if (!results.length) {
    el.innerHTML = '<p class="muted">No results yet — click "Check now" on the alert card.</p>';
    return;
  }
  const rows = results.map(r => {
    const dep = new Date(r.departure_at).toLocaleDateString('en-CA', { month:'short', day:'numeric', year:'numeric', weekday:'short' });
    const ret = r.return_at ? new Date(r.return_at).toLocaleDateString('en-CA', { month:'short', day:'numeric' }) : '—';
    return `<tr>
      <td class="price-cell">$${r.price.toFixed(0)}</td>
      <td>${dep}</td><td>${ret}</td>
      <td>${r.airline || '—'}</td>
      <td class="muted">${timeAgo(r.found_at)}</td>
      ${r.deep_link ? `<td><a href="${r.deep_link}" target="_blank" class="book-link">Book ↗</a></td>` : '<td></td>'}
    </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="table-scroll">
      <table class="results-table">
        <thead><tr><th>Price</th><th>Departs</th><th>Returns</th><th>Airline</th><th>Found</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
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
