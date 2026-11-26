// Outgoing email (share notifications, invitations, password links) through the admin's SMTP server.
import nodemailer from 'nodemailer';

let cached = { key: '', transport: null };

export const emailConfigured = (s) => !!(s?.host && s?.from);

function transportFor(s) {
  const key = JSON.stringify([s.host, s.port, s.secure, s.user, s.pass]);
  if (cached.key !== key) {
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: s.host,
        port: Number(s.port) || (s.secure ? 465 : 587),
        secure: !!s.secure,
        auth: s.user ? { user: s.user, pass: s.pass || '' } : undefined,
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      }),
    };
  }
  return cached.transport;
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A simple, client-friendly message: heading, optional quoted note, one button.
export function renderEmail({ heading, lines = [], quote = '', button = null, footer = '' }) {
  const text = [heading, '', ...lines, ...(quote ? ['', `“${quote}”`] : []), ...(button ? ['', `${button.label}: ${button.url}`] : []), ...(footer ? ['', footer] : [])].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f1f1d">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:28px">
    <tr><td style="font-size:13px;color:#8a8985;padding-bottom:14px">Local Notes</td></tr>
    <tr><td style="font-size:20px;font-weight:650;line-height:1.3;padding-bottom:12px">${esc(heading)}</td></tr>
    ${lines.map((l) => `<tr><td style="font-size:15px;line-height:1.55;color:#3c3b38;padding-bottom:8px">${esc(l)}</td></tr>`).join('')}
    ${quote ? `<tr><td style="padding:6px 0 12px"><div style="border-left:3px solid #d6d4cf;padding:6px 12px;color:#4a4946;font-size:15px;line-height:1.5">${esc(quote)}</div></td></tr>` : ''}
    ${button ? `<tr><td style="padding:10px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#2f6fe4;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:9px">${esc(button.label)}</a></td></tr>
    <tr><td style="font-size:12px;color:#8a8985;padding-top:10px;word-break:break-all">Or open: ${esc(button.url)}</td></tr>` : ''}
    ${footer ? `<tr><td style="font-size:12px;color:#8a8985;padding-top:18px">${esc(footer)}</td></tr>` : ''}
  </table></td></tr></table></body></html>`;
  return { text, html };
}

export async function sendEmail(settings, { to, subject, replyTo, ...content }) {
  if (!emailConfigured(settings)) throw new Error('Email isn’t set up on this server');
  const { text, html } = renderEmail(content);
  await transportFor(settings).sendMail({ from: settings.from, to, replyTo, subject, text, html });
}
