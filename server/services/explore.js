// explore.js — Precompute cheapest prices to popular YYC destinations.
// Runs on a weekly cron; persists lows to destination_baselines.
//
// Data source hierarchy:
//   1. Travelpayouts Data API (free, unlimited, cached) — preferred
//   2. SerpApi Google Flights (paid, live) — fallback if TP returns nothing
//
// TP is fine here because Explore baselines are weekly and "stale by hours"
// is invisible in browse mode. Live searches + alert checks stay on SerpApi.

import { searchFlights } from './flights.js';
import { getCheapestFare } from './tpData.js';
import { upsertBaseline } from '../db.js';

// Curated seed list. Themes: beach | europe | asia | us | canada | adventure
export const SEED_DESTINATIONS = [
  // ── Beach / sun (14) ──────────────────────────────────────
  { iata: 'CUN', label: 'Cancún',          theme: 'beach'  },
  { iata: 'PVR', label: 'Puerto Vallarta', theme: 'beach'  },
  { iata: 'SJD', label: 'Los Cabos',       theme: 'beach'  },
  { iata: 'CZM', label: 'Cozumel',         theme: 'beach'  },
  { iata: 'LIR', label: 'Liberia',         theme: 'beach'  },
  { iata: 'MBJ', label: 'Montego Bay',     theme: 'beach'  },
  { iata: 'HNL', label: 'Honolulu',        theme: 'beach'  },
  { iata: 'OGG', label: 'Maui',            theme: 'beach'  },
  { iata: 'KOA', label: 'Kona (Big Island)', theme: 'beach' },
  { iata: 'NAS', label: 'Nassau',          theme: 'beach'  },
  { iata: 'PUJ', label: 'Punta Cana',      theme: 'beach'  },
  { iata: 'AUA', label: 'Aruba',           theme: 'beach'  },
  { iata: 'SJU', label: 'San Juan',        theme: 'beach'  },
  { iata: 'VRA', label: 'Varadero',        theme: 'beach'  },
  { iata: 'PLS', label: 'Turks & Caicos',  theme: 'beach'  },

  // ── Europe (14) ───────────────────────────────────────────
  { iata: 'LHR', label: 'London',          theme: 'europe' },
  { iata: 'CDG', label: 'Paris',           theme: 'europe' },
  { iata: 'FCO', label: 'Rome',            theme: 'europe' },
  { iata: 'BCN', label: 'Barcelona',       theme: 'europe' },
  { iata: 'MAD', label: 'Madrid',          theme: 'europe' },
  { iata: 'AMS', label: 'Amsterdam',       theme: 'europe' },
  { iata: 'LIS', label: 'Lisbon',          theme: 'europe' },
  { iata: 'DUB', label: 'Dublin',          theme: 'europe' },
  { iata: 'EDI', label: 'Edinburgh',       theme: 'europe' },
  { iata: 'KEF', label: 'Reykjavík',       theme: 'europe' },
  { iata: 'ATH', label: 'Athens',          theme: 'europe' },
  { iata: 'FRA', label: 'Frankfurt',       theme: 'europe' },
  { iata: 'MUC', label: 'Munich',          theme: 'europe' },
  { iata: 'CPH', label: 'Copenhagen',      theme: 'europe' },
  { iata: 'PRG', label: 'Prague',          theme: 'europe' },
  { iata: 'IST', label: 'Istanbul',        theme: 'europe' },

  // ── Asia (10) ─────────────────────────────────────────────
  { iata: 'NRT', label: 'Tokyo',           theme: 'asia'   },
  { iata: 'KIX', label: 'Osaka',           theme: 'asia'   },
  { iata: 'ICN', label: 'Seoul',           theme: 'asia'   },
  { iata: 'HKG', label: 'Hong Kong',       theme: 'asia'   },
  { iata: 'TPE', label: 'Taipei',          theme: 'asia'   },
  { iata: 'BKK', label: 'Bangkok',         theme: 'asia'   },
  { iata: 'DPS', label: 'Bali',            theme: 'asia'   },
  { iata: 'SIN', label: 'Singapore',       theme: 'asia'   },
  { iata: 'KUL', label: 'Kuala Lumpur',    theme: 'asia'   },
  { iata: 'MNL', label: 'Manila',          theme: 'asia'   },
  { iata: 'SGN', label: 'Ho Chi Minh City', theme: 'asia'  },
  { iata: 'DEL', label: 'Delhi',           theme: 'asia'   },

  // ── US (13) ───────────────────────────────────────────────
  { iata: 'LAX', label: 'Los Angeles',     theme: 'us'     },
  { iata: 'SFO', label: 'San Francisco',   theme: 'us'     },
  { iata: 'LAS', label: 'Las Vegas',       theme: 'us'     },
  { iata: 'JFK', label: 'New York',        theme: 'us'     },
  { iata: 'MIA', label: 'Miami',           theme: 'us'     },
  { iata: 'MCO', label: 'Orlando',         theme: 'us'     },
  { iata: 'SEA', label: 'Seattle',         theme: 'us'     },
  { iata: 'PDX', label: 'Portland',        theme: 'us'     },
  { iata: 'BOS', label: 'Boston',          theme: 'us'     },
  { iata: 'ORD', label: 'Chicago',         theme: 'us'     },
  { iata: 'DEN', label: 'Denver',          theme: 'us'     },
  { iata: 'PHX', label: 'Phoenix',         theme: 'us'     },
  { iata: 'AUS', label: 'Austin',          theme: 'us'     },
  { iata: 'IAD', label: 'Washington DC',   theme: 'us'     },

  // ── Canada (7) ────────────────────────────────────────────
  { iata: 'YVR', label: 'Vancouver',       theme: 'canada' },
  { iata: 'YYZ', label: 'Toronto',         theme: 'canada' },
  { iata: 'YUL', label: 'Montréal',        theme: 'canada' },
  { iata: 'YOW', label: 'Ottawa',          theme: 'canada' },
  { iata: 'YHZ', label: 'Halifax',         theme: 'canada' },
  { iata: 'YWG', label: 'Winnipeg',        theme: 'canada' },
  { iata: 'YYT', label: 'St. John\'s',     theme: 'canada' },

  // ── Adventure / off-the-beaten (10) ───────────────────────
  { iata: 'SJO', label: 'San José (CR)',   theme: 'adventure' },
  { iata: 'PTY', label: 'Panama City',     theme: 'adventure' },
  { iata: 'LIM', label: 'Lima',            theme: 'adventure' },
  { iata: 'UIO', label: 'Quito',           theme: 'adventure' },
  { iata: 'BOG', label: 'Bogotá',          theme: 'adventure' },
  { iata: 'EZE', label: 'Buenos Aires',    theme: 'adventure' },
  { iata: 'CPT', label: 'Cape Town',       theme: 'adventure' },
  { iata: 'NBO', label: 'Nairobi',         theme: 'adventure' },
  { iata: 'RAK', label: 'Marrakech',       theme: 'adventure' },
  { iata: 'AKL', label: 'Auckland',        theme: 'adventure' },
  { iata: 'SYD', label: 'Sydney',          theme: 'adventure' },
  { iata: 'ZQN', label: 'Queenstown',      theme: 'adventure' },
];

/**
 * Compute the next 6 months of month+year slots from today.
 */
function nextSixMonths() {
  const slots = [];
  const today = new Date();
  for (let i = 1; i <= 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    slots.push({ month: d.getMonth() + 1, year: d.getFullYear() });
  }
  return slots;
}

/**
 * Simple fixed-concurrency worker pool. Runs `fn(item)` for each item with at
 * most `concurrency` in flight at once. Failures on one item don't stop others.
 */
async function runWithConcurrency(items, concurrency, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Sweep every destination, record the cheapest fare found in the next 6 months.
 * Runs in parallel with a small concurrency pool — SerpApi is fine with a few
 * concurrent requests, and this cuts wall-clock from minutes to seconds.
 */
export async function runExploreSweep({ destinations = SEED_DESTINATIONS, concurrency = 4 } = {}) {
  const months = nextSixMonths();
  const monthStart = months[0].month;
  const monthEnd   = months[months.length - 1].month;
  const yearStart  = months[0].year;
  const yearEnd    = months[months.length - 1].year;

  const t0 = Date.now();
  let ok = 0, fail = 0, tpHits = 0, serpHits = 0;

  await runWithConcurrency(destinations, concurrency, async (dest) => {
    try {
      let best = null;

      // Try Travelpayouts Data API first (free, unlimited).
      if (process.env.TP_API_TOKEN) {
        try {
          best = await getCheapestFare({ destination: dest.iata, months });
          if (best) tpHits++;
        } catch (tpErr) {
          console.warn(`[explore] TP Data API error for ${dest.iata}: ${tpErr.message}`);
        }
      }

      // Fallback: SerpApi live search. Only fires if TP returned nothing
      // (empty cache for that route) so we protect quota for real misses.
      if (!best) {
        const { results } = await searchFlights({
          destination: dest.iata,
          monthStart, monthEnd,
          yearStart, yearEnd,
          stops:    0,
          tripType: 'round',
        });
        const cheapest = results[0];
        if (cheapest) {
          best = {
            price:        cheapest.price,
            airline:      cheapest.airline      || null,
            departure_at: cheapest.departure_at || null,
            return_at:    cheapest.return_at    || null,
            deep_link:    cheapest.deep_link    || null,
          };
          serpHits++;
        }
      }

      if (best) {
        upsertBaseline({
          iata:         dest.iata,
          dest_label:   dest.label,
          theme:        dest.theme,
          lowest_price: Math.round(best.price),
          lowest_date:  (best.departure_at || '').slice(0, 10) || null,
          airline:      best.airline || null,
          deep_link:    best.deep_link || null,
        });
        ok++;
      } else {
        fail++;
      }
    } catch (err) {
      console.error(`[explore] ${dest.iata} failed:`, err.message);
      fail++;
    }
  });

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[explore] Sweep done — ${ok} ok (${tpHits} TP, ${serpHits} SerpApi), ${fail} failed, ${seconds}s`);
  return { ok, fail, tpHits, serpHits, seconds: Number(seconds) };
}
