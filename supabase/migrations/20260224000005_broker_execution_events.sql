create table if not exists public.broker_execution_events (
  id uuid primary key default gen_random_uuid(),
  event_signature text not null unique,
  payload_type integer not null,
  execution_type text,
  broker_position_id text,
  broker_order_id text,
  close_reason text check (close_reason in ('TP', 'SL')),
  event_time timestamptz,
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists broker_execution_events_position_idx
  on public.broker_execution_events (broker_position_id, created_at desc);

create index if not exists broker_execution_events_order_idx
  on public.broker_execution_events (broker_order_id, created_at desc);

alter table public.broker_execution_events disable row level security;
