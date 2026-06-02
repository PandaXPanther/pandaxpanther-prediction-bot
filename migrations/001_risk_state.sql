-- H-15: persistent risk_state table so the 24h drawdown kill switch survives Fly restarts.
-- Run this once in the Supabase SQL editor (https://supabase.com/dashboard/project/aikeswwopdatvqqbbhmu/sql/new)
-- Effect: after a forceKill, the bot stays killed across restarts until the row's `killed` is set back to false.
--
-- Current behavior without this table: the bot logs a warning on every persist attempt
-- but keeps trading. In-memory kill still applies within a single process lifetime.

create table if not exists public.risk_state (
  id text primary key,                  -- always 'singleton'
  killed boolean not null default false,
  reason text,
  updated_at timestamptz not null default now()
);

-- Seed singleton row so upserts work cleanly.
insert into public.risk_state (id, killed)
values ('singleton', false)
on conflict (id) do nothing;

-- Service role has full access already, but be explicit:
grant all on table public.risk_state to service_role;
