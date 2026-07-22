alter table public.bookings
  add column booker_first_name text,
  add column booker_last_name text,
  add column country_code text not null default 'IN'
    check (country_code ~ '^[A-Z]{2}$'),
  add column special_requests text,
  add column razorpay_key_id text,
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users(id);

alter table public.bookings
  add constraint bookings_booker_first_name_length
    check (booker_first_name is null or char_length(btrim(booker_first_name)) between 1 and 80),
  add constraint bookings_booker_last_name_length
    check (booker_last_name is null or char_length(btrim(booker_last_name)) between 1 and 80),
  add constraint bookings_special_requests_length
    check (special_requests is null or char_length(btrim(special_requests)) <= 2000),
  add constraint bookings_razorpay_key_id_format
    check (razorpay_key_id is null or razorpay_key_id ~ '^rzp_(test|live)_[A-Za-z0-9]+$'),
  add constraint bookings_archive_actor
    check (archived_at is null or archived_by is not null);

create index bookings_property_archive_created_idx
  on public.bookings (property_id, archived_at, created_at desc);

create index bookings_razorpay_key_id_idx
  on public.bookings (razorpay_key_id)
  where razorpay_key_id is not null;

create table public.payment_refund_job_aliases (
  idempotency_identity text primary key,
  booking_id uuid not null references public.bookings(id),
  consolidated_into_job_id uuid not null references public.payment_jobs(id),
  original_job_id uuid not null,
  status text not null,
  provider_id text,
  terminal_result jsonb,
  last_error_code text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

alter table public.payment_refund_job_aliases enable row level security;
revoke all on public.payment_refund_job_aliases from anon;
revoke all on public.payment_refund_job_aliases from authenticated;

lock table public.payment_jobs in share row exclusive mode;

with ranked_refunds as (
  select id, booking_id, idempotency_identity, status, provider_id, terminal_result,
    last_error_code, created_at, updated_at,
    first_value(id) over (
      partition by booking_id
      order by case when status = 'succeeded' then 0 else 1 end,
        case when provider_id is not null then 0 else 1 end,
        case status when 'processing' then 0 when 'pending' then 1
          when 'retryable_failure' then 2 else 3 end,
        created_at, id
    ) as survivor_id,
    row_number() over (
    partition by booking_id
    order by case when status = 'succeeded' then 0 else 1 end,
      case when provider_id is not null then 0 else 1 end,
      case status when 'processing' then 0 when 'pending' then 1
        when 'retryable_failure' then 2 else 3 end,
      created_at, id
  ) as refund_rank
  from public.payment_jobs
  where job_kind = 'refund'
)
insert into public.payment_refund_job_aliases (
  idempotency_identity, booking_id, consolidated_into_job_id, original_job_id,
  status, provider_id, terminal_result, last_error_code, created_at, updated_at
)
select idempotency_identity, booking_id, survivor_id, id, status, provider_id,
  terminal_result, last_error_code, created_at, updated_at
from ranked_refunds
where refund_rank > 1
on conflict (idempotency_identity) do nothing;

with ranked_refunds as (
  select id, row_number() over (
    partition by booking_id
    order by case when status = 'succeeded' then 0 else 1 end,
      case when provider_id is not null then 0 else 1 end,
      case status when 'processing' then 0 when 'pending' then 1
        when 'retryable_failure' then 2 else 3 end,
      created_at, id
  ) as refund_rank
  from public.payment_jobs
  where job_kind = 'refund'
)
delete from public.payment_jobs j
using ranked_refunds r
where j.id = r.id and r.refund_rank > 1;

create unique index payment_jobs_one_refund_per_booking
  on public.payment_jobs (booking_id)
  where job_kind = 'refund';
