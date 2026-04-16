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
 * Get the first Monday on or after a given date.
 */
function firstMondayOnOrAfter(date) {
  const d   = new Date(date);
  const dow = d.getDay();
  const add = dow === 1 ? 0 : (8 - dow) % 7;
  d.setDate(d.getDate() + add);
  return d;
}

/**
 * Build candidate departure dates: 3 per month (early / mid / late),
 * all landing on Mondays for consistent pricing. Skips past dates.
 * yearStart/yearEnd: explicit years (optional — auto-calculated if omitted).
 */
function candidateDates(monthStart, monthEnd, yearStart = null, yearEnd = null) {
  const today = new Date();
  const curYear = today.getFullYear();
  const dates = [];

  // Build list of { month, year } pairs
  const slots = [];
  if (monthStart <= monthEnd) {
    for (let m = monthStart; m <= monthEnd; m++) {
      const y = yearStart
        ? (m >= monthStart ? yearStart : yearStart + 1)
        : (m < today.getMonth() + 1 ? curYear + 1 : curYear);
      slots.push({ m, y });
    }
  } else {
    // Wrapping (e.g. Nov → Feb)
    for (let m = monthStart; m <= 12; m++) slots.push({ m, y: yearStart || curYear });
    for (let m = 1; m <= monthEnd; m++) slots.push({ m, y: yearEnd || curYear + 1 });
  }

  for (const { m, y } of slots) {
    // Early (day 1), mid (day 13), late (day 20)
    const seeds = [new Date(y, m - 1, 1), new Date(y, m - 1, 13), new Date(y, m - 1, 20)];
    for (const seed of seeds) {
      const d = firstMondayOnOrAfter(seed);
      const str = fmtDate(d);
      if (d > today && !dates.includes(str)) dates.push(str);
    }
  }

  return dates;
}

/**
 * Search cheapest round-trip flights from YYC → destination across a month range.
 * Queries the first Monday of each month; returns sorted by price ascending.
 * Each result: { price, currency, departure_at, return_at, airline, deep_link, raw_json }
 */
export async function searchFlights({ destination, monthStart = 1, monthEnd = 12, yearStart = null, yearEnd = null, stops = 0, tripType = 'round' }) {
  const origin      = process.env.ORIGIN || 'YYC';
  const departures  = candidateDates(monthStart, monthEnd, yearStart, yearEnd);

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

/**
 * Fetch Google Flights price_insights for a specific route + departure date.
 * Returns: { lowest_price, price_level, typical_price_range, price_history }
 * price_history: [[unix_seconds, price_cad], ...] — ~60 days of history
 */
export async function fetchPriceInsights({ destination, date, tripType = 'round' }) {
  const origin   = process.env.ORIGIN || 'YYC';
  const isOneWay = tripType === 'oneway';

  const params = new URLSearchParams({
    engine:        'google_flights',
    departure_id:  origin,
    arrival_id:    destination,
    outbound_date: date,
    type:          isOneWay ? '2' : '1',
    currency:      'CAD',
    hl:            'en',
    api_key:       apiKey(),
  });

  if (!isOneWay) {
    const returnDate = fmtDate(new Date(new Date(date).getTime() + 7 * 86_400_000));
    params.set('return_date', returnDate);
  }

  const res  = await fetch(`${SERPAPI_BASE}?${params}`);
  if (!res.ok) throw new Error(`SerpApi ${res.status}`);
  const json = await res.json();
  return json.price_insights || null;
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
