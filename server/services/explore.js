// explore.js — Precompute cheapest prices to popular YYC destinations.
// Runs on a weekly cron; persists lows to destination_baselines.

import { searchFlights } from './flights.js';
import { upsertBaseline } from '../db.js';

// Curated seed list. Themes: beach | europe | asia | us | canada | adventure
export const SEED_DESTINATIONS = [
  // Beach
  { iata: 'CUN', label: 'Cancún',         theme: 'beach'  },
  { iata: 'PVR', label: 'Puerto Vallarta', theme: 'beach'  },
  { iata: 'LIR', label: 'Liberia',        theme: 'beach'  },
  { iata: 'MBJ', label: 'Montego Bay',    theme: 'beach'  },
  { iata: 'HNL', label: 'Honolulu',       theme: 'beach'  },
  { iata: 'NAS', label: 'Nassau',         theme: 'beach'  },
  { iata: 'PUJ', label: 'Punta Cana',     theme: 'beach'  },

  // Europe
  { iata: 'LHR', label: 'London',         theme: 'europe' },
  { iata: 'CDG', label: 'Paris',          theme: 'europe' },
  { iata: 'FCO', label: 'Rome',           theme: 'europe' },
  { iata: 'BCN', label: 'Barcelona',      theme: 'europe' },
  { iata: 'AMS', label: 'Amsterdam',      theme: 'europe' },
  { iata: 'LIS', label: 'Lisbon',         theme: 'europe' },
  { iata: 'DUB', label: 'Dublin',         theme: 'europe' },
  { iata: 'KEF', label: 'Reykjavík',      theme: 'europe' },

  // Asia
  { iata: 'NRT', label: 'Tokyo',          theme: 'asia'   },
  { iata: 'ICN', label: 'Seoul',          theme: 'asia'   },
  { iata: 'HKG', label: 'Hong Kong',      theme: 'asia'   },
  { iata: 'BKK', label: 'Bangkok',        theme: 'asia'   },
  { iata: 'DPS', label: 'Bali',           theme: 'asia'   },
  { iata: 'SIN', label: 'Singapore',      theme: 'asia'   },

  // US
  { iata: 'LAX', label: 'Los Angeles',    theme: 'us'     },
  { iata: 'SFO', label: 'San Francisco',  theme: 'us'     },
  { iata: 'LAS', label: 'Las Vegas',      theme: 'us'     },
  { iata: 'JFK', label: 'New York',       theme: 'us'     },
  { iata: 'MIA', label: 'Miami',          theme: 'us'     },
  { iata: 'SEA', label: 'Seattle',        theme: 'us'     },
  { iata: 'BOS', label: 'Boston',         theme: 'us'     },
  { iata: 'ORD', label: 'Chicago',        theme: 'us'     },

  // Canada
  { iata: 'YVR', label: 'Vancouver',      theme: 'canada' },
  { iata: 'YYZ', label: 'Toronto',        theme: 'canada' },
  { iata: 'YUL', label: 'Montréal',       theme: 'canada' },
  { iata: 'YHZ', label: 'Halifax',        theme: 'canada' },

  // Adventure / other
  { iata: 'SJO', label: 'San José (CR)',  theme: 'adventure' },
  { iata: 'CPT', label: 'Cape Town',      theme: 'adventure' },
  { iata: 'LIM', label: 'Lima',           theme: 'adventure' },
  { iata: 'AKL', label: 'Auckland',       theme: 'adventure' },
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
 * Sweep every destination, record the cheapest fare found in the next 6 months.
 * Intended to be called weekly (configurable). Designed to be tolerant of API
 * failures on individual destinations.
 */
export async function runExploreSweep({ destinations = SEED_DESTINATIONS, concurrency = 2 } = {}) {
  const months = nextSixMonths();
  const monthStart = months[0].month;
  const monthEnd   = months[months.length - 1].month;
  const yearStart  = months[0].year;
  const yearEnd    = months[months.length - 1].year;

  let ok = 0, fail = 0;

  for (const dest of destinations) {
    try {
      const { results } = await searchFlights({
        destination: dest.iata,
        monthStart, monthEnd,
        yearStart, yearEnd,
        stops:    0,
        tripType: 'round',
      });
      const cheapest = results[0];
      if (cheapest) {
        upsertBaseline({
          iata:         dest.iata,
          dest_label:   dest.label,
          theme:        dest.theme,
          lowest_price: Math.round(cheapest.price),
          lowest_date:  (cheapest.departure_at || '').slice(0, 10) || null,
          airline:      cheapest.airline || null,
          deep_link:    cheapest.deep_link || null,
        });
        ok++;
      } else {
        fail++;
      }
    } catch (err) {
      console.error(`[explore] ${dest.iata} failed:`, err.message);
      fail++;
    }
  }

  console.log(`[explore] Sweep done — ${ok} ok, ${fail} skipped/failed`);
  return { ok, fail };
}
