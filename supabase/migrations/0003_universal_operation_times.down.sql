alter table public.properties
  drop constraint if exists properties_universal_checkin_time,
  drop constraint if exists properties_universal_checkout_time;
