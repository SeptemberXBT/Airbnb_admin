alter table public.external_calendar_events
  add column historical boolean not null default false;

alter table public.external_calendar_events
  add constraint external_calendar_events_state_check
  check (not (active and historical));

update public.external_calendar_events
set historical = true
where not active
  and not historical
  and end_date <= (now() at time zone 'Asia/Kolkata')::date
  and (last_seen_at at time zone 'Asia/Kolkata')::date >= start_date;

create index external_calendar_events_visible_range_idx
  on public.external_calendar_events (listing_id, start_date, end_date)
  where active or historical;
