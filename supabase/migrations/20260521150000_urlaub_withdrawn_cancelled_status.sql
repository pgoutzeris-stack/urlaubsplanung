alter table public.urlaub_requests drop constraint if exists urlaub_requests_status_check;
alter table public.urlaub_requests add constraint urlaub_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled'));
