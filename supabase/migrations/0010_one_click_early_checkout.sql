alter table public.local_calendar_entries
  add column completed_early_at timestamptz,
  add column completed_early_by uuid references auth.users(id),
  add column early_checkout_effective_date date;

alter table public.local_calendar_entries
  add constraint local_calendar_entries_early_checkout_complete
  check (
    (completed_early_at is null and completed_early_by is null and early_checkout_effective_date is null)
    or
    (completed_early_at is not null and completed_early_by is not null and early_checkout_effective_date is not null)
  );

create index local_calendar_entries_completed_early_property_dates_idx
  on public.local_calendar_entries (property_id, start_date, end_date)
  where completed_early_at is not null;
