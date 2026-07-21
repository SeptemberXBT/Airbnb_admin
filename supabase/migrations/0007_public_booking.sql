create table public.property_rates (
  property_id uuid primary key references public.properties(id),
  public_room_slug text not null unique
    check (public_room_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  max_guests integer not null check (max_guests between 1 and 20),
  weekday_price_paise integer not null check (weekday_price_paise > 0),
  weekend_price_paise integer not null check (weekend_price_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  booking_enabled boolean not null default false,
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.property_rate_overrides (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  stay_date date not null,
  price_paise integer not null check (price_paise > 0),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, stay_date)
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  public_reference text not null unique
    check (public_reference ~ '^NH-[A-Z0-9]{12,32}$'),
  property_id uuid not null references public.properties(id),
  guest_name text not null check (char_length(btrim(guest_name)) between 2 and 120),
  guest_email text not null check (char_length(btrim(guest_email)) between 3 and 254),
  guest_phone text not null check (char_length(btrim(guest_phone)) between 7 and 32),
  guest_count integer not null check (guest_count between 1 and 20),
  checkin date not null,
  checkout date not null,
  status text not null default 'processing' check (status in (
    'processing', 'held', 'payment_pending', 'confirmed',
    'payment_failed', 'expired', 'cancelled'
  )),
  hold_expires_at timestamptz,
  amount_paise integer not null check (amount_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  razorpay_order_id text unique,
  razorpay_payment_id text unique,
  cancellation_reason text,
  refund_status text not null default 'not_required'
    check (refund_status in ('not_required', 'pending', 'processed', 'failed')),
  razorpay_refund_id text unique,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_date_order check (checkout > checkin)
);

create table public.booking_night_prices (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  stay_date date not null,
  price_paise integer not null check (price_paise > 0),
  price_source text not null check (price_source in ('override', 'weekend', 'weekday')),
  created_at timestamptz not null default now(),
  unique (booking_id, stay_date)
);

alter table public.local_calendar_entries
  add column booking_id uuid unique references public.bookings(id),
  alter column created_by drop not null,
  add constraint local_calendar_entries_actor_or_booking
    check (created_by is not null or booking_id is not null);

create table public.inventory_nights (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  stay_date date not null,
  source_kind text not null check (source_kind in (
    'website_hold', 'website_booking', 'manual_local',
    'airbnb_reservation', 'airbnb_unavailable', 'airbnb_unknown'
  )),
  source_id uuid not null,
  booking_id uuid references public.bookings(id),
  local_entry_id uuid references public.local_calendar_entries(id),
  external_event_id uuid references public.external_calendar_events(id),
  status text not null default 'active' check (status in ('active', 'released')),
  expires_at timestamptz,
  release_reason text,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exactly_one_inventory_source_target check (
    (
      source_kind in ('website_hold', 'website_booking')
      and booking_id = source_id
      and local_entry_id is null
      and external_event_id is null
    ) or (
      source_kind = 'manual_local'
      and local_entry_id = source_id
      and booking_id is null
      and external_event_id is null
    ) or (
      source_kind in ('airbnb_reservation', 'airbnb_unavailable', 'airbnb_unknown')
      and external_event_id = source_id
      and booking_id is null
      and local_entry_id is null
    )
  ),
  constraint website_hold_has_expiry check (
    source_kind <> 'website_hold' or expires_at is not null
  )
);

create unique index inventory_nights_one_active_owner
  on public.inventory_nights (property_id, stay_date)
  where status = 'active';

create index inventory_nights_source_idx
  on public.inventory_nights (source_kind, source_id, stay_date);

create index inventory_nights_expiry_idx
  on public.inventory_nights (expires_at)
  where status = 'active' and source_kind = 'website_hold';

create table public.booking_attempts (
  idempotency_key uuid primary key,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  booking_id uuid references public.bookings(id),
  status text not null check (status in (
    'processing', 'succeeded', 'definitive_failure', 'retryable_failure'
  )),
  durable_step text not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  replay_until timestamptz,
  terminal_http_status integer check (terminal_http_status between 100 and 599),
  terminal_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.api_request_nonces (
  key_id text not null,
  endpoint_bucket text not null,
  nonce uuid not null,
  request_timestamp timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (key_id, nonce),
  constraint nonce_expiry_order check (expires_at > request_timestamp)
);

create index api_request_nonces_expiry_idx
  on public.api_request_nonces (expires_at);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  razorpay_event_id text not null unique,
  event_type text not null,
  booking_id uuid references public.bookings(id),
  razorpay_payment_id text,
  razorpay_refund_id text,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'failed')),
  error_code text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_jobs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id),
  job_kind text not null check (job_kind in (
    'order_recovery', 'payment_reconciliation', 'refund'
  )),
  idempotency_identity text not null unique,
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'succeeded', 'retryable_failure', 'definitive_failure'
  )),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  provider_id text,
  terminal_result jsonb,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payment_jobs_ready_idx
  on public.payment_jobs (next_attempt_at, created_at)
  where status in ('pending', 'retryable_failure');

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id),
  recipient_kind text not null check (recipient_kind in ('guest', 'admin')),
  recipient_email text not null,
  template_key text not null,
  deduplication_key text not null unique,
  subject text not null,
  html_body text not null,
  text_body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'retryable_failure', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  provider_message_id text unique,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notification_outbox_ready_idx
  on public.notification_outbox (next_attempt_at, created_at)
  where status in ('pending', 'retryable_failure');

create table public.booking_events (
  id bigint generated always as identity primary key,
  property_id uuid not null references public.properties(id),
  booking_id uuid not null references public.bookings(id),
  event_type text not null,
  actor_id uuid references auth.users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index property_rate_overrides_property_date_idx
  on public.property_rate_overrides (property_id, stay_date);
create index bookings_property_dates_idx
  on public.bookings (property_id, checkin, checkout, status);
create index booking_events_booking_created_idx
  on public.booking_events (booking_id, created_at desc);

alter table public.property_rates enable row level security;
alter table public.property_rate_overrides enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_night_prices enable row level security;
alter table public.inventory_nights enable row level security;
alter table public.booking_attempts enable row level security;
alter table public.api_request_nonces enable row level security;
alter table public.payment_events enable row level security;
alter table public.payment_jobs enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.booking_events enable row level security;

create policy property_rate_member_all on public.property_rates for all
  using (public.app_user_can_access_property(property_id))
  with check (public.app_user_can_access_property(property_id));
create policy property_rate_override_member_all on public.property_rate_overrides for all
  using (public.app_user_can_access_property(property_id))
  with check (public.app_user_can_access_property(property_id));
create policy booking_member_read on public.bookings for select
  using (public.app_user_can_access_property(property_id));
create policy booking_night_price_member_read on public.booking_night_prices for select
  using (
    exists (
      select 1 from public.bookings b
      where b.id = booking_id and public.app_user_can_access_property(b.property_id)
    )
  );
create policy inventory_night_member_read on public.inventory_nights for select
  using (public.app_user_can_access_property(property_id));
create policy booking_event_member_read on public.booking_events for select
  using (public.app_user_can_access_property(property_id));

revoke all on public.property_rates from anon;
revoke all on public.property_rate_overrides from anon;
revoke all on public.bookings from anon;
revoke all on public.booking_night_prices from anon;
revoke all on public.inventory_nights from anon;
revoke all on public.booking_attempts from anon;
revoke all on public.api_request_nonces from anon;
revoke all on public.payment_events from anon;
revoke all on public.payment_jobs from anon;
revoke all on public.notification_outbox from anon;
revoke all on public.booking_events from anon;

revoke all on public.property_rates from authenticated;
revoke all on public.property_rate_overrides from authenticated;
revoke all on public.bookings from authenticated;
revoke all on public.booking_night_prices from authenticated;
revoke all on public.inventory_nights from authenticated;
revoke all on public.booking_attempts from authenticated;
revoke all on public.api_request_nonces from authenticated;
revoke all on public.payment_events from authenticated;
revoke all on public.payment_jobs from authenticated;
revoke all on public.notification_outbox from authenticated;
revoke all on public.booking_events from authenticated;
