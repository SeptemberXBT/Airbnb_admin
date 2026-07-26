create table public.booking_resume_tokens (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  token_ciphertext text not null check (char_length(token_ciphertext) between 40 and 512),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index booking_resume_tokens_expiry_idx
  on public.booking_resume_tokens (expires_at)
  where revoked_at is null;

alter table public.booking_resume_tokens enable row level security;
revoke all on public.booking_resume_tokens from anon;
revoke all on public.booking_resume_tokens from authenticated;
