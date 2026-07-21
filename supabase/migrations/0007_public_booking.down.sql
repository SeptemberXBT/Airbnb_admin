drop index if exists public.inventory_nights_one_active_owner;

drop table if exists public.booking_events;
drop table if exists public.notification_outbox;
drop table if exists public.payment_jobs;
drop table if exists public.payment_events;
drop table if exists public.api_request_nonces;
drop table if exists public.booking_attempts;
drop table if exists public.inventory_nights;

delete from public.local_calendar_entries
where created_by is null and booking_id is not null;

alter table public.local_calendar_entries
  drop constraint if exists local_calendar_entries_actor_or_booking,
  drop constraint if exists local_calendar_entries_booking_id_key,
  drop column if exists booking_id,
  alter column created_by set not null;

drop table if exists public.booking_night_prices;
drop table if exists public.bookings;
drop table if exists public.property_rate_overrides;
drop table if exists public.property_rates;
