update public.properties
set default_checkin_time = '13:00',
    default_checkout_time = '11:00',
    updated_at = now();

alter table public.properties
  alter column default_checkin_time set default '13:00',
  alter column default_checkout_time set default '11:00',
  add constraint properties_universal_checkin_time
    check (default_checkin_time = '13:00'::time),
  add constraint properties_universal_checkout_time
    check (default_checkout_time = '11:00'::time);
