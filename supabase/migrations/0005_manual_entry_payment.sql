alter table public.local_calendar_entries
  add column payment_amount numeric(12,2)
  check (payment_amount >= 0);
