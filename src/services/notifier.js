// WhatsApp Cloud API alerts (optional). Token / phone number id / "to" na ho to silently skip.
// Business-initiated message ke liye approved template chahiye: har line ek body param ({{1}}..{{N}}) me jaati hai,
// aakhri param me baaki saari lines. WhatsApp param me newline/tab allowed nahi, isliye " · " se jodte hain.
const config = require('../config/env');

const wa = config.whatsapp;
const enabled = () => Boolean(wa.token && wa.phoneNumberId && wa.to.length);

// Telegram-style HTML text -> plain lines
const plainLines = (text) =>
  String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

function templateParams(text, n = wa.templateParams) {
  const lines = plainLines(text);
  const out = lines.slice(0, n - 1);
  out.push(lines.slice(n - 1).join(' · '));
  while (out.length < n) out.push('-');
  return out.map((x) => (x || '-').slice(0, 300));
}

async function sendOne(to, text) {
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: wa.template,
      language: { code: wa.language },
      components: [{ type: 'body', parameters: templateParams(text).map((t) => ({ type: 'text', text: t })) }],
    },
  };
  const res = await fetch(`https://graph.facebook.com/${wa.apiVersion}/${wa.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wa.token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('WhatsApp error:', res.status, await res.text());
  return res.ok;
}

async function send(text) {
  if (!enabled()) return false;
  try {
    const r = await Promise.all(wa.to.map((to) => sendOne(to, text)));
    return r.every(Boolean);
  } catch (err) {
    console.error('WhatsApp error:', err.message);
    return false;
  }
}

const inr = (n) => (n == null ? '-' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tradeCreatedMsg(t) {
  const emoji = t.side === 'BUY' ? '🟢' : '🔴';
  return [
    `${emoji} <b>NEW ${t.side}</b> ${esc(t.tradingSymbol)}`,
    `Qty: ${t.quantity} (${t.lots} x ${t.lotSize})`,
    `Entry: ${t.entryPrice}`,
    `SL: ${t.stopLoss ?? '-'} | TP1: ${t.target1 ?? '-'} | TP2: ${t.target2 ?? '-'}`,
    t.rrTp1 != null ? `R:R  TP1 1:${t.rrTp1}${t.rrTp2 != null ? ` | TP2 1:${t.rrTp2}` : ''}` : null,
    t.strategy ? `Strategy: ${esc(t.strategy)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

const EVENT_LABEL = {
  TP1_HIT: '🎯 TP1 HIT',
  TP2_HIT: '🎯🎯 TP2 HIT',
  SL_HIT: '🛑 SL HIT',
  TRAIL_SL_HIT: '🛡️ TRAIL SL HIT',
  EXIT: '🚪 EXIT',
};

function eventMsg(t, ev) {
  const lines = [`${EVENT_LABEL[ev.type] || ev.type} ${esc(t.tradingSymbol)} (${t.side})`];
  if (ev.exit) lines.push(`Booked ${ev.exit.quantity} @ ${ev.exit.price} → P&L ${inr(ev.exit.pnl)}`);
  if (ev.slMovedTo != null) lines.push(`SL moved to cost: ${ev.slMovedTo}`);
  if (t.status === 'CLOSED') {
    lines.push(`✅ CLOSED | Net P&L: <b>${inr(t.netPnl)}</b> (${t.result}${t.rMultiple != null ? `, ${t.rMultiple}R` : ''})`);
  } else {
    lines.push(`Open qty: ${t.openQuantity} | Realised: ${inr(t.grossPnl)}`);
  }
  return lines.join('\n');
}

function summaryMsg(title, s) {
  return [
    `📊 <b>${esc(title)}</b>`,
    `Trades: ${s.closed} closed | ${s.open + s.partial} open`,
    `Wins/Loss: ${s.wins}/${s.losses} (Win rate ${s.winRate}%)`,
    `Gross: ${inr(s.grossPnl)} | Charges: ${inr(s.charges)}`,
    `<b>Net P&L: ${inr(s.netPnl)}</b>`,
    `TP1 hit ${s.tp1HitRate}% | TP2 hit ${s.tp2HitRate}% | SL hit ${s.slHitRate}%`,
  ].join('\n');
}

module.exports = { enabled, send, templateParams, tradeCreatedMsg, eventMsg, summaryMsg, inr };
