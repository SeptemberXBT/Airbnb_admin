create extension if not exists pgcrypto;

create type public.calendar_event_type as enum ('reservation', 'unavailable', 'unknown');
create type public.local_entry_type as enum ('direct_reservation', 'blocked');
create type public.cleaning_status as enum ('queued', 'cleaning_now', 'ready', 'delayed', 'skipped');
create type public.warning_level as enum ('safe', 'tight', 'impossible', 'overdue', 'waiting');
create type public.sync_status as enum ('running', 'success', 'failure', 'skipped_locked', 'cooldown');

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  timezone text not null default 'Asia/Kolkata' check (timezone = 'Asia/Kolkata'),
  default_checkin_time time not null default '13:00',
  default_checkout_time time not null default '11:00',
  default_cleaning_minutes integer not null default 15 check (default_cleaning_minutes between 5 and 480),
  checkout_buffer_minutes integer not null default 5 check (checkout_buffer_minutes between 0 and 120),
  checkin_buffer_minutes integer not null default 5 check (checkin_buffer_minutes between 0 and 120),
  housekeeping_cutoff_time time not null default '17:00',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.property_members (
  property_id uuid not null references public.properties(id),
  user_id uuid not null references auth.users(id),
  role text not null default 'manager' check (role in ('owner', 'manager')),
  created_at timestamptz not null default now(),
  primary key (property_id, user_id)
);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  platform text not null default 'airbnb' check (platform = 'airbnb'),
  display_name text not null check (char_length(display_name) between 2 and 120),
  inbound_ical_url_encrypted text not null,
  outbound_token_hash text not null unique,
  outbound_enabled boolean not null default true,
  active boolean not null default true,
  last_sync_at timestamptz,
  last_sync_status public.sync_status,
  last_sync_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.external_calendar_events (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id),
  source_uid text not null,
  event_type public.calendar_event_type not null default 'unknown',
  start_date date not null,
  end_date date not null,
  sanitized_reservation_url text,
  source_content_hash text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  active boolean not null default true,
  archived_at timestamptz,
  constraint external_event_date_order check (end_date > start_date),
  unique (listing_id, source_uid)
);

create table public.local_calendar_entries (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  listing_id uuid references public.listings(id),
  entry_type public.local_entry_type not null,
  start_date date not null,
  end_date date not null,
  private_booking_name text,
  private_contact text,
  private_note text,
  booking_source text,
  sync_to_airbnb boolean not null default false,
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint local_entry_date_order check (end_date > start_date)
);

create table public.operation_overrides (
  id uuid primary key default gen_random_uuid(),
  external_event_id uuid references public.external_calendar_events(id),
  local_entry_id uuid references public.local_calendar_entries(id),
  expected_checkin_time time,
  expected_checkout_time time,
  cleaning_duration_minutes integer check (cleaning_duration_minutes between 5 and 480),
  operational_note text,
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint one_override_target check (
    (external_event_id is not null)::integer + (local_entry_id is not null)::integer = 1
  ),
  unique nulls not distinct (external_event_id, local_entry_id)
);

create table public.cleaning_tasks (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  service_date date not null,
  outgoing_entry_key text,
  incoming_entry_key text,
  release_time timestamptz not null,
  ready_deadline timestamptz not null,
  guest_arrival_time timestamptz,
  planned_start timestamptz,
  planned_end timestamptz,
  expected_duration_minutes integer not null check (expected_duration_minutes between 5 and 480),
  actual_start timestamptz,
  actual_end timestamptz,
  status public.cleaning_status not null default 'queued',
  warning_level public.warning_level not null default 'safe',
  assigned_team text,
  delay_minutes integer not null default 0 check (delay_minutes between 0 and 720),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (property_id, service_date, outgoing_entry_key)
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status public.sync_status not null default 'running',
  fetched_event_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  archived_count integer not null default 0,
  error_code text,
  sanitized_error_message text,
  trigger_source text not null default 'scheduled' check (trigger_source in ('scheduled', 'manual'))
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  property_id uuid references public.properties(id),
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index external_events_listing_dates_idx on public.external_calendar_events (listing_id, start_date, end_date) where active;
create index local_entries_property_dates_idx on public.local_calendar_entries (property_id, start_date, end_date) where active;
create index cleaning_tasks_service_queue_idx on public.cleaning_tasks (service_date, status, ready_deadline) where archived_at is null;
create index sync_runs_listing_started_idx on public.sync_runs (listing_id, started_at desc);
create index audit_log_property_created_idx on public.audit_log (property_id, created_at desc);

create or replace function public.app_user_can_access_property(target_property_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.property_members
    where property_id = target_property_id and user_id = auth.uid()
  );
$$;

alter table public.properties enable row level security;
alter table public.listings enable row level security;
alter table public.external_calendar_events enable row level security;
alter table public.local_calendar_entries enable row level security;
alter table public.operation_overrides enable row level security;
alter table public.cleaning_tasks enable row level security;
alter table public.sync_runs enable row level security;
alter table public.audit_log enable row level security;
alter table public.property_members enable row level security;

create policy property_member_read on public.properties for select using (public.app_user_can_access_property(id));
create policy property_member_write on public.properties for update using (public.app_user_can_access_property(id)) with check (public.app_user_can_access_property(id));
create policy membership_self_read on public.property_members for select using (user_id = auth.uid());
create policy listing_member_all on public.listings for all using (public.app_user_can_access_property(property_id)) with check (public.app_user_can_access_property(property_id));
create policy external_event_member_read on public.external_calendar_events for select using (
  exists (select 1 from public.listings l where l.id = listing_id and public.app_user_can_access_property(l.property_id))
);
create policy local_entry_member_all on public.local_calendar_entries for all using (public.app_user_can_access_property(property_id)) with check (public.app_user_can_access_property(property_id));
create policy override_member_all on public.operation_overrides for all using (
  exists (select 1 from public.external_calendar_events e join public.listings l on l.id = e.listing_id where e.id = external_event_id and public.app_user_can_access_property(l.property_id))
  or exists (select 1 from public.local_calendar_entries e where e.id = local_entry_id and public.app_user_can_access_property(e.property_id))
) with check (
  exists (select 1 from public.external_calendar_events e join public.listings l on l.id = e.listing_id where e.id = external_event_id and public.app_user_can_access_property(l.property_id))
  or exists (select 1 from public.local_calendar_entries e where e.id = local_entry_id and public.app_user_can_access_property(e.property_id))
);
create policy cleaning_task_member_all on public.cleaning_tasks for all using (public.app_user_can_access_property(property_id)) with check (public.app_user_can_access_property(property_id));
create policy sync_run_member_read on public.sync_runs for select using (
  exists (select 1 from public.listings l where l.id = listing_id and public.app_user_can_access_property(l.property_id))
);
create policy audit_member_read on public.audit_log for select using (public.app_user_can_access_property(property_id));

revoke all on public.properties from anon;
revoke all on public.property_members from anon;
revoke all on public.listings from anon;
revoke all on public.external_calendar_events from anon;
revoke all on public.local_calendar_entries from anon;
revoke all on public.operation_overrides from anon;
revoke all on public.cleaning_tasks from anon;
revoke all on public.sync_runs from anon;
revoke all on public.audit_log from anon;
revoke all on public.properties from authenticated;
revoke all on public.property_members from authenticated;
revoke all on public.listings from authenticated;
revoke all on public.external_calendar_events from authenticated;
revoke all on public.local_calendar_entries from authenticated;
revoke all on public.operation_overrides from authenticated;
revoke all on public.cleaning_tasks from authenticated;
revoke all on public.sync_runs from authenticated;
revoke all on public.audit_log from authenticated;
