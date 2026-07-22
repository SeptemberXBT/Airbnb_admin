drop index if exists public.bookings_property_archive_created_idx;
drop index if exists public.bookings_razorpay_key_id_idx;
drop index if exists public.payment_jobs_one_refund_per_booking;
drop table if exists public.payment_refund_job_aliases;

alter table public.bookings
  drop constraint if exists bookings_archive_actor,
  drop constraint if exists bookings_special_requests_length,
  drop constraint if exists bookings_razorpay_key_id_format,
  drop constraint if exists bookings_booker_last_name_length,
  drop constraint if exists bookings_booker_first_name_length,
  drop column if exists archived_by,
  drop column if exists archived_at,
  drop column if exists special_requests,
  drop column if exists razorpay_key_id,
  drop column if exists country_code,
  drop column if exists booker_last_name,
  drop column if exists booker_first_name;
