create or replace function public.invoke_render_executor_healthcheck(
  render_base_url text,
  executor_webhook_secret text default null
)
returns bigint
language plpgsql
security definer
as $$
declare
  request_id bigint;
  headers jsonb;
begin
  headers := jsonb_build_object('Content-Type', 'application/json');

  if executor_webhook_secret is not null and length(executor_webhook_secret) > 0 then
    headers := headers || jsonb_build_object('x-executor-secret', executor_webhook_secret);
  end if;

  select net.http_get(
    url := format('%s/health', regexp_replace(render_base_url, '/+$', '')),
    headers := headers
  ) into request_id;

  return request_id;
end;
$$;

comment on function public.invoke_render_executor_healthcheck(text, text) is
'Pings Render executor /health via pg_net (useful for optional keep-warm scheduling on Render free tier).';

create or replace function public.invoke_render_executor_tick(
  render_base_url text,
  executor_webhook_secret text default null
)
returns bigint
language plpgsql
security definer
as $$
declare
  request_id bigint;
  headers jsonb;
begin
  headers := jsonb_build_object('Content-Type', 'application/json');

  if executor_webhook_secret is not null and length(executor_webhook_secret) > 0 then
    headers := headers || jsonb_build_object('x-executor-secret', executor_webhook_secret);
  end if;

  select net.http_post(
    url := format('%s/tick', regexp_replace(render_base_url, '/+$', '')),
    headers := headers,
    body := '{}'::jsonb
  ) into request_id;

  return request_id;
end;
$$;

comment on function public.invoke_render_executor_tick(text, text) is
'Calls Render executor /tick via pg_net (manual wake + immediate queue processing trigger).';

-- Example: keep warm every 10 minutes during selected UTC hours (adjust to your session window)
-- select cron.schedule(
--   'render-executor-keepwarm-london-ny',
--   '*/10 6-21 * * 1-5',
--   $$ select public.invoke_render_executor_healthcheck('https://your-render-service.onrender.com', 'your-executor-secret'); $$
-- );
--
-- Example: force queue processing every 5 minutes during session hours (optional backup)
-- select cron.schedule(
--   'render-executor-tick-backup',
--   '*/5 6-21 * * 1-5',
--   $$ select public.invoke_render_executor_tick('https://your-render-service.onrender.com', 'your-executor-secret'); $$
-- );
--
-- To remove:
-- select cron.unschedule('render-executor-keepwarm-london-ny');
-- select cron.unschedule('render-executor-tick-backup');
