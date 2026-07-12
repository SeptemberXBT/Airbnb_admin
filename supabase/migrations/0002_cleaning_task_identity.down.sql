drop index if exists public.cleaning_tasks_active_property_service_unique;

alter table public.cleaning_tasks
  add constraint cleaning_tasks_property_id_service_date_outgoing_entry_key_key
  unique nulls not distinct (property_id, service_date, outgoing_entry_key);
