do $$
begin
  if exists (
    select 1 from public.listings
    where inbound_ical_url_encrypted is null
  ) then
    raise exception 'cannot require inbound ical while disconnected listings exist';
  end if;
end
$$;

alter table public.listings
  alter column inbound_ical_url_encrypted set not null;
