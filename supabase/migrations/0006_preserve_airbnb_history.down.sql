drop index if exists public.external_calendar_events_visible_range_idx;

alter table public.external_calendar_events
  drop constraint if exists external_calendar_events_state_check;

alter table public.external_calendar_events
  drop column if exists historical;
