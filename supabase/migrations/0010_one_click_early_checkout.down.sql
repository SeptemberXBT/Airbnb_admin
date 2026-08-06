drop index if exists public.local_calendar_entries_completed_early_property_dates_idx;

alter table public.local_calendar_entries
  drop constraint if exists local_calendar_entries_early_checkout_complete;

alter table public.local_calendar_entries
  drop column if exists early_checkout_effective_date,
  drop column if exists completed_early_by,
  drop column if exists completed_early_at;
