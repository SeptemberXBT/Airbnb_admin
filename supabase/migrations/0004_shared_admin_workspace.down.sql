drop trigger if exists share_properties_with_new_auth_user on auth.users;
drop function if exists public.share_properties_with_new_auth_user();

drop trigger if exists share_new_property_with_auth_users on public.properties;
drop function if exists public.share_new_property_with_auth_users();

alter table public.properties
  drop column if exists creation_request_id;
