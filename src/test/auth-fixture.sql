create schema if not exists auth;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end;
$$;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
