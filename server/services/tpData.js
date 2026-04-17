// tpData.js — Travelpayouts Data API client.
//
// Free, unlimited, cached prices. Perfect for background Explore sweeps
// where data that's a few hours stale is fine. Live user searches and
// per-alert price checks stay on SerpApi for freshness + deep links.
//
// Why this matters: SerpApi Developer tier is $75/mo for 5k searches.
// A weekly Explore sweep over 76 destinations × 6 months ≈ 1,800 calls/mo.
// Moving that load to TP's free API saves ~36% of SerpApi quota and fits
// us into the $25 Starter tier.

const TP_API_BASE = 'https://api.travelpayouts.com';

function token()  { return process.env.TP_API_TOKEN; }
function marker() { return process.env.TP_MARKER || '519470'; }
function origin() { return process.env.ORIGIN     || 'YYC'; }

/** Format an ISO date as DDMM for Aviasales search URLs. */
function ddmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0');
}

/** Build an Aviasales search URL — attribution flows via the Drive pixel. */
function buildAviasalesUrl(orig, depIso, dest, retIso) {
  const dep = ddmm(depIso);
  const ret = retIso ? ddmm(retIso) : '';
  return `https://www.aviasales.com/search/${orig}${dep}${dest}${ret}1?marker=${marker()}`;
}

/**
 * Get the cheapest cached round-trip fare for origin → destination across
 * the given {month, year} slots. Returns the single cheapest hit or null.
 *
 * Uses v1/prices/cheap which returns structured per-month data including
 * airline + depart/return datetimes — better than v2/prices/latest which
 * omits airline.
 */
export async function getCheapestFare({ origin: orig = origin(), destination, months }) {
  if (!token()) throw new Error('TP_API_TOKEN not set');
  if (!destination || !months?.length) return null;

  const all = [];

  for (const { year, month } of months) {
    const yyyymm = `${year}-${String(month).padStart(2, '0')}`;
    const url = new URL(`${TP_API_BASE}/v1/prices/cheap`);
    url.searchParams.set('origin',      orig);
    url.searchParams.set('destination', destination);
    url.searchParams.set('depart_date', yyyymm);
    url.searchParams.set('return_date', yyyymm);
    url.searchParams.set('currency',    'CAD');
    url.searchParams.set('token',       token());

    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        // 4xx/5xx: skip this month, don't crash the sweep
        continue;
      }
      const json = await res.json();
      const bucket = json?.data?.[destination];
      if (bucket && typeof bucket === 'object') {
        for (const entry of Object.values(bucket)) {
          if (entry?.price > 0) all.push(entry);
        }
      }
    } catch (err) {
      // Network / timeout — log and continue
      console.error(`[tpData] ${destination} ${yyyymm} error:`, err.message);
    }
  }

  if (!all.length) return null;

  all.sort((a, b) => a.price - b.price);
  const best = all[0];

  return {
    price:        best.price,
    airline:      best.airline      || null,
    departure_at: best.departure_at || null,
    return_at:    best.return_at    || null,
    deep_link:    buildAviasalesUrl(orig, best.departure_at, destination, best.return_at),
  };
}
