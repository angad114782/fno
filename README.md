# F&O Trade Reporter (Node.js + MongoDB)

Stock market **F&O trade journal + reporter**: BUY/SELL, entry, SL, TP1, TP2 aur exit, indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50, SENSEX, BANKEX) aur stocks dono ke liye.

- Options (CE/PE) aur futures, BUY aur SELL (short) dono
- LTP daalte hi SL, TP1 aur TP2 **auto check** hote hain. TP1 pe partial booking hoti hai aur SL cost pe shift ho jata hai
- Manual exit (full ya partial), SL/TP modify (trailing), cancel
- P&L (gross, charges, net), R:R, R-multiple, win rate, profit factor, max drawdown, TP1/TP2/SL hit rate
- Daily / monthly / underlying / strategy wise report, plus CSV export
- Telegram alerts (trade entry, TP1, TP2, SL, exit) aur roz ki P&L report
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
| `TELEGRAM_BOT_TOKEN` | Optional | @BotFather se milne wala bot token |
| `TELEGRAM_CHAT_ID` | Optional | Tumhara chat id (bot ko message bhejo, phir `https://api.telegram.org/bot<TOKEN>/getUpdates` kholo) |
| `DAILY_REPORT_TIME` | Optional | Mon–Fri is time (HH:MM, IST) pe din ki report Telegram pe aayegi |
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
| POST | `/api/reports/telegram` | Aaj ki report Telegram pe bhejo |
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

## 5. Live price ke baare me

Ye app khud broker se live price nahi laata. LTP teen tareeke se aata hai: dashboard pe manually, API se, ya webhook se. Broker API (Zerodha Kite, Angel SmartAPI, Upstox, Dhan) ka feed chahiye to ek chhota script bana ke har kuch second me `POST /api/prices` pe LTP bhej do, SL/TP ka baaki kaam app kar lega.

## 6. Folder structure

```
src/
  server.js            # start + DB connect + seed + scheduler
  app.js               # express routes
  config/              # env, db, default indices
  models/              # Trade, Instrument (mongoose)
  services/
    tradeEngine.js     # SL/TP1/TP2, exits, P&L, R:R (pure logic, tested)
    reportEngine.js    # summary / daily / monthly stats (pure)
    tradeService.js    # DB operations
    reportService.js   # reports + CSV
    notifier.js        # Telegram
    scheduler.js       # daily Telegram report
  routes/              # trades, prices, reports, instruments, webhook
public/                # dashboard (HTML/CSS/JS)
test/                  # node:test unit tests
```

> Disclaimer: ye sirf journaling/reporting tool hai. Koi order place nahi karta aur ye investment advice nahi hai.
