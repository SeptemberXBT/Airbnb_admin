alter table public.properties
  add column creation_request_id uuid;

create unique index properties_creation_request_unique
  on public.properties (creation_request_id)
  where creation_request_id is not null;

insert into public.property_members (property_id, user_id, role)
select p.id, u.id, 'manager'
from public.properties p
cross join auth.users u
on conflict (property_id, user_id) do nothing;

create or replace function public.share_new_property_with_auth_users()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.property_members (property_id, user_id, role)
  select new.id, u.id, 'manager'
  from auth.users u
  on conflict (property_id, user_id) do nothing;
  return new;
end;
$$;

create trigger share_new_property_with_auth_users
after insert on public.properties
for each row execute function public.share_new_property_with_auth_users();

create or replace function public.share_properties_with_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.property_members (property_id, user_id, role)
  select p.id, new.id, 'manager'
  from public.properties p
  on conflict (property_id, user_id) do nothing;
  return new;
end;
$$;

create trigger share_properties_with_new_auth_user
after insert on auth.users
for each row execute function public.share_properties_with_new_auth_user();
