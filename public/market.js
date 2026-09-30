(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, esc, inr, cls, v } = window.fno;
  const TZ = { timeZone: 'Asia/Kolkata' };
  const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', TZ);
  const dayShort = (day) => new Date(`${day}T12:00:00+05:30`).toLocaleDateString('en-IN', { ...TZ, weekday: 'short', day: '2-digit', month: 'short' });
  const dayLabel = (day) =>
    new Date(`${day}T12:00:00+05:30`).toLocaleDateString('en-IN', { ...TZ, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const hhmm = (d) => new Date(d).toLocaleTimeString('en-IN', { ...TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const stat = (k, val, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${val}</div></div>`;
  const todayIST = () => dayKey(new Date());

  // ---------- Mobile: wide tables -> cards (th text -> td data-label) ----------
  function labelTable(t) {
    const heads = [...t.querySelectorAll('tr:first-child th')].map((th) => th.textContent.trim());
    if (!heads.length) return;
    t.querySelectorAll('tr').forEach((tr) => {
      if (tr.querySelector('th') || tr.querySelector('td[colspan]')) return;
      [...tr.children].forEach((td, i) => td.setAttribute('data-label', heads[i] || ''));
    });
  }
  // Page pe kahin bhi naya/badla table.stack -> labels (dynamic tables bhi)
  let labelTimer = null;
  new MutationObserver(() => {
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => document.querySelectorAll('table.stack').forEach(labelTable), 50);
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- Tabs ----------
  // Advanced tab = purane Signals + Backtest panes
  const inTab = (pane, tab) => pane === tab || (tab === 'adv' && (pane === 'signals' || pane === 'backtest'));
  function showTab(name) {
    if (!['picks', 'journal', 'adv'].includes(name)) name = 'picks';
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('[data-pane]').forEach((el) => (el.hidden = !inTab(el.dataset.pane, name)));
    try { localStorage.setItem('fno_tab', name); } catch { /* ignore */ }
    if (name === 'adv') loadRuns();
  }
  $('#tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // ---------- Upstox status ----------
  async function loadStatus() {
    try {
      const s = await api('/upstox/status');
      $('#upDot').className = `dot ${s.connected ? 'ok' : 'bad'}`;
      $('#upstoxStatus').textContent = s.connected ? `Upstox${s.user ? ` · ${s.user.split(' ')[0]}` : ''}` : 'Connect Upstox';
      $('#btnUpstox').title = s.connected ? 'Connected. Click = reconnect' : s.configured ? 'Login karo' : '.env me UPSTOX_API_KEY daalo';
      $('#marketState').textContent = `Market ${s.market.open ? '🟢 open' : '⚪ band'}${s.live.lastError ? ` · ⚠ ${s.live.lastError}` : ''}`;
      if (!$('#scanSymbols').value) $('#scanSymbols').value = s.watchlist.join(',');
    } catch { /* api() handles 401 */ }
  }

  async function loadSymbols() {
    try {
      const list = await api('/symbols?limit=400');
      $('#symbolList').innerHTML = list.map((s) => `<option value="${esc(s.symbol)}">${s.type} · lot ${v(s.lotSize)}</option>`).join('');
    } catch { /* typing still works */ }
  }

  // ================= SIGNALS =================
  let lastPlan = null;

  function checksBlock(sig) {
    if (!sig.checks) return '';
    const list = (arr, good) =>
      `<ul>${arr.map((c) => `<li><span class="${c.ok ? good : 'muted'}">${c.ok ? '✔' : '✘'} ${esc(c.name)}</span><span class="muted sm">${esc(c.detail)}</span></li>`).join('')}</ul>`;
    const filters = sig.filters && sig.filters.length
      ? `<div><h3>Strict filters (${sig.candidate}): ${sig.filters.filter((f) => f.ok).length}/${sig.filters.length} pass</h3>${list(sig.filters, 'pos')}</div>`
      : '';
    return `<div class="checks">
      <div><h3>Bullish ${sig.longScore}/5</h3>${list(sig.checks.long, 'pos')}</div>
      <div><h3>Bearish ${sig.shortScore}/5</h3>${list(sig.checks.short, 'neg')}</div>${filters}</div>`;
  }

  function planBlock(o, live) {
    if (!o) return '';
    if (o.error && !o.entryPrice) return `<p class="warn">${esc(o.error)}</p>`;
    return `<div class="plan ${live ? '' : 'ref'}">
      ${live ? '' : '<div class="muted sm">Sirf reference: abhi entry ka signal nahi hai</div>'}
      <div class="plan-title">${esc(o.underlying)} ${o.strike} ${o.optionType} <span class="muted sm">· expiry ${o.expiry}</span></div>
      <div class="levels">
        <div><span>Entry</span>${o.entryPrice}</div><div><span>Stop loss</span><b class="neg">${o.stopLoss}</b></div>
        <div><span>Target 1</span><b class="pos">${o.target1}</b></div><div><span>Target 2</span><b class="pos">${v(o.target2)}</b></div>
      </div>
      <div class="muted sm">Lots <b>${o.lots}</b> × ${o.lotSize} · Max loss <b class="neg">${inr(o.maxLoss)}</b> · Capital ${inr(o.capitalNeeded)}</div>
      ${o.error ? `<p class="warn">${esc(o.error)}</p>` : ''}
      ${live && o.lots > 0 && !o.error ? '<div><button id="btnTake">Journal me add karo</button></div>' : ''}
    </div>`;
  }

  function renderAnalysis(r) {
    const sig = r.signal;
    const kind = r.verdict.action === 'BUY CE' ? 'buy' : r.verdict.action === 'BUY PE' || r.verdict.action === 'STOP' ? 'sell' : 'wait';
    lastPlan = r.option && !r.option.error && r.option.lots > 0 ? r.option : null;
    const c = r.chain;
    $('#analysis').innerHTML = `
      <div class="verdict ${kind}">
        <div class="big">${esc(r.verdict.action)}</div>
        <div><b>${esc(r.symbol)}</b> ${r.spot} <span class="muted sm">· ${r.interval}m · ${hhmm(r.lastCandle.time)}</span><br><span class="muted sm">${esc(r.verdict.why)}</span></div>
      </div>
      ${r.warnings.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}
      ${planBlock(r.option, kind !== 'wait')}
      ${c ? `<div class="stats">${stat('PCR', v(c.pcr))}${stat('Support', v(c.support))}${stat('Resistance', v(c.resistance))}${stat('ATM', c.atmStrike)}</div>` : ''}
      ${r.pause ? `<p class="muted sm">Auto-pause: pichhle ${r.pause.recentTrades} signals ka net <b class="${cls(r.pause.recentNet)}">${inr(r.pause.recentNet)}</b> → ${r.pause.paused ? '⏸ PAUSE (sirf paper)' : '▶ real trade allowed'}</p>` : ''}
      <details><summary class="sm">Signal kyun? (checks + filters)</summary>${checksBlock(sig)}</details>
      ${r.todaySignals.length ? `<details><summary class="sm">Is session ke signals (${r.todaySignals.length})</summary><ul class="timeline">${r.todaySignals
        .map((s) => `<li><time>${hhmm(s.time)}</time><span class="${s.direction === 'LONG' ? 'pos' : 'neg'}">${s.direction === 'LONG' ? 'BUY CE' : 'BUY PE'}</span> @ ${s.entry}${s.inWindow ? '' : ' <span class="muted">(time window ke bahar)</span>'}</li>`)
        .join('')}</ul></details>` : ''}`;
  }

  async function analyze(symbol, interval) {
    $('#analysis').innerHTML = '<p class="muted">Analyzing…</p>';
    try {
      const strat = $('#analyzeForm').strategy.value;
      renderAnalysis(await api(`/analysis/${encodeURIComponent(symbol)}?interval=${interval || 5}&strategy=${strat}`));
    } catch (err) {
      $('#analysis').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  $('#analyzeForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    analyze(ev.target.symbol.value.trim().toUpperCase(), ev.target.interval.value);
  });

  $('#analysis').addEventListener('click', (ev) => {
    if (ev.target.id !== 'btnTake' || !lastPlan) return;
    const o = lastPlan;
    window.fno.fillTrade({
      underlying: o.underlying, segment: 'OPT', optionType: o.optionType, strike: o.strike, expiry: o.expiry, side: 'BUY',
      lots: o.lots, lotSize: o.lotSize, entryPrice: o.entryPrice, stopLoss: o.stopLoss, target1: o.target1, target2: o.target2,
      strategy: o.strategy, instrumentKey: o.instrumentKey,
    });
    showTab('journal');
    $('#newTradeBox').open = true;
    $('#newTradeBox').scrollIntoView({ behavior: 'smooth' });
    toast('Form bhar diya. Broker ka actual fill price Entry me daalo, phir Add Trade.');
  });

  $('#scanForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const symbols = $('#scanSymbols').value.replace(/\s+/g, '');
    $('#scanList').innerHTML = '<p class="muted">Scanning…</p>';
    try {
      const rows = await api(`/signals?symbols=${encodeURIComponent(symbols)}&strategy=${$('#analyzeForm').strategy.value}`);
      $('#scanList').innerHTML = rows
        .map((r) =>
          r.error
            ? `<div class="item"><div class="top"><b>${esc(r.symbol)}</b><span class="error sm">${esc(r.error)}</span></div></div>`
            : `<div class="item">
                <div class="top"><b>${esc(r.symbol)} <span class="muted sm">${r.spot}</span></b>
                  <span class="badge ${r.action === 'BUY CE' ? 'buy' : r.action === 'BUY PE' ? 'sell' : ''}">${esc(r.action)}</span></div>
                <div class="muted sm">Bull ${r.longScore}/5 · Bear ${r.shortScore}/5 · RSI ${v(r.rsi)}${r.pcr != null ? ` · PCR ${r.pcr}` : ''}</div>
                ${r.option && !r.option.error ? `<div class="sm">${r.option.strike} ${r.option.optionType} @ ${r.option.entryPrice} · SL ${r.option.stopLoss} · T1 ${r.option.target1}</div>` : ''}
                <div class="row between"><span class="muted sm">${esc(r.why)}</span><button class="small ghost" data-sym="${esc(r.symbol)}">Details</button></div>
              </div>`
        )
        .join('');
    } catch (err) {
      $('#scanList').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });
  $('#scanList').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-sym]');
    if (!b) return;
    $('#analyzeForm').symbol.value = b.dataset.sym;
    analyze(b.dataset.sym, $('#analyzeForm').interval.value);
    $('#analyzeForm').scrollIntoView({ behavior: 'smooth' });
  });

  // ================= BACKTEST =================
  const STRATEGY_NAMES = { scalp: 'Momentum Scalp (3 min)', sweep: 'Liquidity Sweep (SMC)', trend: 'Trend (VWAP+EMA+ST+RSI)', orb: 'ORB (opening range breakout)', pdhl: 'Pichhle din High/Low breakout', vwaprev: 'VWAP mean reversion' };
  const PARAM_HELP = {
    orMinutes: 'ORB range (min)',
    strict: 'Strict mode (sirf Trend)',
    pauseLookback: 'Auto-pause (last N trades, 0=off)',
    adxMin: 'Min ADX (0=off)',
    orFilter: 'Opening range breakout',
    htfFilter: '15m trend match',
    maxExtAtr: 'Max VWAP door (ATR, 0=off)',
    bodyMin: 'Min candle body (0-1)',
    tp1BookAll: 'T1 pe poora book',
    timeStopBars: 'Time stop (candles, 0=off)',
    minScore: 'Min checks (5 me se)',
    slAtr: 'SL = ATR ×',
    tp1R: 'Target 1 (R)',
    tp2R: 'Target 2 (R)',
    maxTradesPerDay: 'Max trades / din',
    maxLossesPerDay: 'Max SL / din',
    entryStart: 'Entry start',
    entryEnd: 'Entry end',
    squareOff: 'Square-off',
  };
  const btForm = $('#btForm');
  let run = null;
  let dayFilter = 'all';

  function paramInput(k, val) {
    if (k === 'strategy') {
      return `<select name="p_strategy">${Object.entries(STRATEGY_NAMES).map(([v2, n]) => `<option value="${v2}" ${v2 === val ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    }
    if (typeof val === 'boolean') {
      return `<select name="p_${k}"><option value="true" ${val ? 'selected' : ''}>Haan</option><option value="false" ${val ? '' : 'selected'}>Nahi</option></select>`;
    }
    return `<input name="p_${k}" value="${esc(val)}" ${typeof val === 'number' ? 'type="number" step="any"' : 'type="time"'} />`;
  }

  async function loadParams(strat) {
    try {
      const p = await api(`/strategy/params${strat ? `?strategy=${strat}` : ''}`);
      $('#btParams').innerHTML = Object.keys(PARAM_HELP)
        .filter((k) => k in p)
        .map((k) => `<label>${PARAM_HELP[k]}${paramInput(k, p[k])}</label>`)
        .join('');
    } catch { /* ignore */ }
  }

  // Upstox se auto values dikhana (symbol/lots badalne pe)
  let autoTimer = null;
  async function loadAuto() {
    const sym = btForm.symbol.value.trim().toUpperCase();
    if (!sym) return;
    try {
      const a = await api(`/auto-defaults?symbol=${encodeURIComponent(sym)}&lots=${btForm.lots.value || 1}`);
      $('#btAuto').innerHTML = a.source === 'upstox'
        ? `✅ Upstox se apne aap: lot <b>${a.lotSize}</b> · delta <b>${a.delta}</b> · slippage <b>${a.slippagePts} pt</b> · charges <b>${inr(a.charges.roundTrip)}</b>/trade`
        : `Default values: lot ${v(a.lotSize)} · delta ${a.delta} · slippage ${a.slippagePts} pt${a.notes.length ? ` (${esc(a.notes[0])})` : ''}`;
    } catch (err) {
      $('#btAuto').textContent = err.message;
    }
  }
  btForm.addEventListener('input', (ev) => {
    if (ev.target.name !== 'symbol' && ev.target.name !== 'lots') return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(loadAuto, 600);
  });

  function syncSpan() {
    const range = btForm.span.value === 'range';
    btForm.querySelector('.range-only').hidden = !range;
    btForm.to.required = range;
    btForm.from.closest('label').firstChild.textContent = range ? 'From ' : 'Date ';
  }
  btForm.addEventListener('change', (ev) => {
    if (ev.target.name === 'span') syncSpan();
    // Strategy badli -> uske defaults (scalp: time stop, entry window...)
    if (ev.target.name === 'p_strategy') loadParams(ev.target.value);
  });

  // Trade ke andar kya hua - time wise
  function timeline(t) {
    const steps = [];
    if (t.tp1Hit && !t.exits.some((e) => e.reason === 'TP1')) steps.push({ time: t.tp1HitAt, text: `🎯 Target 1 hit (${t.target1}), SL cost pe shift` });
    for (const e of t.exits) {
      const text = {
        TP1: `🎯 Target 1 hit, ${e.quantity} qty book @ ${e.price}, SL cost pe`,
        TP2: `🎯🎯 Target 2 hit, ${e.quantity} qty book @ ${e.price}`,
        SL: `🛑 Stop loss hit @ ${e.price}`,
        TRAIL_SL: `🛡️ Wapas aaya, cost pe exit @ ${e.price}`,
        EOD: `⏰ 3:15 square-off @ ${e.price}`,
        TIME: `⏱️ Time stop: target ki taraf nahi chala, exit @ ${e.price}`,
      }[e.reason] || `${e.reason} @ ${e.price}`;
      steps.push({ time: e.time, text });
    }
    return steps.sort((a, b) => new Date(a.time) - new Date(b.time));
  }

  function headline(t) {
    const r = t.exits.map((e) => e.reason);
    if (r.includes('TP2')) return '🎯🎯 Target 2 hit';
    if (r.includes('SL')) return '🛑 Stop loss hit';
    if (t.tp1Hit && r.includes('TRAIL_SL')) return '🎯 T1 ke baad cost pe bahar';
    if (r.includes('EOD')) return '⏰ Square-off';
    if (r.includes('TIME')) return '⏱️ Time stop exit';
    return t.tp1Hit ? '🎯 Target 1 hit' : r.join(', ');
  }

  const contract = (t) => (t.segment === 'OPT' ? `BUY ${t.underlying} ${t.strike} ${t.optionType}` : `${t.side} ${t.underlying} FUT`);

  function tradeCard(t) {
    const u = t.underlyingLevels || {};
    return `<div class="trade ${t.paper ? 'paper' : ''}">
      ${t.paper ? '<div class="paper-tag">⏸ PAPER: auto-pause ON tha (pichhle signals loss me the), real trade nahi liya. P&amp;L total me nahi juda.</div>' : ''}
      <div class="t-top">
        <div>
          <div class="t-title">${hhmm(t.entryTime)} · <span class="${t.direction === 'LONG' ? 'pos' : 'neg'}">${esc(contract(t))}</span></div>
          <div class="muted sm">Spot ${t.underlyingEntry} · SL ${v(u.stopLoss)} · T1 ${v(u.target1)} · T2 ${v(u.target2)} · score ${t.signalScore}/5</div>
        </div>
        <div class="t-pnl ${cls(t.netPnl)}">${inr(t.netPnl)}</div>
      </div>
      <div class="levels">
        <div><span>Entry</span>${t.entryPrice}</div><div><span>Stop loss</span>${v(t.initialStopLoss)}</div>
        <div><span>Target 1</span>${v(t.target1)}</div><div><span>Target 2</span>${v(t.target2)}</div>
      </div>
      <div><b>${headline(t)}</b></div>
      <ul class="timeline">${timeline(t).map((s) => `<li><time>${hhmm(s.time)}</time><span>${esc(s.text)}</span></li>`).join('')}</ul>
    </div>`;
  }

  function buildDays(r) {
    const byDay = new Map((r.sessions || []).map((s) => [s.day, { ...s, trades: [] }]));
    for (const t of r.trades || []) {
      const k = dayKey(t.entryTime);
      if (!byDay.has(k)) byDay.set(k, { day: k, signals: 0, skippedWindow: 0, skippedLimit: 0, trades: [] });
      byDay.get(k).trades.push(t);
    }
    return [...byDay.values()]
      .map((d) => {
        const real = d.trades.filter((t) => !t.paper);
        return {
          ...d,
          real,
          paper: d.trades.length - real.length,
          net: real.reduce((s, t) => s + t.netPnl, 0),
          wins: real.filter((t) => t.result === 'WIN').length,
          losses: real.filter((t) => t.result === 'LOSS').length,
        };
      })
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  function noTradeReason(d) {
    if (!d.signals) return run?.params?.strict ? 'Strict filters pass karne wala koi setup nahi aaya, isliye system ne trade nahi bola' : 'Is din koi signal nahi aaya, isliye system ne trade nahi bola';
    const parts = [];
    if (d.skippedWindow) parts.push(`${d.skippedWindow} signal time window (9:30–2:30) ke bahar`);
    if (d.skippedLimit) parts.push(`${d.skippedLimit} signal daily trade limit ki wajah se skip`);
    if (d.skippedRisk) parts.push(`${d.skippedRisk} signal skip: 1 lot ka risk tumhare capital limit se zyada tha`);
    if (d.skippedLoss) parts.push(`${d.skippedLoss} signal skip: din/mahine ka loss limit hit ho chuka tha`);
    return parts.join(', ') || 'Koi trade nahi';
  }

  function renderDays() {
    const days = buildDays(run).filter((d) =>
      dayFilter === 'win' ? d.net > 0 : dayFilter === 'loss' ? d.net < 0 : dayFilter === 'none' ? !d.trades.length : true
    );
    const openAll = run.from === run.to || days.length <= 3;
    $('#days').innerHTML = days.length
      ? days
          .map((d, i) => {
            const kind = !d.real.length ? '' : d.net > 0 ? 'win' : d.net < 0 ? 'loss' : '';
            const meta = [
              d.real.length ? `${d.real.length} trade · ${d.wins} profit · ${d.losses} loss` : '',
              d.paper ? `${d.paper} paper` : '',
            ].filter(Boolean).join(' · ') || 'No trade';
            return `<details class="day ${kind}" ${openAll || i === 0 ? 'open' : ''}>
              <summary><span class="d-title">${dayShort(d.day)}</span><span class="d-meta">${meta}</span>
                <span class="d-pnl ${cls(d.net)}">${d.real.length ? inr(d.net) : '–'}</span></summary>
              <div class="day-body">${d.trades.length ? d.trades.map(tradeCard).join('') : `<p class="muted sm">${noTradeReason(d)}</p>`}</div>
            </details>`;
          })
          .join('')
      : '<p class="empty">Is filter me koi din nahi</p>';
  }

  function equitySvg(curve) {
    if (!curve || curve.length < 2) return '';
    const W = 800;
    const H = 160;
    const ys = [0, ...curve.map((p) => p.equity)];
    const min = Math.min(...ys);
    const span = Math.max(...ys) - min || 1;
    const y = (val) => (H - 8 - ((val - min) / span) * (H - 16)).toFixed(1);
    const pts = ys.map((val, i) => `${((i / curve.length) * W).toFixed(1)},${y(val)}`).join(' ');
    const end = curve[curve.length - 1].equity;
    return `<svg class="equity" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="zero" /><polyline points="${pts}" class="${end >= 0 ? 'up' : 'down'}" /></svg>`;
  }

  function renderRun(r) {
    run = r;
    dayFilter = 'all';
    const s = r.summary;
    const days = buildDays(r);
    const single = r.from === r.to;
    let vClass = 'meh';
    let verdict = '';
    if (single) {
      verdict = s.closed ? `Is din ${s.closed} trade: ${s.wins} profit, ${s.losses} loss` : noTradeReason(days[0] || {});
      vClass = s.netPnl > 0 ? 'good' : s.netPnl < 0 ? 'bad' : 'meh';
    } else if (s.closed < 30) {
      verdict = 'Trades 30 se kam hain, is result pe bharosa mat karo. Lamba range test karo.';
    } else if (s.netPnl > 0 && s.profitFactor >= 1.3) {
      verdict = 'Is period me strategy profit me rahi. Live se pehle doosre period pe bhi check karo.';
      vClass = 'good';
    } else if (s.netPnl > 0) {
      verdict = 'Thoda profit hai par edge kamzor hai (profit factor 1.3 se kam).';
    } else {
      verdict = 'Is period me strategy LOSS me rahi. In settings pe live trade mat lo.';
      vClass = 'bad';
    }
    const winDays = days.filter((d) => d.net > 0).length;
    const lossDays = days.filter((d) => d.net < 0).length;
    const noDays = days.filter((d) => !d.trades.length).length;
    const pausedNote = r.paused
      ? `<p class="muted sm">⏸ Auto-pause ne ${r.paused} trade paper pe rakhe (real nahi liye). Agar wo bhi lete to unka net ${inr(r.pausedNet)} hota.</p>`
      : '';

    $('#btResult').innerHTML = `
      <div class="card result-head">
        <div class="card-head" style="margin:0"><h2>${esc(r.symbol)} · ${single ? dayLabel(r.from) : `${dayLabel(r.from)} → ${dayLabel(r.to)}`}</h2>
          <span class="muted sm">${r.interval}m · ${r.mode === 'OPTION' ? 'Option' : 'Futures'} · ${r.options?.lots || 1} lot · ${STRATEGY_NAMES[r.params?.strategy || 'trend']}${(r.params?.strategy || 'trend') === 'trend' ? (r.params?.strict ? ' · STRICT' : ' · Classic') : ''}</span></div>
        <div class="stats">
          ${stat('Net P&amp;L', inr(s.netPnl), cls(s.netPnl))}
          ${stat('Trades', `${s.closed} <span class="muted sm">(${s.wins}W / ${s.losses}L)</span>`)}
          ${stat('Win rate', `${s.winRate}%`)}
          ${single ? stat('Charges', inr(s.charges)) : stat('Max drawdown', inr(s.maxDrawdown), s.maxDrawdown ? 'neg' : '')}
        </div>
        <div class="verdict-line ${vClass}">${esc(verdict)}</div>
        ${r.options ? `<p class="muted sm">Use hua: delta ${r.options.delta} · slippage ${r.options.slippagePts} pt/order · charges ~${inr((r.options.brokeragePerOrder || 0) * 2 + (r.options.variableChargesPerTrade || 0))}/trade${r.auto?.source === 'upstox' ? ' (Upstox se)' : ''}</p>` : ''}
        ${pausedNote}
        ${r.capital ? `<p class="muted sm">🛡️ Capital rules: ${inr(r.capital.capital)} · max ${inr(r.capital.riskPerTrade)}/trade · din ${inr(r.capital.dailyLossLimit)} · mahina ${inr(r.capital.monthlyLossLimit)}${r.skipped?.risk ? ` · <b>${r.skipped.risk} signal skip (risk zyada)</b>` : ''}${r.skipped?.dayLoss || r.skipped?.monthLoss ? ` · ${(r.skipped.dayLoss || 0) + (r.skipped.monthLoss || 0)} skip (loss limit)` : ''}</p>` : ''}
        ${!single ? `<details><summary class="sm">Aur stats</summary>
          <div class="stats" style="margin-top:8px">${stat('Profit factor', v(s.profitFactor))}${stat('Avg profit', inr(s.avgWin), 'pos')}${stat('Avg loss', inr(s.avgLoss), 'neg')}
          ${stat('Per trade (avg)', inr(s.expectancy), cls(s.expectancy))}${stat('Charges', inr(s.charges))}${stat('T1 / T2 / SL hit', `${s.tp1HitRate}% · ${s.tp2HitRate}% · ${s.slHitRate}%`, 'sm')}</div>
          ${equitySvg(r.equityCurve)}</details>` : ''}
        <div class="row between">
          ${!single ? `<div class="chips" id="dayChips">
            <button class="on" data-f="all">Sab din (${days.length})</button><button data-f="win">Profit (${winDays})</button>
            <button data-f="loss">Loss (${lossDays})</button><button data-f="none">No trade (${noDays})</button></div>` : '<span></span>'}
          <button class="small ghost" id="btCsv">⬇ Excel (CSV)</button>
        </div>
      </div>
      <div class="days" id="days" style="margin-top:12px"></div>`;
    renderDays();
  }

  function downloadCsv() {
    const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const clean = (x) => x.replace(/[^\w\s@.,/()-]/g, '').trim();
    const head = ['Date', 'Time', 'Trade', 'Score', 'Spot', 'Spot SL', 'Spot T1', 'Spot T2', 'Entry', 'SL', 'Target1', 'Target2', 'Qty', 'Result', 'Kya hua', 'Net P&L'];
    const lines = (run.trades || []).map((t) => {
      const u = t.underlyingLevels || {};
      return [dayKey(t.entryTime), hhmm(t.entryTime), contract(t), t.signalScore, t.underlyingEntry, u.stopLoss, u.target1, u.target2, t.entryPrice, t.initialStopLoss, t.target1, t.target2, t.quantity,
        clean(headline(t)), timeline(t).map((s) => `${hhmm(s.time)} ${clean(s.text)}`).join(' | '), t.netPnl].map(q).join(',');
    });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([[head.map(q).join(','), ...lines].join('\n')], { type: 'text/csv' })),
      download: `backtest-${run.symbol}-${run.from}${run.from !== run.to ? `-to-${run.to}` : ''}.csv`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  $('#btResult').addEventListener('click', (ev) => {
    const chip = ev.target.closest('#dayChips button');
    if (chip) {
      dayFilter = chip.dataset.f;
      document.querySelectorAll('#dayChips button').forEach((b) => b.classList.toggle('on', b === chip));
      renderDays();
    }
    if (ev.target.id === 'btCsv') downloadCsv();
  });

  async function loadRuns() {
    try {
      const runs = await api('/backtest');
      $('#btClear').hidden = !runs.length;
      $('#btRuns').innerHTML = runs.length
        ? runs
            .map(
              (r) => `<div class="run" data-id="${r._id}">
                <div class="r-main"><b>${esc(r.symbol)}</b> <span class="muted sm">${r.from.slice(0, 10) === r.to.slice(0, 10) ? dayLabel(r.from.slice(0, 10)) : `${r.from.slice(0, 10)} → ${r.to.slice(0, 10)}`} · ${r.interval}m</span><br>
                  <span class="sm">${r.summary.closed} trades · ${r.summary.winRate}% win · <b class="nowrap ${cls(r.summary.netPnl)}">${inr(r.summary.netPnl)}</b></span></div>
                <div class="row"><button class="small ghost" data-act="open">Kholo</button><button class="small danger" data-act="del" aria-label="Delete">✕</button></div>
              </div>`
            )
            .join('')
        : '<p class="empty">Abhi koi backtest nahi</p>';
    } catch (err) {
      $('#btRuns').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  $('#btRuns').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('.run').dataset.id;
    try {
      if (b.dataset.act === 'open') {
        renderRun(await api(`/backtest/${id}`));
        $('#btResultCard').scrollIntoView({ behavior: 'smooth' });
      } else {
        await api(`/backtest/${id}`, { method: 'DELETE' });
        if (run && run._id === id) {
          run = null;
          $('#btResult').innerHTML = '';
        }
        loadRuns();
      }
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btClear').addEventListener('click', async () => {
    if (!confirm('Saare purane backtest delete karne hain?')) return;
    try {
      const r = await api('/backtest', { method: 'DELETE' });
      run = null;
      $('#btResult').innerHTML = '';
      toast(`${r.deleted} backtest clear ho gaye`);
      loadRuns();
    } catch (err) {
      toast(err.message);
    }
  });

  btForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#btError').textContent = '';
    const fd = Object.fromEntries(new FormData(btForm).entries());
    const body = { params: {} };
    for (const [k, val] of Object.entries(fd)) {
      if (k.startsWith('p_')) body.params[k.slice(2)] = val;
      else if (k !== 'span') body[k] = val;
    }
    body.symbol = body.symbol.trim().toUpperCase();
    if (fd.span === 'day') body.to = body.from;
    if (body.to < body.from) {
      $('#btError').textContent = 'To date, From date ke baad honi chahiye';
      return;
    }
    const btn = $('#btRun');
    btn.disabled = true;
    btn.textContent = 'Running…';
    try {
      renderRun(await api('/backtest', { method: 'POST', body }));
      loadRuns();
      $('#btResultCard').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      $('#btError').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Run';
    }
  });

  // Default: pichhla trading din (weekend skip)
  const d = new Date(`${todayIST()}T12:00:00+05:30`);
  do d.setDate(d.getDate() - 1); while ([0, 6].includes(d.getDay()));
  btForm.from.value = dayKey(d);
  btForm.to.value = dayKey(d);
  syncSpan();

  // ================= DATE PICKS =================
  const pkForm = $('#pkForm');
  // ---------- Paise ka hisaab ----------
  // Upstox F&O option charges (approx): brokerage/order + STT 0.1% sell + exchange txn + SEBI + stamp + GST
  function optCharges(buy, sell, qty, exch, brokerage) {
    const tb = buy * qty;
    const ts = sell * qty;
    const brk = 2 * brokerage;
    const txn = (exch === 'BSE' ? 0.000325 : 0.0003503) * (tb + ts);
    const sebi = 0.000001 * (tb + ts);
    return brk + 0.001 * ts + txn + sebi + 0.00003 * tb + 0.18 * (brk + txn + sebi);
  }
  const rupee = (n, sign = false) => {
    if (n == null || Number.isNaN(n)) return '–';
    const s = Math.round(Math.abs(n)).toLocaleString('en-IN');
    return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}₹${s}`;
  };
  const pts = (n) => (n == null ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n * 100) / 100)}`);

  let pkData = null;
  const pkLotsMode = () => pkForm.lots.value; // 'auto' | '1'..'N'

  // Pick ke liye kitne lot: auto = risk rule (SL loss + charges <= risk per trade), warna jo chuna
  function lotsFor(p) {
    const o = p.premium;
    const mode = pkLotsMode();
    if (mode !== 'auto') return { lots: Number(mode) || 1, auto: false };
    const risk = pkData?.risk?.riskPerTrade;
    if (!o || o.error || !risk) return { lots: 1, auto: false };
    const perLotLoss = Math.abs(o.perLot.slLoss) + optCharges(o.entry, o.stopLoss ?? o.estSl, o.lotSize, o.exchange, 0);
    const fixed = 2 * (pkData.brokeragePerOrder || 0) * 1.18;
    const lots = Math.floor((risk - fixed) / perLotLoss);
    return { lots: Math.max(lots, 0), auto: true };
  }

  // Ek pick ka paisa: entry amount, SL loss, T1 / T2 / plan profit, charges, result P&L - sab net of charges
  function money(p) {
    const o = p.premium;
    if (!o || o.error) return null;
    const { lots, auto } = lotsFor(p);
    const n = Math.max(lots, 1);
    const qty = n * o.lotSize;
    const brk = pkData?.brokeragePerOrder ?? 20;
    const ch = (exitPx) => optCharges(o.entry, exitPx, qty, o.exchange, brk);
    const res = o.result;
    const resGross = o.pnlPerLot == null ? null : o.pnlPerLot * n;
    const resExit = res.points == null ? null : o.entry + res.points;
    return {
      lots: n,
      auto,
      overRisk: auto && lots < 1,
      qty,
      invest: o.perLot.invest * n,
      sl: { gross: o.perLot.slLoss * n, net: o.perLot.slLoss * n - ch(o.stopLoss ?? o.estSl) },
      t1: { gross: o.perLot.t1Profit * n, net: o.perLot.t1Profit * n - ch(o.target1) },
      t2: o.target2 == null ? null : { gross: o.perLot.t2Profit * n, net: o.perLot.t2Profit * n - ch(o.target2) },
      plan: { gross: o.perLot.planProfit * n, net: o.perLot.planProfit * n - ch(o.target2 ?? o.target1) },
      result: resGross == null ? null : { gross: resGross, net: resGross - ch(resExit) },
      live: o.ltp != null ? { ltp: o.ltp, gross: (o.ltp - o.entry) * qty } : null,
    };
  }

  const RES_ICON = { TP2: '✅✅', TP1: '✅', TRAIL_SL: '🛡️', SL: '❌', EOD: '⏰', TIME: '⏱️', RUNNING: '⏳' };
  const RES_KIND = { TP2: 'win', TP1: 'win', TRAIL_SL: 'flat', SL: 'loss', EOD: 'flat', TIME: 'flat', RUNNING: 'live' };

  function orderTable(p, m) {
    const o = p.premium;
    const row = (label, price, move, amt, net, c) => `<tr class="${c}">
        <th scope="row">${label}</th>
        <td class="num">${price}</td>
        <td class="num muted">${move}</td>
        <td class="num"><b>${amt}</b></td>
        <td class="num muted">${net}</td>
      </tr>`;
    return `<table class="ticket-table">
      <thead><tr><th></th><th class="num">Premium</th><th class="num">Move</th><th class="num">${m.lots} lot (${m.qty} qty)</th><th class="num">Charges ke baad</th></tr></thead>
      <tbody>
        ${row('Buy @ LTP', `<b>${o.entry}</b>`, '', rupee(m.invest), 'entry amount', 'entry')}
        ${o.viaIndex
          ? row('Stop loss', `<span class="sm">index ${o.indexSl}</span>`, 'poora premium risk', rupee(m.sl.gross), rupee(m.sl.net), 'neg')
          : row('Stop loss', o.stopLoss, pts(o.stopLoss - o.entry), rupee(m.sl.gross), rupee(m.sl.net), 'neg')}
        ${row('Target 1', o.target1, pts(o.target1 - o.entry), rupee(m.t1.gross, true), rupee(m.t1.net, true), 'pos')}
        ${m.t2 ? row('Target 2', o.target2, pts(o.target2 - o.entry), rupee(m.t2.gross, true), rupee(m.t2.net, true), 'pos') : ''}
      </tbody>
    </table>`;
  }

  function pickCard(p, { featured = false } = {}) {
    const up = p.signal === 'BUY CE';
    const o = p.premium && !p.premium.error ? p.premium : null;
    const m = money(p);
    const r = o ? o.result : p.result;
    const kind = RES_KIND[r.code] || '';
    const rr = m ? Math.round((m.plan.gross / Math.abs(m.sl.gross)) * 10) / 10 : null;

    let outcome;
    if (r.code === 'RUNNING') {
      outcome = m?.live
        ? `<span class="chip live">⏳ Chal raha hai</span> LTP <b>${m.live.ltp}</b> · <b class="${cls(m.live.gross)}">${rupee(m.live.gross, true)}</b>${r.tp1Time ? ` · T1 ${r.tp1Time}, SL ab cost pe` : ''}`
        : `<span class="chip live">⏳ Chal raha hai</span>`;
    } else if (m?.result) {
      outcome = `<span class="chip ${kind}">${RES_ICON[r.code] || ''} ${esc(r.text)}</span> ${r.time || ''}${r.tp1Time && r.code !== 'TP1' && r.code !== 'SL' ? ` <span class="muted">(T1 ${r.tp1Time})</span>` : ''}
        <span class="outcome-amt ${cls(m.result.net)}">${rupee(m.result.net, true)}</span><span class="muted sm"> net · gross ${rupee(m.result.gross, true)}</span>`;
    } else {
      outcome = `<span class="chip ${kind}">${RES_ICON[r.code] || ''} ${esc(r.text)}</span> ${r.time || ''}${p.points != null ? ` · ${pts(p.points)} index pts` : ''}`;
    }

    const flagChip = p.flags?.length
      ? `<span class="chip ${p.allGreen ? 'win' : 'muted-chip'}" title="${esc(p.flags.map((f) => `${f.ok ? '✅' : '❌'} ${f.text}`).join('\n'))}">${p.flagScore}/${p.flagOf} flags${p.allGreen ? ' · lene layak' : ' · skip'}</span>`
      : '';

    return `<article class="ticket ${kind} ${featured ? 'featured' : ''}">
      <header class="ticket-head">
        <div class="ticket-id">
          <span class="side ${up ? 'buy' : 'sell'}">${p.signal}</span>
          <div>
            <div class="ticket-title">${esc(o ? o.name : p.option)}</div>
            <div class="muted sm">${esc(p.symbol)} · ${p.time}${o ? ` · expiry ${esc(o.expiry)}` : ''} · lot ${v(o?.lotSize ?? p.lotSize)}</div>
          </div>
        </div>
        <div class="ticket-tags">${flagChip}${p.timeStopMin ? `<span class="chip muted-chip">⏱️ ${p.timeStopMin} min stop</span>` : ''}</div>
      </header>

      ${m ? `
      <div class="kpis">
        <div class="kpi"><span>Entry amount</span><b>${rupee(m.invest)}</b><small>${o.entry} × ${m.qty}</small></div>
        <div class="kpi neg"><span>SL pe loss</span><b>${rupee(m.sl.net)}</b><small>${o.viaIndex ? `index ${o.indexSl} pe bahar (andaza)` : 'charges ke saath'}</small></div>
        <div class="kpi pos"><span>Target pe profit</span><b>${rupee(m.plan.net, true)}</b><small>R:R 1:${rr} · ${m.t2 ? '½ T1 + ½ T2' : 'T1 pe'}</small></div>
      </div>
      ${m.overRisk ? `<div class="warn sm">1 lot ka SL loss (${rupee(Math.abs(p.premium.perLot.slLoss))}) aapke risk limit (${rupee(pkData.risk.riskPerTrade)}) se zyada hai. Neeche 1 lot ka hisaab hai, par ye trade skip karna chahiye.</div>` : ''}
      ${orderTable(p, m)}` : `<div class="muted sm">${p.premium?.error ? `⚠ ${esc(p.premium.error)}` : 'Option bhav nahi mila'}</div>`}

      <div class="outcome">${outcome}</div>

      <details class="more">
        <summary>Index levels · kyun liya${r.reasons?.length ? ' · kya hua' : ''}</summary>
        <div class="levels">
          <div><span>${esc(p.symbol)} entry</span>${p.entry}</div>
          <div><span>SL</span><b class="neg">${p.stopLoss}</b></div>
          <div><span>Target 1</span><b class="pos">${p.target1}</b></div>
          <div><span>Target 2</span><b class="pos">${v(p.target2)}</b></div>
        </div>
        ${p.flags?.length ? `<div class="flags">${p.flags.map((f) => `<span class="flag ${f.ok ? 'ok' : 'bad'}">${f.ok ? '✅' : '❌'} ${esc(f.text)}</span>`).join('')}</div>` : ''}
        ${p.reasons?.length ? `<h4>Kyun ${p.signal}?</h4><ul>${p.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${r.reasons?.length || p.result.reasons?.length ? `<h4>${r.code === 'SL' ? 'SL kyun laga' : 'Kya hua'}</h4><ul>${(p.result.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      </details>
    </article>`;
  }

  function renderPicks(r) {
    pkData = r;
    const s = r.summary;
    const bestOnly = pkForm.show.value === 'best';
    const shown = bestOnly ? r.picks.filter((p) => p.best) : r.picks;
    const hidden = r.picks.filter((p) => !p.best);
    const monies = shown.map(money).filter(Boolean);
    const closed = monies.filter((m) => m.result);
    const net = closed.reduce((a, m) => a + m.result.net, 0);
    const gross = closed.reduce((a, m) => a + m.result.gross, 0);
    const rk = r.risk;
    const tile = (k, val, sub = '', c = '') => `<div class="tile ${c}"><span>${k}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const none = r.noSignal.length
      ? `<details class="card more"><summary>${r.noSignal.length} me koi trade nahi</summary><p class="muted sm">${r.noSignal.map((x) => esc(x.symbol)).join(', ')}</p></details>`
      : '';
    const errs = r.errors.length ? `<p class="muted sm">⚠ ${r.errors.length} ka data nahi mila: ${r.errors.map((x) => esc(x.symbol)).join(', ')}</p>` : '';
    $('#pkResult').innerHTML = `
      <div class="card">
        <div class="card-head" style="margin:0 0 12px"><h2>${dayLabel(r.date)}</h2><span class="muted sm">${esc(r.strategy)}${r.running ? ' · <span class="chip live">live</span>' : ''}</span></div>
        <div class="tiles">
          ${tile(bestOnly ? '⭐ BEST signals' : 'Signals', bestOnly ? `${shown.length} <span class="muted sm">/ ${s.signals}</span>` : s.signals, bestOnly ? `${hidden.length} filter se bahar` : `${s.scanned} scan kiye`)}
          ${tile('Target / SL / Time', (() => { const c = (k) => shown.filter((p) => (p.premium?.result?.code || p.result.code) === k).length; return `<span class="pos">${c('TP1') + c('TP2') + c('TRAIL_SL')}</span> / <span class="neg">${c('SL')}</span> / ${c('TIME') + c('EOD')}`; })(), 'option chart pe')}
          ${tile(bestOnly ? 'BEST liye hote (net)' : 'Sab liye hote (net)', rupee(net, true), `gross ${rupee(gross, true)} · ${closed.length} trades${r.running ? ' · abhi ke bhav pe' : ''}`, cls(net))}
          ${rk ? tile('Risk / trade', rupee(rk.riskPerTrade), `capital ${rupee(rk.capital)} × ${rk.riskPct}%`) : ''}
        </div>
      </div>
      <h3 class="section-title">⭐ Din ka 1 trade <span class="muted sm">sabse pehla BEST (3/3 flags, liquid, 11:00 se pehle)</span></h3>
      ${r.best
        ? `<div class="tickets">${pickCard(r.best, { featured: true })}</div>`
        : `<p class="empty">${r.picks.length ? `${r.picks.length} signal aaye, par kisi me teeno flags hare nahi. <b>Aaj trade mat lo</b> - ye bhi ek faisla hai.` : 'Aaj koi setup nahi bana.'}</p>`}
      ${shown.length ? `<h3 class="section-title">${bestOnly ? '⭐ BEST signals' : 'Saare signals'} <span class="muted sm">latest sabse upar</span></h3>` : ''}
      <div class="tickets">${[...shown].reverse().map((p) => pickCard(p)).join('') || `<p class="empty">${bestOnly && r.picks.length ? `${r.picks.length} signal aaye, par koi BEST filter pass nahi hua. <b>Aaj trade mat lo</b> - ye bhi ek faisla hai.` : 'Is din kisi me setup nahi bana. Aise din trade na karna hi sahi hai.'}</p>`}</div>
      ${bestOnly && hidden.length ? `<details class="card more"><summary>${hidden.length} signal BEST filter se bahar (kyun)</summary><ul>${hidden.map((p) => `<li><b>${esc(p.symbol)}</b> ${p.time} ${p.signal} — ${esc(p.notBestWhy.join(', '))}</li>`).join('')}</ul></details>` : ''}
      ${none}${errs}`;
  }

  // Lots / BEST badle -> bina dobara scan ke hisaab update
  for (const el of [pkForm.lots, pkForm.show]) {
    el.addEventListener('change', () => {
      if (pkData) renderPicks(pkData);
    });
  }

  pkForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#pkError').textContent = '';
    const fd = Object.fromEntries(new FormData(pkForm).entries());
    const btn = $('#pkRun');
    btn.disabled = true;
    btn.textContent = fd.universe === 'index' ? 'Scanning…' : 'Scanning ~210 stocks (1-2 min)…';
    try {
      renderPicks(await api(`/picks?date=${fd.date}&universe=${fd.universe}&strat=${fd.strat}`));
    } catch (err) {
      $('#pkError').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '🔍 Scan';
    }
  });
  pkForm.date.value = dayKey(d); // pichhla trading din

  // ================= PAPER TRADING =================
  const ppForm = $('#ppForm');
  const ppQs = () => `universe=${ppForm.universe.value}&strat=${ppForm.strat.value}`;

  function renderPaper(s) {
    if (!s.days) {
      $('#ppBox').innerHTML = '<p class="empty">Abhi koi record nahi. "Pichhle 30 din bharo" dabao, ya kal 3:35 PM ke baad dekho.</p>';
      return;
    }
    const rows = s.rows
      .map((t) => t.noTrade
        ? `<tr><td>${dayShort(t.day)}</td><td class="muted" colspan="3">${esc(t.reason || 'Koi setup nahi')}</td><td class="num">–</td></tr>`
        : `<tr><td>${dayShort(t.day)}</td><td><b>${esc(t.symbol)}</b> <span class="badge ${t.signal === 'BUY CE' ? 'buy' : 'sell'}">${t.signal}</span><br><span class="muted sm">${t.time} · ${esc(t.option)}</span></td>
            <td class="sm">${RES_ICON[t.result?.code] || ''} ${esc(t.result?.text || '')}</td><td class="num">${t.points ?? '–'}</td>
            <td class="num ${cls(t.netPnl)}"><b>${inr(t.netPnl)}</b></td></tr>`)
      .join('');
    $('#ppBox').innerHTML = `
      <div class="stats">
        ${stat('Total P&amp;L (charges ke baad)', inr(s.net), cls(s.net))}
        ${stat('Din', `${s.days} <span class="muted sm">(${s.trades} trade, ${s.noTradeDays} khaali)</span>`)}
        ${stat('Profit / Loss', `<span class="pos">${s.wins}</span> / <span class="neg">${s.losses}</span>`)}
        ${stat('Win rate', `${s.winRate}%`)}
        ${stat('Avg / din', inr(s.avgPerDay), cls(s.avgPerDay))}
        ${stat('Sabse bada girna', inr(s.maxDrawdown), 'neg')}
      </div>
      <div class="verdict-line ${s.net > 0 ? 'good' : 'bad'}" style="margin-top:10px">${s.days < 20
        ? 'Abhi 20 din se kam ka record hai - thoda aur wait karo.'
        : s.net > 0
          ? `Paper pe ${s.days} din me ${inr(s.net)} profit. Real me jaane se pehle 1-2 mahina aur dekho.`
          : `Paper pe ${s.days} din me ${inr(s.net)} loss. Real paisa mat lagao - paisa bach gaya.`}</div>
      <details style="margin-top:10px"><summary class="sm">Mahine-wise</summary><div class="table-wrap"><table><tr><th>Month</th><th class="num">Trades</th><th class="num">P&amp;L</th></tr>${s.monthly
        .map((m) => `<tr><td>${m.month}</td><td class="num">${m.trades}</td><td class="num ${cls(m.net)}">${inr(m.net)}</td></tr>`)
        .join('')}</table></div></details>
      <h3>Roz ka record</h3>
      <div class="table-wrap"><table class="stack"><tr><th>Din</th><th>Trade</th><th>Kya hua</th><th class="num">Pts</th><th class="num">P&amp;L</th></tr>${rows}</table></div>`;
  }

  async function loadPaper() {
    try {
      renderPaper(await api(`/paper?${ppQs()}`));
    } catch (err) {
      $('#ppBox').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }
  ppForm.addEventListener('change', loadPaper);

  $('#ppFill').addEventListener('click', async () => {
    const b = $('#ppFill');
    b.disabled = true;
    b.textContent = 'Bhar raha hai… (1-2 min)';
    try {
      const r = await api('/paper/backfill', { method: 'POST', body: { universe: ppForm.universe.value, strat: ppForm.strat.value, days: 30 } });
      toast(`${r.added} din record hue`);
      await loadPaper();
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
      b.textContent = 'Pichhle 30 din bharo';
    }
  });

  $('#ppClear').addEventListener('click', async () => {
    if (!confirm('Is paper record ko clear karna hai?')) return;
    try {
      await api(`/paper?${ppQs()}`, { method: 'DELETE' });
      loadPaper();
    } catch (err) {
      toast(err.message);
    }
  });

  // ================= ASLI OPTION BACKTEST =================
  const obForm = $('#obForm');
  const PRESETS = {
    ifExpiry: { setup: 'ironFly', onlyExpiryDay: true },
    ifDaily: { setup: 'ironFly' },
    orbBuy: { setup: 'buyOrb', orMinutes: 30 },
  };
  let obRun = null;
  let obFilter = 'all';

  const legText = (l) =>
    `<tr><td><span class="badge ${l.side === 'SELL' ? 'sell' : 'buy'}">${l.side}</span></td><td>${l.type} ${l.strike}</td>
     <td class="num">${l.entry}</td><td class="num">${l.exit}</td><td>${l.exitT || ''} ${l.reason === 'SL' ? '🛑' : l.reason === 'TARGET' ? '🎯' : ''} ${esc(l.reason)}</td>
     <td class="num ${cls(l.pnl ?? 0)}">${l.pnl != null ? inr(l.pnl) : ''}</td></tr>`;

  function obDayCard(t, open) {
    return `<details class="day ${t.net > 0 ? 'win' : 'loss'}" ${open ? 'open' : ''}>
      <summary><span class="d-title">${dayShort(t.day)}${t.day === t.expiry ? ' · expiry' : ''}</span>
        <span class="d-meta">spot ${Math.round(t.spot)} · ATM ${t.atm}${t.credit != null ? ` · credit ${t.credit}` : ''}</span>
        <span class="d-pnl ${cls(t.net)}">${inr(t.net)}</span></summary>
      <div class="day-body">
        <div class="table-wrap"><table><tr><th></th><th>Option</th><th class="num">Entry</th><th class="num">Exit</th><th>Kab / kyun</th><th class="num">P&amp;L</th></tr>${t.legs.map(legText).join('')}</table></div>
        ${t.events.length ? `<ul class="timeline">${t.events.map((e) => `<li><time>${e.t}</time><span>${esc(e.text)}</span></li>`).join('')}</ul>` : ''}
        <p class="muted sm">Gross ${inr(t.gross)} · charges ${inr(t.charges)} · qty ${t.qty}</p>
      </div></details>`;
  }

  function renderObDays() {
    const list = obRun.trades.filter((t) => (obFilter === 'win' ? t.net > 0 : obFilter === 'loss' ? t.net <= 0 : true)).slice().reverse();
    $('#obDays').innerHTML = list.length ? list.slice(0, 250).map((t, i) => obDayCard(t, i === 0)).join('') + (list.length > 250 ? `<p class="muted sm">+${list.length - 250} aur din (CSV/range chhota karke dekho)</p>` : '') : '<p class="empty">Koi din nahi</p>';
  }

  function renderOb(r) {
    obRun = r;
    obFilter = 'all';
    const s = r.summary;
    const good = s.net > 0 && s.profitFactor >= 1.3 && s.trades >= 30;
    const verdict = s.trades < 30
      ? 'Trades 30 se kam - lamba range lo.'
      : good
        ? 'Is period me asli premium pe profit. Doosre period pe bhi check karo, phir paper trade.'
        : s.net > 0
          ? 'Thoda profit, par edge kamzor (profit factor 1.3 se kam).'
          : 'Asli premium + charges ke baad LOSS. Ye setup in settings me live mat lo.';
    $('#obResult').innerHTML = `
      <div class="stats" style="margin-top:12px">
        ${stat('Net P&amp;L', inr(s.net), cls(s.net))}
        ${stat('Trade din', `${s.trades} <span class="muted sm">/ ${r.tradingDays}</span>`)}
        ${stat('Win rate', `${s.winRate}%`)}
        ${stat('Avg / trade', inr(s.avgPerTrade), cls(s.avgPerTrade))}
        ${stat('Max drawdown', inr(s.maxDrawdown), 'neg')}
        ${stat('Lagatar loss (max)', s.maxLossStreak)}
        ${stat('Profit wale mahine', `${s.greenMonths} / ${s.months}`)}
        ${stat('Margin / lot (aaj)', r.marginPerLot ? inr(r.marginPerLot) : '–')}
        ${stat('Fund chahiye', r.capitalNeeded ? inr(r.capitalNeeded) : '–')}
        ${stat('Return (fund pe)', r.returnOnCapital != null ? `${r.returnOnCapital}%` : '–', cls(r.returnOnCapital))}
      </div>
      <div class="verdict-line ${good ? 'good' : s.net > 0 ? 'meh' : 'bad'}" style="margin-top:10px">${esc(verdict)}</div>
      <p class="muted sm">Fund chahiye = aaj ka margin × lots + max drawdown (bura daur jhelne ke liye). Charges asli (brokerage ₹${r.params.brokeragePerOrder}/order + STT/GST).</p>
      <details><summary class="sm">Mahine-wise</summary><div class="table-wrap"><table><tr><th>Month</th><th class="num">Net</th></tr>${s.monthly.map((m) => `<tr><td>${m.month}</td><td class="num ${cls(m.net)}">${inr(m.net)}</td></tr>`).join('')}</table></div></details>
      <div class="row between" style="margin:10px 0">
        <div class="chips" id="obChips"><button class="on" data-f="all">Sab</button><button data-f="win">Profit</button><button data-f="loss">Loss</button></div>
      </div>
      <div class="days" id="obDays"></div>`;
    renderObDays();
  }

  $('#obResult').addEventListener('click', (ev) => {
    const b = ev.target.closest('#obChips button');
    if (!b) return;
    obFilter = b.dataset.f;
    document.querySelectorAll('#obChips button').forEach((x) => x.classList.toggle('on', x === b));
    renderObDays();
  });

  obForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#obError').textContent = '';
    const fd = Object.fromEntries(new FormData(obForm).entries());
    const body = { ...PRESETS[fd.preset], symbol: fd.symbol, from: fd.from, to: fd.to, lots: fd.lots };
    for (const k of ['wing', 'slPct', 'slMode', 'combinedSlPct', 'entryTime']) if (fd[k] !== '' && fd[k] != null) body[k] = fd[k];
    const btn = $('#obRun');
    btn.disabled = true;
    btn.textContent = 'Running… (pehli baar data download me time lagta hai)';
    try {
      renderOb(await api('/option-backtest', { method: 'POST', body }));
    } catch (err) {
      $('#obError').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Run';
    }
  });
  obForm.from.value = '2025-01-01';
  obForm.to.value = dayKey(d);

  // ================= CAPITAL PROTECTION =================
  const meter = (used, limit) => {
    const pct = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
    return `<div class="meter"><span style="width:${pct}%" class="${pct >= 100 ? 'full' : pct >= 66 ? 'warn' : ''}"></span></div>`;
  };

  async function loadRisk() {
    try {
      const r = await api('/risk');
      const R = r.rules;
      const stateText = { OK: '✅ Trade allowed', STOP_DAY: '🛑 Aaj STOP', STOP_MONTH: '🛑 Mahina STOP' }[r.state] || r.state;
      $('#riskState').textContent = stateText;
      $('#riskState').className = `state-pill ${r.state === 'OK' ? 'ok' : 'stop'}`;
      const todayLoss = Math.max(0, -r.today.pnl);
      const monthLoss = Math.max(0, -r.month.pnl);
      $('#riskBody').innerHTML = `
        ${stat(R.capitalFrom === 'upstox' ? 'Capital (Upstox balance)' : 'Capital', inr(R.capital))}
        ${stat('Max loss / trade', `${inr(R.riskPerTrade)} <span class="muted sm">(${R.riskPct}%)</span>`)}
        <div class="stat"><div class="k">Aaj ka P&amp;L <span class="muted">(limit −${inr(R.dailyLossLimit)})</span></div><div class="v ${cls(r.today.pnl)}">${inr(r.today.pnl)}</div>${meter(todayLoss, R.dailyLossLimit)}</div>
        <div class="stat"><div class="k">Aaj ke trades</div><div class="v">${r.today.trades} / ${R.maxTradesPerDay}</div>${meter(r.today.trades, R.maxTradesPerDay)}</div>
        <div class="stat"><div class="k">Is mahine <span class="muted">(limit −${inr(R.monthlyLossLimit)})</span></div><div class="v ${cls(r.month.pnl)}">${inr(r.month.pnl)}</div>${meter(monthLoss, R.monthlyLossLimit)}</div>`;
      $('#riskReasons').innerHTML =
        r.reasons.map((x) => `<p class="warn">🛑 ${esc(x)}</p>`).join('') +
        (r.errors?.length ? `<p class="muted sm">⚠ ${esc(r.errors.join(' · '))}</p>` : '') +
        `<p class="muted sm">P&amp;L source: ${r.today.source === 'upstox' ? 'Upstox positions (live, charges andaza)' : 'Journal'}.</p>`;
      const f = $('#rulesForm');
      if (!$('#rulesBox').open) {
        for (const k of ['capital', 'riskPct', 'maxTradesPerDay', 'dailyLossPct', 'monthlyLossPct']) f[k].value = R[k];
        f.noExpiryDay.value = String(R.noExpiryDay);
        f.capitalSource.value = R.capitalSource || 'upstox';
      }
    } catch (err) {
      $('#riskBody').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  $('#rulesForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/risk/rules', { method: 'PUT', body: Object.fromEntries(new FormData(ev.target).entries()) });
      $('#rulesBox').open = false;
      toast('Rules save ho gaye');
      loadRisk();
    } catch (err) {
      toast(err.message);
    }
  });

  // ================= MERA ASLI RECORD =================
  const bt = (rows, keyLabel) =>
    `<div class="table-wrap"><table><tr><th>${keyLabel}</th><th class="num">Trades</th><th class="num">Win%</th><th class="num">Charges</th><th class="num">Net</th></tr>${rows
      .map((x) => `<tr><td>${esc(x.key)}</td><td class="num">${x.trades}</td><td class="num">${x.winRate}%</td><td class="num">${inr(x.charges)}</td><td class="num ${cls(x.net)}">${inr(x.net)}</td></tr>`)
      .join('')}</table></div>`;

  function renderBroker(a) {
    if (!a.synced) return;
    const s = a.summary;
    if (!s.trades) {
      $('#brokerBox').innerHTML = '<p class="muted">Upstox pe pichhle 3 saal me koi F&amp;O trade nahi mila.</p>';
      return;
    }
    const best = a.whatIf.reduce((m, w) => (w.net > m.net ? w : m), a.whatIf[0]);
    $('#brokerBox').innerHTML = `
      <p class="muted sm">${s.from} → ${s.to} · ${s.tradingDays} trading din · sync ${new Date(a.syncedAt).toLocaleString('en-IN')}</p>
      <div class="stats">
        ${stat('Net P&amp;L (charges ke baad)', inr(s.net), cls(s.net))}
        ${stat('Gross (charges se pehle)', inr(s.gross), cls(s.gross))}
        ${stat('Charges (andaza)', inr(s.charges), 'neg')}
        ${stat('Trades', `${s.trades} <span class="muted sm">(${(s.trades / s.tradingDays).toFixed(1)}/din)</span>`)}
        ${stat('Win rate', `${s.winRate}%`)}
        ${stat('Avg profit / loss', `<span class="pos">${inr(s.avgWin)}</span> / <span class="neg">${inr(s.avgLoss)}</span>`, 'sm')}
      </div>
      ${a.insights.length ? `<h3>Paisa kahan ja raha hai</h3>${a.insights.map((i) => `<p class="warn">${esc(i.text)}</p>`).join('')}` : ''}
      <h3>Agar rules follow hote to?</h3>
      <div class="list">${a.whatIf
        .map((w) => `<div class="item"><div class="top"><span>Din me max <b>${w.maxTrades}</b> trade, <b>${w.maxLosses}</b> loss ke baad band</span><b class="${cls(w.net)}">${inr(w.net)}</b></div>
          <span class="muted sm">${w.trades} trades · asli se ${inr(w.net - s.net)} ${w.net >= s.net ? 'behtar' : 'kharab'}</span></div>`)
        .join('')}</div>
      ${best.net > s.net ? `<p class="verdict-line good" style="margin-top:10px">Sirf "din me ${best.maxTrades} trade" rule se ${inr(best.net - s.net)} bachte. Capital protection me "Max trades / din" rule isi liye hai (Signals → Rules badlo).</p>` : ''}
      <details><summary class="sm">Detail breakdown</summary>
        <h3>Din me kitne trades kiye</h3>${bt(a.byTradesPerDay, 'Trades/din')}
        <h3>Expiry day vs normal</h3>${bt(a.byExpiryDay, 'Din')}
        <h3>Premium (option kitne ka)</h3>${bt(a.byPremium, 'Premium')}
        <h3>Symbol</h3>${bt(a.bySymbol, 'Symbol')}
        <h3>CE / PE</h3>${bt(a.byType, 'Type')}
        <h3>Mahine</h3>${bt(a.byMonth, 'Month')}
        <h3>Sabse bure din</h3>${bt(a.worstDays.map((d) => ({ ...d, key: d.day })), 'Date')}
      </details>`;
  }

  async function loadBroker() {
    try {
      renderBroker(await api('/broker/analysis'));
    } catch { /* ignore until synced */ }
  }

  $('#btnSyncBroker').addEventListener('click', async () => {
    const b = $('#btnSyncBroker');
    b.disabled = true;
    b.textContent = 'Syncing…';
    try {
      const r = await api('/broker/sync', { method: 'POST', body: {} });
      toast(`${r.trades} trades Upstox se aaye`);
      await loadBroker();
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
      b.textContent = '↻ Upstox se sync';
    }
  });

  let tab = 'picks';
  try { tab = localStorage.getItem('fno_tab') || 'picks'; } catch { /* ignore */ }
  showTab(tab);
  loadStatus();
  loadSymbols();
  loadParams();
  loadRisk();
  loadBroker();
  loadAuto();
  loadPaper();
  setInterval(loadStatus, 30000);
  setInterval(loadRisk, 60000);
})();
