// SerpApi — Google Flights engine
// Docs: https://serpapi.com/google-flights-api

const SERPAPI_BASE = 'https://serpapi.com/search.json';

// Travelpayouts public airport list — no auth required, used for autocomplete
const AIRPORT_LIST_URL = 'https://api.travelpayouts.com/data/en/airports.json';

function apiKey() {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY must be set in .env');
  return key;
}

/** Format a Date as YYYY-MM-DD (Google Flights date format). */
function fmtDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Build candidate departure dates for a month range.
 * Returns the first Monday of each month in [monthStart, monthEnd],
 * skipping any dates in the past.
 */
function candidateDates(monthStart, monthEnd) {
  const today = new Date();
  const year  = today.getFullYear();
  const dates = [];

  const months = [];
  if (monthStart <= monthEnd) {
    for (let m = monthStart; m <= monthEnd; m++) months.push(m);
  } else {
    // Range wraps year boundary (e.g. Nov–Feb)
    for (let m = monthStart; m <= 12; m++) months.push(m);
    for (let m = 1; m <= monthEnd; m++) months.push(m);
  }

  for (const m of months) {
    const candidateYear = m <= today.getMonth() + 1 ? year + 1 : year;
    const date = firstMondayOfMonth(candidateYear, m);
    if (date > today) dates.push(fmtDate(date));
  }

  return dates;
}

function firstMondayOfMonth(year, month) {
  const d = new Date(year, month - 1, 1);
  const dow = d.getDay(); // 0=Sun … 6=Sat
  const daysToMonday = dow === 1 ? 0 : (8 - dow) % 7;
  d.setDate(1 + daysToMonday);
  return d;
}

/**
 * Search cheapest round-trip flights from YYC → destination across a month range.
 * Queries the first Monday of each month; returns sorted by price ascending.
 * Each result: { price, currency, departure_at, return_at, airline, deep_link, raw_json }
 */
export async function searchFlights({ destination, monthStart = 1, monthEnd = 12, stops = 0, tripType = 'round' }) {
  const origin      = process.env.ORIGIN || 'YYC';
  const departures  = candidateDates(monthStart, monthEnd);

  if (departures.length === 0) {
    console.warn('[flights] All candidate dates are in the past — nothing to search');
    return [];
  }

  const isOneWay = tripType === 'oneway';
  const allOffers = [];

  for (const departureDate of departures) {
    const returnDate = fmtDate(
      new Date(new Date(departureDate).getTime() + 7 * 86_400_000)
    );

    const params = new URLSearchParams({
      engine:        'google_flights',
      departure_id:  origin,
      arrival_id:    destination,
      outbound_date: departureDate,
      type:          isOneWay ? '2' : '1',  // 1=round-trip, 2=one-way
      currency:      'CAD',
      hl:            'en',
      api_key:       apiKey(),
    });

    // Only add return_date for round trips
    if (!isOneWay) params.set('return_date', returnDate);

    // stops: 0=any (omit), 1=nonstop, 2=≤1stop, 3=≤2stops
    if (stops > 0) params.set('stops', String(stops));

    try {
      const res = await fetch(`${SERPAPI_BASE}?${params}`);
      if (!res.ok) {
        const msg = await res.text();
        console.warn(`[flights] SerpApi ${res.status} for ${departureDate}: ${msg.slice(0, 120)}`);
        continue;
      }

      const json    = await res.json();
      const flights = [
        ...(json.best_flights   || []),
        ...(json.other_flights  || []),
      ];

      // The search_metadata.google_flights_url is the live Google Flights page for this search
      const googleUrl = json.search_metadata?.google_flights_url ?? null;

      for (const f of flights) {
        const price       = f.price;
        const firstFlight = f.flights?.[0];
        if (!price || !firstFlight) continue;

        // Inbound leg departure time (return journey, first segment)
        const returnFlight = f.layovers
          ? null
          : f.flights?.at(-1);  // best approximation when no layover info

        allOffers.push({
          price,
          currency:     'CAD',
          departure_at: firstFlight.departure_airport?.time ?? departureDate,
          return_at:    returnDate,
          airline:      firstFlight.airline ?? '',
          deep_link:    googleUrl,
          raw_json:     JSON.stringify(f),
        });
      }
    } catch (err) {
      console.warn(`[flights] Error searching ${origin}→${destination} on ${departureDate}:`, err.message);
    }
  }

  return allOffers.sort((a, b) => a.price - b.price);
}

// ---------------------------------------------------------------------------
// Airport autocomplete — free public Travelpayouts data (no key needed)
// Joins airports + cities so searching "rome" finds FCO/CIA correctly.
// ---------------------------------------------------------------------------

const CITIES_URL = 'https://api.travelpayouts.com/data/en/cities.json';

let _cache = null;

async function loadData() {
  if (_cache) return _cache;
  try {
    const [airportsRes, citiesRes] = await Promise.all([
      fetch(AIRPORT_LIST_URL),
      fetch(CITIES_URL),
    ]);
    const airports = airportsRes.ok ? await airportsRes.json() : [];
    const cities   = citiesRes.ok  ? await citiesRes.json()   : [];

    // Build city_code → city name + country lookup
    const cityMap = new Map();
    for (const c of cities) {
      cityMap.set(c.code, { name: c.name, countryCode: c.country_code });
    }

    // Only keep actual flightable airports (exclude railway/bus stations)
    const enriched = airports
      .filter(a => a.flightable && a.iata_type === 'airport')
      .map(a => {
        const city = cityMap.get(a.city_code);
        return {
          ...a,
          cityName:    city?.name        || a.name,
          countryCode: city?.countryCode || a.country_code || '',
        };
      });

    _cache = enriched;
    return enriched;
  } catch {
    return [];
  }
}

/**
 * Search airports by city name, IATA code, or airport name.
 * Returns array of { iata, name, cityName, countryCode, label }.
 */
export async function searchDestinations(keyword) {
  if (!keyword || keyword.length < 2) return [];

  const airports = await loadData();
  const kw       = keyword.toLowerCase();

  // Word-boundary regex prevents "aerodrome" matching "rome"
  const wordBoundary = new RegExp(
    `\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'
  );

  return airports
    .filter(a =>
      a.code?.toLowerCase().startsWith(kw)            ||  // IATA exact: FCO
      a.cityName?.toLowerCase().includes(kw)          ||  // city name: "Rome"
      wordBoundary.test(a.name || '')                     // name at word boundary (not "aerodrome")
    )
    .sort((a, b) => {
      // Rank: city starts-with > city contains > name only
      const aC = (a.cityName || '').toLowerCase();
      const bC = (b.cityName || '').toLowerCase();
      return (aC.startsWith(kw) ? 0 : 1) - (bC.startsWith(kw) ? 0 : 1);
    })
    .slice(0, 10)
    .map(a => ({
      iata:        a.code,
      name:        a.name,
      cityName:    a.cityName,
      countryCode: a.countryCode,
      label:       `${a.cityName}, ${a.countryCode} (${a.code})`,
    }));
}
