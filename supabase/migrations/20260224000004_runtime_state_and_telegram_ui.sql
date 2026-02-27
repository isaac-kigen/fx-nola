create table if not exists public.strategy_runtime_state (
  strategy_code text not null,
  symbol text not null,
  timeframe text not null,
  bias text not null check (bias in ('BULLISH', 'BEARISH', 'NEUTRAL')),
  state text not null,
  last_candle_ts timestamptz,
  last_fsh_price numeric(16, 8),
  last_fsl_price numeric(16, 8),
  anchor_line numeric(16, 8),
  anchor_index integer,
  causal_extreme numeric(16, 8),
  causal_extreme_index integer,
  midpoint_level numeric(16, 8),
  impulse_pips numeric(10, 2),
  pullback_start_index integer,
  pullback_confirm_index integer,
  pb_low numeric(16, 8),
  pb_high numeric(16, 8),
  s_low numeric(16, 8),
  s_high numeric(16, 8),
  active_trade_key text,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (strategy_code, symbol, timeframe)
);

create table if not exists public.strategy_controls (
  strategy_code text not null,
  symbol text not null,
  timeframe text not null,
  reset_requested boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (strategy_code, symbol, timeframe)
);

alter table public.strategy_trades
  add column if not exists telegram_close_notified_at timestamptz;

alter table public.broker_order_requests
  add column if not exists telegram_executed_notified_at timestamptz;

drop trigger if exists strategy_runtime_state_set_updated_at on public.strategy_runtime_state;
create trigger strategy_runtime_state_set_updated_at
before update on public.strategy_runtime_state
for each row execute procedure public.set_updated_at();

drop trigger if exists strategy_controls_set_updated_at on public.strategy_controls;
create trigger strategy_controls_set_updated_at
before update on public.strategy_controls
for each row execute procedure public.set_updated_at();

alter table public.strategy_runtime_state disable row level security;
alter table public.strategy_controls disable row level security;
