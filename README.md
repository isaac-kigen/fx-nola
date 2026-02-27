# EURUSD M15 Continuation Signal Engine (Supabase Edge Functions)

This repo scaffolds a full Supabase-based signal engine for the EUR/USD M15 continuation system described in your spec:

- Twelve Data as the 15-minute candle source
- Supabase Edge Function for ingestion + signal generation + Telegram alerts
- Postgres tables for candles, signals, and trades
- Broker execution queue for cTrader order placement
- Cron helper SQL to run every 15 minutes

## Main files

- `supabase/functions/m15-signal-engine/index.ts` - scheduled runtime entrypoint
- `supabase/functions/_shared/strategy.ts` - mechanical strategy engine
- `supabase/migrations/20260224000001_init_signal_system.sql` - DB schema + cron helper
- `supabase/migrations/20260224000002_broker_execution_queue.sql` - cTrader broker order queue
- `supabase/migrations/20260224000003_render_executor_ping_helpers.sql` - optional Render keep-warm/tick cron helpers
- `supabase/migrations/20260224000004_runtime_state_and_telegram_ui.sql` - runtime state + controls + telegram lifecycle fields
- `supabase/migrations/20260224000005_broker_execution_events.sql` - persisted cTrader execution events for broker-driven close detection
- `supabase/functions/telegram-bot/index.ts` - Telegram webhook command UI (`/menu`, `/status`, `/analysis`, ...)
- `executor-server/src/server.js` - Node executor service (polls queue and submits to cTrader Open API)
- `supabase/.env.example` - Supabase Edge Function secrets/template
- `executor-server/.env.example` - Render Node executor env template

## Deploy outline

1. Create a Supabase project.
2. Set Supabase Edge Function secrets from `supabase/.env.example`.
3. Run the SQL migrations (`000001`, `000002`, optional `000003`, `000004`, and `000005`).
4. Deploy the function:
   - `supabase functions deploy m15-signal-engine --no-verify-jwt`
   - `supabase functions deploy telegram-bot --no-verify-jwt`
5. Configure Render web service env from `executor-server/.env.example`, then start the executor server:
   - `cd executor-server && npm install && npm start`
6. Create the main signal cron job with SQL (see `000001` migration comments).
7. Optional on Render Free: create keep-warm and/or backup `/tick` cron jobs (see `000003` migration comments).

## Notes

- The implementation uses confirmed 3-candle fractals and close-only breaks.
- Entry is modeled at the next candle open; if the next candle is not available yet, the signal is stored and notified as `pending_next_open`.
- Invalidation now flips bias deterministically (invalidation = opposite BOS) instead of just resetting.
- The edge function now queues `known_next_open` signals into `broker_order_requests`, and optionally POSTs `EXECUTOR_BASE_URL/webhook/queued`.
- Runtime snapshot is persisted in `strategy_runtime_state` each run and exposed by Telegram `/status` + `/analysis`.
- `/reset_cycle` is implemented via `strategy_controls.reset_requested`.

## cTrader executor notes

- Set `CTRADER_*` env vars for the Node server (see `executor-server/.env.example`).
- Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in Render env for trade execution notifications.
- `CTRADER_SYMBOL_ID` is broker-specific. You must use the cTrader symbol ID for EURUSD on your account/broker.
- The Node service can now size positions by risk (`CTRADER_POSITION_SIZING_MODE=risk_percent`) using cTrader account snapshot figures at execution time.
- In `risk_percent` mode, it enforces a strict pre-trade cap by rounding volume down so projected loss at SL is `<= CTRADER_RISK_PERCENT` (default `1%`) before submit.
- Because orders are `MARKET`, actual realized risk can exceed 1% if fill slippage is adverse. Use `CTRADER_MARKET_SLIPPAGE_BUFFER_PERCENT` (for example `0.10` = size to 90% of budget) to reduce that risk.
- `fixed` mode is still available via `CTRADER_POSITION_SIZING_MODE=fixed`, which uses queued `requested_units` / `CTRADER_ORDER_VOLUME_UNITS`.
- cTrader access tokens expire. This scaffold expects a valid `CTRADER_ACCESS_TOKEN`; add a refresh flow if you want unattended token rotation.
- Risk conversion support in this scaffold is strict and limited to `EURUSD` with account currency `USD` or `EUR`. Other symbols/currencies should fail closed until conversion logic is added.
- Executor sends `🚀 Trade Executed` notifications on successful order submission.
- Executor now listens to broker execution events and sends broker-driven TP/SL close notifications when close reason is identifiable from cTrader payload.
- `m15-signal-engine` still emits TP/SL close notifications from `strategy_trades` as a fallback path.

## Telegram Bot UI

- Configure Supabase function secrets from `supabase/.env.example`, including:
  - `TELEGRAM_ALLOWED_CHAT_IDS` (comma-separated chat id allowlist)
  - `TELEGRAM_WEBHOOK_SECRET`
- Deploy `telegram-bot` function and set Telegram webhook to `https://<project-ref>.functions.supabase.co/telegram-bot`
- Set Telegram webhook secret token (Telegram sends it as `X-Telegram-Bot-Api-Secret-Token`):
  - `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<project-ref>.functions.supabase.co/telegram-bot&secret_token=<TELEGRAM_WEBHOOK_SECRET>`
- Supported commands/buttons:
  - `/menu`, `/status`, `/analysis`, `/trade`, `/last_signal`, `/daily`, `/weekly`, `/debug`, `/reset_cycle`

## Vercel + Render separation

- Supabase Edge Functions run on Supabase, not on Vercel. Put Edge secrets in Supabase project secrets using `supabase/.env.example`.
- If you also have a Vercel app (dashboard/frontend), keep its envs separate from both Supabase and Render.
- Render only needs the Node executor envs in `executor-server/.env.example`.

## Render Free Tier Strategy (sleep-safe)

- Render Free web services spin down after 15 minutes of inactivity (Render docs, checked February 24, 2026).
- This project is already queue-first: the edge function writes `broker_order_requests` before trying to wake Render.
- If Render is asleep, the webhook wake-up may be slow; the queued request remains in Supabase and the executor will process it on startup.
- For better reliability on Free tier, use one of these patterns:
1. Keep-awake ping every 10-14 minutes to `GET /health` on Render (simple, but consumes your monthly free instance hours continuously).
2. Sleep-tolerant mode (recommended on Free): do not try to keep it awake 24/7, rely on queue + webhook + retries in `broker_order_requests`.
3. Hybrid: only keep awake during market sessions you trade (for example London/NY overlap), let it sleep outside those windows.

## Render Free Tier constraints that matter here

- Free Render web services spin down after 15 minutes idle.
- Render supports outbound WebSocket connections (needed for cTrader Open API).
- WebSocket connections can still drop due to restarts/maintenance, so the executor reconnect logic is necessary.
