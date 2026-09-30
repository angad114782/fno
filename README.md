# F&O Trade Reporter (Node.js + MongoDB)

Stock market **F&O trade journal + reporter**: BUY/SELL, entry, SL, TP1, TP2 aur exit, indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50, SENSEX, BANKEX) aur stocks dono ke liye.

- Options (CE/PE) aur futures, BUY aur SELL (short) dono
- LTP daalte hi SL, TP1 aur TP2 **auto check** hote hain. TP1 pe partial booking hoti hai aur SL cost pe shift ho jata hai
- Manual exit (full ya partial), SL/TP modify (trailing), cancel
- P&L (gross, charges, net), R:R, R-multiple, win rate, profit factor, max drawdown, TP1/TP2/SL hit rate
- Daily / monthly / underlying / strategy wise report, plus CSV export
- WhatsApp alerts (Cloud API template: signal, T1 / T2 / SL / time-stop exit, trade events) aur roz ki P&L report
- TradingView (ya kisi bhi) alert ke liye webhook
- Browser dashboard: `http://localhost:5000`

---

## 1. `.env` me kya chahiye

`.env.example` ko copy karke `.env` banao:

```bash
cp .env.example .env
```

| Variable | Zaroori? | Kya hai |
|---|---|---|
| `MONGO_URI` | **Haan** | MongoDB connection string. Local: `mongodb://127.0.0.1:27017/fno_reporter`, Atlas: `mongodb+srv://user:pass@cluster.mongodb.net/fno_reporter` |
| `PORT` | Nahi (5000) | Server port |
| `API_KEY` | Recommended | Set karoge to har API call pe header `x-api-key` chahiye hoga. Dashboard ek baar puchta hai |
| `WEBHOOK_SECRET` | Webhook ke liye | TradingView alert body me `"secret"` isi se match hona chahiye |
| `TP1_EXIT_PERCENT` | Nahi (50) | TP1 hit hone par kitna % qty book karni hai (lot size me round-down hota hai) |
| `MOVE_SL_TO_COST_ON_TP1` | Nahi (true) | TP1 ke baad SL ko entry price pe shift karna hai ya nahi |
| `BROKERAGE_PER_ORDER` | Nahi (20) | Har executed order (entry + har exit) ki brokerage |
| `WHATSAPP_TOKEN` | Optional | Meta WhatsApp Cloud API token (permanent system-user token) |
| `WHATSAPP_PHONE_NUMBER_ID` | Optional | WhatsApp → API Setup wala phone number id |
| `WHATSAPP_TO` | Optional | Alert kis number pe (country code ke saath, comma se kai) |
| `WHATSAPP_TEMPLATE` / `_LANG` / `_PARAMS` | Optional | Approved template (default `lead_notification`, `en`, 5 body params). Alert ki har line ek param me jaati hai |
| `DAILY_REPORT_TIME` | Optional | Mon–Fri is time (HH:MM, IST) pe din ki report WhatsApp pe aayegi |
| `REPORT_TIMEZONE` | Nahi | Default `Asia/Kolkata` |

Minimum setup ke liye sirf `MONGO_URI` kaafi hai.

## 2. Run karna

```bash
npm install
npm start          # ya: npm run dev  (auto-restart)
npm test           # trade engine ke unit tests
```

Pehli baar start hone par default indices (lot size ke saath) DB me apne aap add ho jaate hain.

> **Lot size check kar lena.** NSE/BSE lot size time-to-time revise karte hain. Seed values `src/config/indices.js` me hain. Update karne ke liye:
> `PATCH /api/instruments/NIFTY  {"lotSize": 75}`
> Stock F&O ke liye instrument add karo: `POST /api/instruments {"symbol":"RELIANCE","type":"STOCK","lotSize":500}`
> (Ya trade banate waqt `lotSize` directly pass kar do.)

## 3. SL / TP1 / TP2 logic

| Side | Levels ka order |
|---|---|
| BUY | `SL < Entry < TP1 < TP2` |
| SELL | `SL > Entry > TP1 > TP2` |

Jab bhi LTP update hota hai (dashboard, `/price` API, bulk `/api/prices`, ya webhook se):

1. **SL** sabse pehle check hota hai. Hit hua to poori open qty **LTP pe** exit hoti hai (gap-down ho to real loss dikhe).
2. **TP1** hit hua to `TP1_EXIT_PERCENT` qty TP1 price pe book hoti hai, aur SL entry (cost) pe shift ho jata hai.
   - TP2 set nahi hai to poori qty TP1 pe book hoti hai.
   - Sirf 1 lot hai to TP1 sirf mark hota hai aur SL cost pe aa jata hai. Baaki qty TP2 ya trail SL pe nikalti hai.
3. **TP2** hit hua to bachi hui qty TP2 pe book hoti hai.
4. TP1 ke baad SL hit ho to exit reason `TRAIL_SL` likha jata hai.

Status flow: `OPEN → PARTIAL → CLOSED` (ya `CANCELLED`). Result: `WIN / LOSS / BREAKEVEN` (net P&L ke hisaab se).

## 4. API

Agar `API_KEY` set hai to har request ke saath header `x-api-key: <API_KEY>` bhejo.

### Trade create

```http
POST /api/trades
{
  "underlying": "NIFTY",
  "segment": "OPT",            // OPT | FUT
  "optionType": "CE",          // CE | PE (sirf OPT)
  "strike": 25000,
  "expiry": "2026-10-27",
  "side": "BUY",               // BUY | SELL
  "lots": 2,                   // qty = lots x lotSize
  "entryPrice": 150,
  "stopLoss": 120,
  "target1": 190,
  "target2": 240,
  "strategy": "ORB",
  "tags": ["scalp"],
  "notes": "gap up + OI buildup"
}
```

Trading symbol apne aap ban jata hai: `NIFTY 27OCT26 25000 CE` / `BANKNIFTY 27OCT26 FUT`.

### Baaki endpoints

| Method | Path | Kaam |
|---|---|---|
| GET | `/api/trades?status=OPEN,PARTIAL&underlying=NIFTY&from=2026-09-01&to=2026-09-30` | List (page, limit bhi) |
| GET | `/api/trades/:id` | Ek trade |
| PATCH | `/api/trades/:id` | `stopLoss`, `target1`, `target2`, `notes`, `strategy`, `tags`, `extraCharges` badlo |
| POST | `/api/trades/:id/price` | `{ "ltp": 175 }` → auto SL/TP check |
| POST | `/api/trades/:id/exit` | `{ "price": 200, "quantity": 65 }` (qty khali = full exit) |
| POST | `/api/trades/:id/cancel` | Bina exit wala OPEN trade cancel |
| DELETE | `/api/trades/:id` | Delete |
| POST | `/api/prices` | Bulk LTP: `[{ "symbol": "NIFTY 27OCT26 25000 CE", "ltp": 180 }]` |
| GET | `/api/reports?from=&to=&underlying=` | Summary, daily, monthly, byUnderlying, byStrategy, bySide |
| GET | `/api/reports/summary` · `/daily` · `/monthly` · `/by-underlying` · `/by-strategy` | Alag alag hisse |
| GET | `/api/reports/day?date=2026-09-26` | Ek din ki report |
| GET | `/api/reports/export.csv?from=&to=` | CSV download |
| POST | `/api/reports/whatsapp` | Aaj ki report WhatsApp pe bhejo |
| GET/POST/PATCH/DELETE | `/api/instruments[/:symbol]` | Indices/stocks aur lot size |
| GET | `/api/health` | Server + DB status |

### Webhook (TradingView alerts)

URL: `POST http://<server>/api/webhook` (isme API key nahi, `secret` lagta hai)

```json
{ "secret": "WEBHOOK_SECRET", "action": "BUY", "underlying": "NIFTY", "segment": "OPT",
  "optionType": "CE", "strike": 25000, "expiry": "2026-10-27", "lots": 1,
  "entryPrice": 150, "stopLoss": 120, "target1": 190, "target2": 240 }

{ "secret": "WEBHOOK_SECRET", "action": "PRICE", "symbol": "NIFTY 27OCT26 25000 CE", "ltp": 175 }

{ "secret": "WEBHOOK_SECRET", "action": "EXIT",  "symbol": "NIFTY 27OCT26 25000 CE", "price": 170 }
```

## 5. Upstox live data, signals aur backtest

### Setup (ek baar)
1. https://account.upstox.com/developer/apps pe **New App** banao.
2. Redirect URL me exactly ye daalo: `http://localhost:5000/auth/upstox/callback`
3. App ki **API Key** aur **API Secret** `.env` me `UPSTOX_API_KEY` / `UPSTOX_API_SECRET` me daalo, phir server restart karo.
4. Dashboard pe **Connect Upstox** dabao aur Upstox me login karo. Token roz subah ~3:30 AM expire hota hai, isliye har trading day ek baar connect karna padega.
   (Upstox ka long-validity *Analytics Token* hai to `UPSTOX_ACCESS_TOKEN` me daal do, phir roz login nahi karna padega.)

### Signals tab
- **Analyze**: koi bhi index ya F&O stock (NIFTY, BANKNIFTY, RELIANCE...) daalo. System 5 checks karta hai:
  VWAP, EMA 9/21, Supertrend (10,3), RSI zone, previous candle breakout. 4/5 ya zyada checks ek taraf hon aur signal **fresh** ho to:
  - **BUY CE** (bullish) / **BUY PE** (bearish), ATM strike, nearest expiry (expiry day 1 PM ke baad next expiry)
  - SL / TP1 / TP2 option premium me (underlying ATR x delta se)
  - **Lots** = (capital × `RISK_PCT`%) / (1 lot ka risk). 1 lot ka risk bhi zyada ho to trade skip karne ko bolta hai
  - Option chain: PCR, max Call OI (resistance), max Put OI (support), expiry day warning
  - Warna **WAIT**
- **Scanner**: kai symbols ek saath scan karo.
- Market hours me `WATCHLIST` har candle close pe auto scan hoti hai. Naya signal WhatsApp pe aata hai (`SIGNAL_ALERTS`). Default `SIGNAL_STRATEGY=scalp` (3 min Momentum Scalp): signal ke baad option LTP track hota hai aur T1 / T2 / SL / 15 min time stop pe EXIT alert aata hai.
- Discipline rules: 9:30 se pehle aur 2:30 ke baad nayi entry nahi, din me max 2 trades, 2 SL ke baad us din band, 3:15 pe square-off.

### Live LTP
Journal me jo trade open hai (Signals se prefill kiya ho ya manually), uska LTP market hours me har `LIVE_POLL_SECONDS` second Upstox se aata hai. SL / TP1 / TP2 apne aap check hote hain (plus WhatsApp alert).
LTP abhi bhi manually, `POST /api/prices` ya webhook se bhi bhej sakte ho.

### Strict mode (default ON)
5 base checks ke upar ye filters bhi pass hone chahiye, warna trade nahi:
- **ADX ≥ 20**: trend me taakat ho (sideways market me trade nahi)
- **Opening range breakout**: LONG sirf 09:15–09:30 ke high ke upar, SHORT low ke neeche
- **15m trend** bhi same direction me
- **Chase nahi**: price VWAP se 1.5 ATR se zyada door ho to entry nahi
- **Strong candle**: signal candle ki body ≥ 50%

**Auto-pause** (`pauseLookback`, default 10): strategy ke pichhle 10 signals ka net loss me ho to naye signal sirf **PAPER** (real paisa nahi). Signals tab "PAPER ONLY" dikhata hai. Backtest diary me paper trades dashed dikhte hain aur total me nahi judte.

Optional: `tp1BookAll` (T1 pe poori qty book, 1 lot ke liye), `timeStopBars` (itne candles me T1 na aaye to exit). Sab Backtest → More settings me.

1 saal NIFTY/BANKNIFTY (5m/15m, 1 lot) test me strict + auto-pause ne purane logic ke comparison me trades aur drawdown kaafi kam kiye. Par Jun–Sep 2026 me ye bhi loss me raha, isliye ise profit ki guarantee mat samjho.

### Backtest tab
Symbol, date range (Jan 2022 ke baad, max ~1 saal ek baar me), timeframe chuno. Jo strategy aur SL/TP logic live chalta hai wahi past candles pe chalta hai:
- Entry signal ke agle candle ke open pe hoti hai. Ek candle me SL aur target dono touch hon to **SL pehle** maana jata hai (pessimistic).
- **Futures** mode: underlying points x qty.
- **Option** mode: premium move = delta x underlying move. Ye approximation hai: **theta decay, IV crush aur bid-ask spread shamil nahi**, isliye real option buying ka result isse kharab aayega. Slippage aur brokerage daal ke test karo.
- Result: win rate, profit factor, expectancy, max drawdown, equity curve, monthly aur CE vs PE breakdown. Har run DB me save hota hai.

**Rule:** jo setting backtest me 30+ trades pe profit factor > 1.3 na de, use live mat lo. Aur backtest me profit aaye tab bhi pehle 1 lot pe live check karo.

### API
| Method | Path | Kaam |
|---|---|---|
| GET | `/auth/upstox/login` | Upstox login (browser) |
| GET | `/api/upstox/status` | Connection + market status |
| GET | `/api/analysis/:symbol?interval=5` | Full analysis + option plan |
| GET | `/api/signals?symbols=NIFTY,RELIANCE` | Scanner |
| GET | `/api/symbols?q=BANK` | F&O symbols search |
| POST | `/api/backtest` | `{ symbol, from, to, interval, mode, lots, delta, slippagePts, params }` |
| GET/DELETE | `/api/backtest[/:id]` | Saved runs |
| POST | `/api/live/poll` | Open trades ka LTP abhi turant |

## 6. Folder structure

```
src/
  server.js            # start + DB connect + seed + scheduler
  app.js               # express routes
  config/              # env, db, default indices
  models/              # Trade, Instrument, BacktestRun, Setting (mongoose)
  services/
    tradeEngine.js     # SL/TP1/TP2, exits, P&L, R:R (pure logic, tested)
    reportEngine.js    # summary / daily / monthly stats (pure)
    tradeService.js    # DB operations
    reportService.js   # reports + CSV
    notifier.js        # WhatsApp Cloud API
    scheduler.js       # daily WhatsApp report
    indicators.js      # EMA, RSI, ATR, VWAP, Supertrend (pure)
    strategy.js        # Trend Confluence signal rules (pure)
    backtest.js        # candle replay backtester (pure)
    upstox.js          # Upstox login, LTP, candles, option chain
    instruments.js     # Upstox instrument master (lot size, expiries, contract keys)
    analysisService.js # live signal + option plan
    backtestService.js # historical data + backtest runs
    liveService.js     # live LTP poll + watchlist signal alerts
  routes/              # trades, prices, reports, instruments, webhook, market, upstoxAuth
public/                # dashboard (HTML/CSS/JS)
test/                  # node:test unit tests
```

> Disclaimer: ye journaling, analysis aur backtesting tool hai. Koi order place nahi karta. Signals rule-based hain, guarantee ya investment advice nahi. F&O me zyada tar retail traders loss karte hain, isliye position size chhota rakho aur SL hamesha lagao.
