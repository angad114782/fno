// Telegram alerts (optional). Token/chat id na ho to silently skip.
const config = require('../config/env');

const enabled = () => Boolean(config.telegram.token && config.telegram.chatId);

async function sendTelegram(text) {
  if (!enabled()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegram.chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('Telegram error:', res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error('Telegram error:', err.message);
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

module.exports = { enabled, sendTelegram, tradeCreatedMsg, eventMsg, summaryMsg, inr };
