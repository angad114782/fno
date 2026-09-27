(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const inr = (n) =>
    n == null ? '-' : Number(n).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const fmtDate = (d) =>
    d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
  const v = (x) => (x == null ? '-' : x);

  let apiKey = '';
  try { apiKey = localStorage.getItem('fno_api_key') || ''; } catch { /* storage blocked */ }
  let instruments = [];
  let filters = {};

  function toast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    $('#toast').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      askKey();
      throw new Error('Unauthorized - API key set karo');
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const details = data && data.details ? `\n${[].concat(data.details).join('\n')}` : '';
      throw new Error(`${(data && data.error) || res.statusText}${details}`);
    }
    return data;
  }

  function askKey() {
    const k = prompt('API key (.env ka API_KEY):', apiKey);
    if (k === null) return;
    apiKey = k.trim();
    try { localStorage.setItem('fno_api_key', apiKey); } catch { /* ignore */ }
    loadAll();
  }

  const qs = (o) => {
    const p = new URLSearchParams();
    Object.entries(o).forEach(([k, val]) => val && p.set(k, val));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  // ---------- Loaders ----------
  async function loadHealth() {
    try {
      const h = await fetch('/api/health').then((r) => r.json());
      $('#dbStatus').className = `dot ${h.db === 'connected' ? 'ok' : 'bad'}`;
      $('#dbStatus').title = `DB ${h.db}`;
    } catch {
      $('#dbStatus').className = 'dot bad';
    }
  }

  async function loadInstruments() {
    instruments = await api('/instruments');
    $('#instrumentList').innerHTML = instruments
      .map((i) => `<option value="${esc(i.symbol)}">${esc(i.name || '')} · lot ${i.lotSize}</option>`)
      .join('');
    const cur = $('#filterUnderlying').value;
    $('#filterUnderlying').innerHTML =
      '<option value="">All</option>' + instruments.map((i) => `<option>${esc(i.symbol)}</option>`).join('');
    $('#filterUnderlying').value = cur;
  }

  async function loadReport() {
    const r = await api(`/reports${qs(filters)}`);
    const s = r.summary;
    const stat = (k, val, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${val}</div></div>`;
    $('#summary').innerHTML = [
      stat('Net P&L', inr(s.netPnl), cls(s.netPnl)),
      stat('Gross P&L', inr(s.grossPnl), cls(s.grossPnl)),
      stat('Charges', inr(s.charges)),
      stat('Closed / Open', `${s.closed} / ${s.open + s.partial}`),
      stat('Win Rate', `${s.winRate}%`),
      stat('W / L / BE', `${s.wins} / ${s.losses} / ${s.breakeven}`),
      stat('Avg Win', inr(s.avgWin), 'pos'),
      stat('Avg Loss', inr(s.avgLoss), 'neg'),
      stat('Profit Factor', v(s.profitFactor)),
      stat('Avg R', v(s.avgR)),
      stat('Max Drawdown', inr(s.maxDrawdown), s.maxDrawdown ? 'neg' : ''),
      stat('TP1 / TP2 / SL hit', `${s.tp1HitRate}% · ${s.tp2HitRate}% · ${s.slHitRate}%`, 'sm'),
    ].join('');

    const bt = (rows, key) =>
      `<tr><th>${key}</th><th class="num">Trades</th><th class="num">Win%</th><th class="num">Net P&L</th></tr>` +
      (rows.length
        ? rows
            .map(
              (d) =>
                `<tr><td>${esc(d[key.toLowerCase()])}</td><td class="num">${d.trades}</td><td class="num">${d.winRate}%</td><td class="num ${cls(d.netPnl)}">${inr(d.netPnl)}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="4" class="muted">No data</td></tr>');
    $('#dailyTable').innerHTML = bt([...r.daily].reverse(), 'Date');
    $('#underlyingTable').innerHTML = bt(r.byUnderlying, 'Underlying');
  }

  function levelBadges(t) {
    return [
      t.tp1Hit ? '<span class="badge hit">TP1</span>' : '',
      t.tp2Hit ? '<span class="badge hit">TP2</span>' : '',
      t.slHit ? '<span class="badge loss">SL</span>' : '',
    ].join('');
  }

  function unrealised(t) {
    if (t.lastPrice == null) return null;
    const d = t.side === 'SELL' ? -1 : 1;
    return (t.lastPrice - t.entryPrice) * t.openQuantity * d;
  }

  async function loadOpen() {
    const { items } = await api(`/trades?status=OPEN,PARTIAL&limit=500`);
    const head = `<tr><th>Symbol</th><th>Side</th><th class="num">Qty (open)</th><th class="num">Entry</th>
      <th class="num">SL</th><th class="num">TP1</th><th class="num">TP2</th><th class="num">LTP</th>
      <th class="num">Unrealised</th><th class="num">Realised</th><th>Status</th><th>Actions</th></tr>`;
    $('#openTable').innerHTML =
      head +
      (items.length
        ? items
            .map((t) => {
              const u = unrealised(t);
              return `<tr data-id="${t._id}">
          <td title="${esc(t.notes)}">${esc(t.tradingSymbol)}<br><span class="muted">${fmtDate(t.entryTime)}${t.strategy ? ' · ' + esc(t.strategy) : ''}</span></td>
          <td><span class="badge ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side}</span></td>
          <td class="num">${t.quantity} (${t.openQuantity})</td>
          <td class="num">${t.entryPrice}</td>
          <td class="num">${v(t.stopLoss)}${t.stopLoss !== t.initialStopLoss && t.initialStopLoss != null ? `<br><span class="muted">was ${t.initialStopLoss}</span>` : ''}</td>
          <td class="num">${v(t.target1)}</td>
          <td class="num">${v(t.target2)}</td>
          <td class="num"><input class="ltp" type="number" step="any" placeholder="${v(t.lastPrice)}" /></td>
          <td class="num ${cls(u)}">${u == null ? '-' : inr(u)}</td>
          <td class="num ${cls(t.grossPnl)}">${inr(t.grossPnl)}</td>
          <td>${t.status} ${levelBadges(t)}</td>
          <td><div class="row">
            <button class="small" data-act="ltp">Update LTP</button>
            <button class="small ghost" data-act="exit">Exit</button>
            <button class="small ghost" data-act="edit">Edit SL/TP</button>
            ${t.status === 'OPEN' ? '<button class="small danger" data-act="cancel">Cancel</button>' : ''}
          </div></td></tr>`;
            })
            .join('')
        : '<tr><td colspan="12" class="muted">No open trades</td></tr>');
  }

  async function loadClosed() {
    const { items } = await api(`/trades${qs({ ...filters, status: 'CLOSED,CANCELLED', limit: 200 })}`);
    const head = `<tr><th>Exit</th><th>Symbol</th><th>Side</th><th class="num">Qty</th><th class="num">Entry</th>
      <th class="num">SL</th><th class="num">TP1</th><th class="num">TP2</th><th class="num">Avg Exit</th><th>Exits</th>
      <th class="num">Net P&L</th><th class="num">R</th><th>Result</th><th></th></tr>`;
    $('#closedTable').innerHTML =
      head +
      (items.length
        ? items
            .map(
              (t) => `<tr data-id="${t._id}">
          <td>${fmtDate(t.exitTime || t.updatedAt)}</td>
          <td title="${esc(t.notes)}">${esc(t.tradingSymbol)}${t.strategy ? `<br><span class="muted">${esc(t.strategy)}</span>` : ''}</td>
          <td><span class="badge ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side}</span></td>
          <td class="num">${t.quantity}</td>
          <td class="num">${t.entryPrice}</td>
          <td class="num">${v(t.initialStopLoss)}</td>
          <td class="num">${v(t.target1)}</td>
          <td class="num">${v(t.target2)}</td>
          <td class="num">${v(t.avgExitPrice)}</td>
          <td class="muted">${t.exits.map((e) => `${e.reason} ${e.quantity}@${e.price}`).join('<br>') || '-'}</td>
          <td class="num ${cls(t.netPnl)}">${t.status === 'CANCELLED' ? '-' : inr(t.netPnl)}</td>
          <td class="num">${v(t.rMultiple)}</td>
          <td>${t.status === 'CANCELLED' ? '<span class="muted">CANCELLED</span>' : `<span class="badge ${t.result === 'WIN' ? 'win' : t.result === 'LOSS' ? 'loss' : ''}">${t.result}</span>`} ${levelBadges(t)}</td>
          <td><button class="small danger" data-act="delete">Delete</button></td></tr>`
            )
            .join('')
        : '<tr><td colspan="14" class="muted">No trades</td></tr>');
  }

  async function loadAll() {
    loadHealth();
    try {
      await loadInstruments();
      await Promise.all([loadReport(), loadOpen(), loadClosed()]);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- Events ----------
  const tradeForm = $('#tradeForm');

  function toggleOptFields() {
    const isOpt = tradeForm.segment.value === 'OPT';
    document.querySelectorAll('.opt').forEach((el) => (el.style.display = isOpt ? '' : 'none'));
  }

  function rrPreview() {
    const f = tradeForm;
    const e = parseFloat(f.entryPrice.value);
    const sl = parseFloat(f.stopLoss.value);
    const inst = instruments.find((i) => i.symbol === f.underlying.value.toUpperCase());
    const lotSize = parseInt(f.lotSize.value, 10) || (inst && inst.lotSize);
    const qty = lotSize ? lotSize * (parseInt(f.lots.value, 10) || 0) : null;
    const parts = [];
    if (qty) parts.push(`Qty ${qty}`);
    if (e && sl && e !== sl) {
      const risk = Math.abs(e - sl);
      parts.push(`Risk ${qty ? inr(risk * qty) : risk}`);
      ['target1', 'target2'].forEach((k, i) => {
        const t = parseFloat(f[k].value);
        if (t) parts.push(`TP${i + 1} 1:${(Math.abs(t - e) / risk).toFixed(2)}${qty ? ` (${inr(Math.abs(t - e) * qty)})` : ''}`);
      });
    }
    $('#rrPreview').textContent = parts.join(' · ');
  }

  tradeForm.addEventListener('input', rrPreview);
  tradeForm.segment.addEventListener('change', toggleOptFields);

  tradeForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#formError').textContent = '';
    const fd = Object.fromEntries(new FormData(tradeForm).entries());
    const body = {};
    Object.entries(fd).forEach(([k, val]) => {
      if (val !== '') body[k] = val;
    });
    if (body.segment === 'FUT') {
      delete body.optionType;
      delete body.strike;
    }
    if (body.entryTime) body.entryTime = new Date(body.entryTime).toISOString();
    ['lots', 'lotSize', 'strike', 'entryPrice', 'stopLoss', 'target1', 'target2'].forEach((k) => {
      if (body[k] !== undefined) body[k] = Number(body[k]);
    });
    try {
      const t = await api('/trades', { method: 'POST', body });
      toast(`Added: ${t.side} ${t.tradingSymbol}`);
      ['strike', 'entryPrice', 'stopLoss', 'target1', 'target2', 'notes', 'entryTime'].forEach((k) => (tradeForm[k].value = ''));
      rrPreview();
      loadAll();
    } catch (err) {
      $('#formError').textContent = err.message;
    }
  });

  function showEvents(events, t) {
    if (!events || !events.length) return toast(`LTP updated: ${t.tradingSymbol}`);
    events.forEach((e) =>
      toast(`${e.type.replace(/_/g, ' ')} · ${t.tradingSymbol}${e.exit ? `\nBooked ${e.exit.quantity} @ ${e.exit.price} → ${inr(e.exit.pnl)}` : ''}${e.slMovedTo != null ? `\nSL → cost ${e.slMovedTo}` : ''}`)
    );
  }

  async function onTableClick(ev) {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === 'ltp') {
        const ltp = parseFloat(tr.querySelector('.ltp').value);
        if (Number.isNaN(ltp)) return toast('LTP daalo');
        const { trade, events } = await api(`/trades/${id}/price`, { method: 'POST', body: { ltp } });
        showEvents(events, trade);
      } else if (act === 'exit') {
        const price = prompt('Exit price:');
        if (price === null || price === '') return;
        const qty = prompt('Quantity (khali = poori open qty):');
        if (qty === null) return;
        const body = { price: Number(price) };
        if (qty.trim()) body.quantity = Number(qty);
        const { trade, events } = await api(`/trades/${id}/exit`, { method: 'POST', body });
        showEvents(events, trade);
      } else if (act === 'edit') {
        const t = await api(`/trades/${id}`);
        const ask = (label, cur) => {
          const r = prompt(`${label} (khali = hata do):`, cur ?? '');
          return r === null ? undefined : r.trim() === '' ? null : Number(r);
        };
        const body = {};
        const sl = ask('Stop Loss', t.stopLoss);
        if (sl !== undefined) body.stopLoss = sl;
        const t1 = ask('Target 1', t.target1);
        if (t1 !== undefined) body.target1 = t1;
        const t2 = ask('Target 2', t.target2);
        if (t2 !== undefined) body.target2 = t2;
        if (!Object.keys(body).length) return;
        await api(`/trades/${id}`, { method: 'PATCH', body });
        toast('Levels updated');
      } else if (act === 'cancel') {
        if (!confirm('Trade cancel karna hai?')) return;
        await api(`/trades/${id}/cancel`, { method: 'POST' });
      } else if (act === 'delete') {
        if (!confirm('Trade permanently delete karna hai?')) return;
        await api(`/trades/${id}`, { method: 'DELETE' });
      }
      loadAll();
    } catch (err) {
      toast(err.message);
    }
  }

  $('#openTable').addEventListener('click', onTableClick);
  $('#closedTable').addEventListener('click', onTableClick);
  $('#openTable').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.classList.contains('ltp')) {
      ev.target.closest('tr').querySelector('button[data-act="ltp"]').click();
    }
  });

  $('#filterForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    filters = Object.fromEntries(new FormData(ev.target).entries());
    loadAll();
  });

  $('#btnToday').addEventListener('click', () => {
    const today = new Date().toLocaleDateString('en-CA');
    const f = $('#filterForm');
    f.from.value = today;
    f.to.value = today;
    f.requestSubmit();
  });

  $('#btnCsv').addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/reports/export.csv${qs(filters)}`, { headers: apiKey ? { 'x-api-key': apiKey } : {} });
      if (!res.ok) throw new Error((await res.json()).error);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `fno-trades.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btnTg').addEventListener('click', async () => {
    try {
      await api('/reports/telegram', { method: 'POST', body: {} });
      toast('Telegram report sent');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btnRefresh').addEventListener('click', loadAll);
  $('#btnKey').addEventListener('click', askKey);

  toggleOptFields();
  loadAll();
})();
