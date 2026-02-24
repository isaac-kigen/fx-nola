create table if not exists public.broker_order_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  signal_key text not null references public.strategy_signals(signal_key) on delete cascade,
  broker text not null default 'ctrader',
  symbol text not null,
  timeframe text not null,
  direction text not null check (direction in ('LONG', 'SHORT')),
  order_type text not null check (order_type in ('MARKET')),
  requested_units numeric(18, 4) not null,
  planned_entry_time timestamptz,
  planned_entry_price numeric(16, 8),
  stop_loss numeric(16, 8) not null,
  take_profit numeric(16, 8) not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'submitted', 'accepted', 'rejected', 'failed', 'cancelled')),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  next_attempt_after timestamptz,
  broker_order_id text,
  broker_position_id text,
  broker_error_code text,
  broker_error_message text,
  execution_event jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists broker_order_requests_status_next_attempt_idx
  on public.broker_order_requests (status, next_attempt_after, created_at);

create index if not exists broker_order_requests_signal_key_idx
  on public.broker_order_requests (signal_key);

drop trigger if exists broker_order_requests_set_updated_at on public.broker_order_requests;
create trigger broker_order_requests_set_updated_at
before update on public.broker_order_requests
for each row execute procedure public.set_updated_at();

alter table public.broker_order_requests disable row level security;
