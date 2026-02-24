-- Extensions
create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Core candle storage
create table if not exists public.market_candles (
  id bigint generated always as identity primary key,
  symbol text not null,
  timeframe text not null,
  ts timestamptz not null,
  open numeric(16, 8) not null,
  high numeric(16, 8) not null,
  low numeric(16, 8) not null,
  close numeric(16, 8) not null,
  volume numeric(20, 6),
  source text not null default 'twelvedata',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (symbol, timeframe, ts)
);

create index if not exists market_candles_symbol_tf_ts_idx
  on public.market_candles (symbol, timeframe, ts desc);

-- Signals
create table if not exists public.strategy_signals (
  id uuid primary key default gen_random_uuid(),
  signal_key text not null unique,
  strategy_code text not null,
  symbol text not null,
  timeframe text not null,
  direction text not null check (direction in ('LONG', 'SHORT')),
  bos_time timestamptz not null,
  trigger_time timestamptz not null,
  planned_entry_time timestamptz,
  planned_entry_price numeric(16, 8),
  entry_status text not null check (entry_status in ('pending_next_open', 'known_next_open')),
  stop_loss numeric(16, 8) not null,
  take_profit numeric(16, 8) not null,
  impulse_pips numeric(10, 2) not null,
  anchor_line numeric(16, 8) not null,
  causal_extreme numeric(16, 8) not null,
  pb_level numeric(16, 8) not null,
  pullback_swing_target numeric(16, 8) not null,
  cause_fractal_type text not null check (cause_fractal_type in ('FSH', 'FSL')),
  cause_fractal_index integer not null,
  trigger_candle_index integer not null,
  bos_to_pb_start_candles integer not null,
  pb_start_to_confirm_candles integer not null,
  confirm_to_trigger_candles integer not null,
  status text not null default 'new',
  telegram_notified_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists strategy_signals_symbol_tf_trigger_idx
  on public.strategy_signals (symbol, timeframe, trigger_time desc);

create index if not exists strategy_signals_unnotified_idx
  on public.strategy_signals (telegram_notified_at, trigger_time)
  where telegram_notified_at is null;

-- Trades derived from signals
create table if not exists public.strategy_trades (
  id uuid primary key default gen_random_uuid(),
  trade_key text not null unique,
  signal_key text not null references public.strategy_signals(signal_key) on delete cascade,
  symbol text not null,
  timeframe text not null,
  direction text not null check (direction in ('LONG', 'SHORT')),
  entry_time timestamptz not null,
  entry_price numeric(16, 8) not null,
  stop_loss numeric(16, 8) not null,
  take_profit numeric(16, 8) not null,
  exit_time timestamptz,
  exit_price numeric(16, 8),
  exit_reason text check (exit_reason in ('TP', 'SL')),
  r_multiple numeric(10, 2),
  status text not null check (status in ('OPEN', 'CLOSED')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists strategy_trades_symbol_tf_entry_idx
  on public.strategy_trades (symbol, timeframe, entry_time desc);

-- Updated-at trigger helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists strategy_signals_set_updated_at on public.strategy_signals;
create trigger strategy_signals_set_updated_at
before update on public.strategy_signals
for each row execute procedure public.set_updated_at();

drop trigger if exists strategy_trades_set_updated_at on public.strategy_trades;
create trigger strategy_trades_set_updated_at
before update on public.strategy_trades
for each row execute procedure public.set_updated_at();

-- Optional: RLS (disabled by default for service-role-only writes)
alter table public.market_candles disable row level security;
alter table public.strategy_signals disable row level security;
alter table public.strategy_trades disable row level security;

-- Cron helpers
create or replace function public.invoke_m15_signal_engine(
  project_ref text,
  cron_secret text
)
returns bigint
language plpgsql
security definer
as $$
declare
  request_id bigint;
begin
  select net.http_post(
    url := format('https://%s.functions.supabase.co/m15-signal-engine', project_ref),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body := '{}'::jsonb
  ) into request_id;

  return request_id;
end;
$$;

comment on function public.invoke_m15_signal_engine(text, text) is
'Calls the Supabase Edge Function m15-signal-engine via pg_net. Use with pg_cron.';

-- Example scheduler setup (run manually after deploy):
-- select cron.schedule(
--   'eurusd-m15-signal-engine',
--   '*/15 * * * *',
--   $$ select public.invoke_m15_signal_engine('your-project-ref', 'your-cron-secret'); $$
-- );

-- To remove:
-- select cron.unschedule('eurusd-m15-signal-engine');
