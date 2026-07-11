alter table public.cleaning_tasks
  drop constraint if exists cleaning_tasks_property_id_service_date_outgoing_entry_key_key;

create unique index cleaning_tasks_active_property_service_unique
  on public.cleaning_tasks (property_id, service_date)
  where archived_at is null;
