import { randomBytes } from 'crypto';
import { Resend } from 'resend';
import {
  getWeeklyTopDeals,
  getDigestRecipients,
  getAlertsForEmail,
  upsertDigestToken,
} from '../db.js';

const resend   = new Resend(process.env.RESEND_API_KEY);
const FROM     = process.env.ALERT_FROM || 'onboarding@resend.dev';
const BASE_URL = process.env.BASE_URL   || 'https://yycflights.ca';

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];

function token() { return randomBytes(20).toString('hex'); }
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-CA', { month:'short', day:'numeric', year:'numeric' });
}
function monthRange(s, e) {
  return s === e ? SHORT_MONTHS[s-1] : `${SHORT_MONTHS[s-1]}–${SHORT_MONTHS[e-1]}`;
}

function topDealsSection(deals) {
  const rows = deals.map(d => {
    const dep  = fmtDate(d.departure_at);
    const ret  = d.return_at ? fmtDate(d.return_at) : 'One-way';
    const link = d.deep_link || 'https://www.google.com/travel/flights';
    return `<tr>
      <td style="padding:14px 16px;border-bottom:1px solid #2e3250;">
        <div style="font-size:1rem;font-weight:700;color:#e2e8f0;">YYC → ${d.dest_label}</div>
        <div style="font-size:.78rem;color:#64748b;margin-top:3px;">
          ${d.airline || 'Various'} · Departs ${dep}${d.return_at ? ' · Returns '+ret : ''}
        </div>
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #2e3250;white-space:nowrap;vertical-align:middle;">
        <span style="font-size:1.2rem;font-weight:800;color:#22c55e;">$${Math.round(d.price)} CAD</span>
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #2e3250;text-align:right;vertical-align:middle;">
        <a href="${link}" target="_blank"
           style="display:inline-block;padding:8px 16px;background:#3b82f6;color:#fff;
                  text-decoration:none;border-radius:8px;font-size:.82rem;font-weight:700;">
          Book ↗
        </a>
      </td>
    </tr>`;
  }).join('');
  return `
    <div style="background:#1a1d27;border:1px solid #2e3250;border-radius:12px;overflow:hidden;margin-bottom:20px;">
      <div style="padding:14px 16px;border-bottom:1px solid #2e3250;">
        <span style="font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;">
          🔥 Top deals spotted this week
        </span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function myAlertsSection(alerts) {
  if (!alerts.length) return '';
  const rows = alerts.map(a => {
    const price = a.latest_price;
    const best  = a.best_price;
    const hasPrice   = price != null;
    const priceColor = hasPrice && price < a.threshold ? '#22c55e'
                     : hasPrice && price < a.threshold * 1.1 ? '#f59e0b' : '#e2e8f0';
    const priceText  = hasPrice ? `$${Math.round(price)} CAD` : 'Not yet checked';
    const bestText   = best && best !== price ? `best ever $${Math.round(best)}` : '';
    return `<tr>
      <td style="padding:12px 16px;border-bottom:1px solid #2e3250;">
        <div style="font-size:.95rem;font-weight:700;color:#e2e8f0;">YYC → ${a.dest_label}</div>
        <div style="font-size:.75rem;color:#64748b;margin-top:2px;">
          ${monthRange(a.month_start, a.month_end)} · Alert below $${a.threshold} CAD
        </div>
      </td>
      <td style="padding:12px 16px;border-bottom:1px solid #2e3250;text-align:right;vertical-align:middle;white-space:nowrap;">
        <span style="font-size:1.05rem;font-weight:700;color:${priceColor};">${priceText}</span>
        ${bestText ? `<div style="font-size:.72rem;color:#64748b;">${bestText}</div>` : ''}
      </td>
    </tr>`;
  }).join('');
  return `
    <div style="background:#1a1d27;border:1px solid #2e3250;border-radius:12px;overflow:hidden;margin-bottom:20px;">
      <div style="padding:14px 16px;border-bottom:1px solid #2e3250;">
        <span style="font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;">
          📋 Your alert status
        </span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildEmail(deals, myAlerts, unsubUrl) {
  const weekOf = new Date().toLocaleDateString('en-CA', { month:'long', day:'numeric', year:'numeric' });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:2rem;margin-bottom:8px;">✈</div>
      <div style="font-size:1.4rem;font-weight:800;color:#e2e8f0;letter-spacing:-.02em;">YYC Flights</div>
      <div style="font-size:.82rem;color:#64748b;margin-top:4px;">Weekly digest · ${weekOf}</div>
    </div>
    ${topDealsSection(deals)}
    ${myAlertsSection(myAlerts)}
    <div style="text-align:center;margin-bottom:32px;">
      <a href="${BASE_URL}"
         style="display:inline-block;padding:14px 32px;background:#3b82f6;color:#fff;
                text-decoration:none;border-radius:10px;font-weight:700;font-size:.95rem;">
        Open YYC Flights →
      </a>
    </div>
    <div style="text-align:center;color:#64748b;font-size:.75rem;line-height:1.8;">
      <p style="margin:0;">You're receiving this because you have an active alert on
        <a href="${BASE_URL}" style="color:#3b82f6;text-decoration:none;">YYCFlights.ca</a></p>
      <p style="margin:0;">Deals are anonymous — no personal information is shared.</p>
      <p style="margin:8px 0 0;">
        <a href="${unsubUrl}" style="color:#64748b;text-decoration:underline;">Unsubscribe from weekly digest</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendWeeklyDigest() {
  const deals = getWeeklyTopDeals(8);
  if (!deals.length) {
    console.log('[digest] No deals found this week, skipping');
    return { sent: 0, skipped: 1, reason: 'no deals' };
  }
  const recipients = getDigestRecipients();
  if (!recipients.length) {
    console.log('[digest] No recipients');
    return { sent: 0, skipped: 1, reason: 'no recipients' };
  }

  let sent = 0, failed = 0;
  const weekLabel = new Date().toLocaleDateString('en-CA', { month:'short', day:'numeric' });

  for (const { email } of recipients) {
    const tok      = token();
    upsertDigestToken(email, tok);
    const myAlerts = getAlertsForEmail(email);
    const unsubUrl = `${BASE_URL}/api/digest/unsubscribe?token=${tok}`;
    const html     = buildEmail(deals, myAlerts, unsubUrl);
    try {
      await resend.emails.send({
        from: FROM, to: email,
        subject: `✈ Best YYC flights this week (${weekLabel})`,
        html,
      });
      sent++;
      console.log(`[digest] Sent to ${email}`);
    } catch (err) {
      failed++;
      console.error(`[digest] Failed for ${email}:`, err.message);
    }
  }

  console.log(`[digest] Complete — sent ${sent}, failed ${failed}, deals ${deals.length}`);
  return { sent, failed, dealsIncluded: deals.length };
}
