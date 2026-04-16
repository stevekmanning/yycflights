// affiliate.js — Travelpayouts link builders.
//
// Attribution strategy: the Drive pixel in index.html fires on every page
// view, dropping a cookie that matches the user to our TP marker. Any click
// from our site to a TP-partner domain (GetYourGuide, Booking, Hotellook,
// Aviasales, WayAway, Kiwi.com, Trip.com, etc.) is auto-attributed within
// the cookie window (typically 30 days).
//
// For tighter attribution on browsers that block third-party cookies
// (Safari ITP, Firefox ETP), we'll layer tp.media signed redirects in
// Commit E. For now, direct partner URLs + Drive pixel = commissionable.

export const TP_MARKER = process.env.TP_MARKER || '519470';

/** City-level tour search on GetYourGuide. Highest-commission partner. */
export function tourLink(city) {
  if (!city) return null;
  const q = encodeURIComponent(city);
  return `https://www.getyourguide.com/s/?q=${q}&partner_id=${TP_MARKER}`;
}

/** City-level hotel search on Hotellook (metasearch; Booking included). */
export function hotelLink(city, checkIn, checkOut) {
  if (!city) return null;
  const q = encodeURIComponent(city);
  const params = new URLSearchParams({
    destination: q,
    marker: TP_MARKER,
  });
  if (checkIn)  params.set('checkIn',  checkIn);
  if (checkOut) params.set('checkOut', checkOut);
  return `https://search.hotellook.com/?${params.toString()}`;
}

/**
 * Wrap any flight-booking URL through tp.media so the click routes through
 * Travelpayouts' click-tracking redirector. Used in Commit E for the
 * "Book now" button. Falls back to the raw URL if marker is missing.
 */
export function wrapFlightLink(rawUrl) {
  if (!rawUrl) return null;
  if (!TP_MARKER) return rawUrl;
  const encoded = encodeURIComponent(rawUrl);
  return `https://tp.media/r?marker=${TP_MARKER}&u=${encoded}`;
}

/**
 * Airport-to-hotel transfer via Kiwitaxi (50% rev-share — highest on network).
 * Kiwitaxi takes `from` (airport IATA) and resolves destination at their end.
 * Fires at peak intent in the alert email once the user has dates.
 */
export function transferLink(destIata) {
  if (!destIata) return null;
  const params = new URLSearchParams({
    marker: TP_MARKER,
    from:   destIata,
  });
  return `https://kiwitaxi.com/?${params.toString()}`;
}

/** Travel insurance quote for a trip window via EKTA. ~$10-20/policy. */
export function insuranceLink(destLabel, depDate, retDate) {
  const params = new URLSearchParams({ marker: TP_MARKER });
  if (destLabel) params.set('destination', destLabel);
  if (depDate)   params.set('start_date',  depDate);
  if (retDate)   params.set('end_date',    retDate);
  return `https://ekta.io/?${params.toString()}`;
}

/** Country/destination eSIM via Airalo. ~10% rev-share, $2-8/sale. */
export function esimLink(destLabel) {
  const params = new URLSearchParams({ marker: TP_MARKER });
  if (destLabel) params.set('q', destLabel);
  return `https://www.airalo.com/?${params.toString()}`;
}
