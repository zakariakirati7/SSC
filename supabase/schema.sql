-- Brew Ledger — Supabase schema
--
-- Apply this in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- It is idempotent, so re-running it after a change is safe.
--
-- The security model is Row Level Security, not the API key. The anon key
-- shipped in the page is public by design and grants nothing on its own:
-- every policy below is scoped to auth.uid(), so a signed-in person reaches
-- their own rows and no one else's. Without RLS these tables would be world
-- readable and world writable to anyone who views the page source.

-- ---------------------------------------------------------------- days ----
-- One row per person per day. Splitting by day (rather than one blob per
-- person) keeps a sync from two devices to a per-day merge instead of a
-- whole-ledger overwrite.
create table if not exists public.days (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  day        date        not null,
  cups       jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, day),
  constraint days_cups_is_array check (jsonb_typeof(cups) = 'array'),
  constraint days_cups_bounded  check (jsonb_array_length(cups) <= 50)
);

-- --------------------------------------------------------------- prefs ----
-- One row per person: the daily cap and bedtime the charts are drawn against.
create table if not exists public.prefs (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  limit_mg   integer     not null default 400,
  bedtime    text        not null default '23:00',
  updated_at timestamptz not null default now(),
  constraint prefs_limit_sane   check (limit_mg between 50 and 2000),
  constraint prefs_bedtime_form check (bedtime ~ '^[0-2][0-9]:[0-5][0-9]$')
);

-- ---------------------------------------------------------- updated_at ----
-- Set server-side so a client cannot backdate a row to win a merge.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists days_touch_updated_at on public.days;
create trigger days_touch_updated_at
  before insert or update on public.days
  for each row execute function public.touch_updated_at();

drop trigger if exists prefs_touch_updated_at on public.prefs;
create trigger prefs_touch_updated_at
  before insert or update on public.prefs
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------- RLS ----
alter table public.days  enable row level security;
alter table public.prefs enable row level security;

-- Force the owner check on reads and writes alike. `using` governs which
-- rows are visible to select/update/delete; `with check` governs what may be
-- written, and blocks inserting or updating a row into someone else's name.
drop policy if exists "days are private to their owner" on public.days;
create policy "days are private to their owner"
  on public.days
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "prefs are private to their owner" on public.prefs;
create policy "prefs are private to their owner"
  on public.prefs
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Anonymous visitors get nothing. No policy is granted to the `anon` role,
-- and with RLS enabled the absence of a policy is a denial.

-- --------------------------------------------------------------- index ----
-- Sync pulls "everything of mine changed since X".
create index if not exists days_user_updated_idx on public.days (user_id, updated_at desc);
