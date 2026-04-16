import { Resend } from 'resend';
import { fmtLongDate } from './shared/dates.js';
import { tourLink, transferLink, insuranceLink, esimLink } from './lib/affiliate.js';

let _client = null;

function getClient() {
  if (!_client) _client = new Resend(process.env.RESEND_API_KEY);
  return _client;
}

export async function sendAlert({ alert, result, reason = 'threshold' }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[mailer] RESEND_API_KEY not set — skipping email for alert', alert.id);
    return;
  }

  const depFormatted = fmtLongDate(result.departure_at);
  const retFormatted = result.return_at ? fmtLongDate(result.return_at) : 'One-way';

  const from    = process.env.ALERT_FROM || 'YYC Flights <onboarding@resend.dev>';
  const isDeal  = reason === 'deal';
  const subject = isDeal
    ? `🔥 YYC → ${alert.dest_label}: $${result.price} CAD — deal detected!`
    : `✈️ YYC → ${alert.dest_label}: $${result.price} CAD found!`;

  const bookBtn = result.deep_link
    ? `<p style="margin:24px 0">
         <a href="${result.deep_link}"
            style="background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
           Book now ↗
         </a>
       </p>`
    : '';

  // Trip bundle — peak-intent upsells. Every row is an already-live
  // Travelpayouts partner. Ordered by per-click revenue (highest first):
  //   🚗 Kiwitaxi     — 50% rev-share on airport transfers
  //   🎟️ GetYourGuide — 8-12% commission on tours
  //   🛡️ EKTA         — $10-20 per insurance policy
  //   📱 Airalo       — 10% rev-share on eSIMs
  // Drive pixel handles attribution — no tp.media wrapping needed yet.
  const tourUrl      = tourLink(alert.dest_label);
  const transferUrl  = transferLink(alert.destination);
  const insuranceUrl = insuranceLink(alert.dest_label, result.departure_at, result.return_at);
  const esimUrl      = esimLink(alert.dest_label);

  const row = (emoji, url, title, sub) => `
    <tr>
      <td style="padding:10px 0;border-top:1px solid #2e3250">
        <a href="${url}" style="color:#e5a656;text-decoration:none;font-weight:600;font-size:14px">
          ${emoji} ${title} →
        </a>
        <div style="font-size:12px;color:#64748b;margin-top:2px">${sub}</div>
      </td>
    </tr>`;

  const tripBundle = `
    <div style="margin:20px 0 0;padding:16px 18px;background:#0f1117;border:1px solid #2e3250;border-radius:10px">
      <p style="margin:0 0 10px;font-size:12px;color:#94a3b8;letter-spacing:.05em;text-transform:uppercase">Complete your trip</p>
      <table style="width:100%;border-collapse:collapse">
        ${transferUrl  ? row('🚗', transferUrl,  `Airport transfer at ${alert.destination}`,     'Pre-book a ride from the airport — no haggling on arrival.') : ''}
        ${tourUrl      ? row('🎟️', tourUrl,      `Top experiences in ${alert.dest_label}`,     'Skip-the-line tickets, food tours, day trips.') : ''}
        ${insuranceUrl ? row('🛡️', insuranceUrl, `Trip insurance for ${alert.dest_label}`,     'Cancellations, medical, lost bags — from a few bucks.') : ''}
        ${esimUrl      ? row('📱', esimUrl,      `eSIM for ${alert.dest_label}`,               'Land connected — no SIM swap, no roaming fees.') : ''}
      </table>
    </div>`;

  const tourBlock = tripBundle;

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0">
      <div style="max-width:520px;margin:40px auto;background:#1a1d27;border:1px solid #2e3250;border-radius:12px;overflow:hidden">
        <div style="background:#3b82f6;padding:20px 28px">
          <p style="margin:0;font-size:13px;color:#bfdbfe;letter-spacing:.05em;text-transform:uppercase">Price alert</p>
          <h1 style="margin:4px 0 0;font-size:22px;color:#fff">YYC → ${alert.dest_label}</h1>
        </div>
        <div style="padding:28px">
          <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Price found</p>
          <p style="margin:0 0 20px;font-size:42px;font-weight:800;color:#22c55e;letter-spacing:-.03em">
            $${result.price} <span style="font-size:18px;color:#64748b;font-weight:400">CAD</span>
          </p>

          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr>
              <td style="padding:8px 0;color:#64748b;width:40%">Departs</td>
              <td style="padding:8px 0;font-weight:600">${depFormatted}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#64748b">Returns</td>
              <td style="padding:8px 0;font-weight:600">${retFormatted}</td>
            </tr>
            ${result.airline ? `
            <tr>
              <td style="padding:8px 0;color:#64748b">Airline</td>
              <td style="padding:8px 0;font-weight:600">${result.airline}</td>
            </tr>` : ''}
            ${isDeal ? `
            <tr>
              <td style="padding:8px 0;color:#64748b">Trigger</td>
              <td style="padding:8px 0;font-weight:600;color:#22c55e">🔥 Deal Watcher — unusually cheap for this route</td>
            </tr>` : `
            <tr>
              <td style="padding:8px 0;color:#64748b">Your threshold</td>
              <td style="padding:8px 0;font-weight:600">$${alert.threshold} CAD</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#64748b">Savings</td>
              <td style="padding:8px 0;font-weight:600;color:#22c55e">$${Math.round(alert.threshold - result.price)} below threshold</td>
            </tr>`}
          </table>

          ${bookBtn}
          ${tourBlock}

          <p style="margin:24px 0 0;font-size:12px;color:#64748b;border-top:1px solid #2e3250;padding-top:16px">
            YYC Flights price tracker &bull; Alert for ${alert.email}
          </p>
        </div>
      </div>
    </body>
    </html>
  `.trim();

  const { error } = await getClient().emails.send({
    from,
    to:      alert.email,
    subject,
    html,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);

  console.log(`[mailer] Alert sent to ${alert.email} for ${alert.dest_label} @ $${result.price}`);
}
