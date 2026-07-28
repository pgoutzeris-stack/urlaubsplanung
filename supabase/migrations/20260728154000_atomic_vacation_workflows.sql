create or replace function public.submit_urlaub_request(
  p_user_id uuid,
  p_applicant_name text,
  p_start_date date,
  p_end_date date,
  p_note text,
  p_day_part text
)
returns public.urlaub_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.urlaub_requests%rowtype;
begin
  insert into public.urlaub_requests (
    user_id,
    applicant_name,
    start_date,
    end_date,
    note,
    day_part,
    status
  )
  values (
    p_user_id,
    p_applicant_name,
    p_start_date,
    p_end_date,
    p_note,
    p_day_part,
    'pending'
  )
  returning * into v_request;

  insert into recruiting.notifications (
    user_id,
    type,
    title,
    message,
    session_id,
    runde,
    meta
  )
  select
    profile.id,
    'urlaub_submitted',
    'Neuer Urlaubsantrag',
    p_applicant_name || ' beantragt Urlaub vom ' ||
      to_char(p_start_date, 'DD.MM.YYYY') || ' bis ' ||
      to_char(p_end_date, 'DD.MM.YYYY') ||
      case when p_note is null then '.' else ' (Notiz: ' || p_note || ').' end,
    null,
    null,
    jsonb_build_object(
      'request_id', v_request.id,
      'user_id', p_user_id,
      'applicant_name', p_applicant_name,
      'source', 'urlaubsplanung'
    )
  from users.profiles profile
  where profile.app_role = 'admin';

  return v_request;
end;
$$;

create or replace function public.withdraw_urlaub_request(
  p_request_id uuid,
  p_user_id uuid
)
returns public.urlaub_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.urlaub_requests%rowtype;
begin
  select *
  into v_request
  from public.urlaub_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Antrag nicht gefunden';
  end if;
  if v_request.user_id <> p_user_id then
    raise exception 'Keine Berechtigung';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Nur ausstehende Anträge können zurückgezogen werden';
  end if;

  update public.urlaub_requests
  set status = 'withdrawn', updated_at = now()
  where id = p_request_id
  returning * into v_request;

  insert into recruiting.notifications (
    user_id,
    type,
    title,
    message,
    session_id,
    runde,
    meta
  )
  select
    profile.id,
    'urlaub_withdrawn',
    'Urlaubsantrag zurückgezogen',
    v_request.applicant_name || ' hat den Antrag ' ||
      to_char(v_request.start_date, 'DD.MM.YYYY') || ' - ' ||
      to_char(v_request.end_date, 'DD.MM.YYYY') || ' zurückgezogen.',
    null,
    null,
    jsonb_build_object(
      'request_id', v_request.id,
      'user_id', v_request.user_id,
      'applicant_name', v_request.applicant_name,
      'source', 'urlaubsplanung'
    )
  from users.profiles profile
  where profile.app_role = 'admin';

  return v_request;
end;
$$;

create or replace function public.reject_urlaub_request(
  p_request_id uuid,
  p_reviewer_id uuid,
  p_reason text
)
returns public.urlaub_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.urlaub_requests%rowtype;
begin
  select *
  into v_request
  from public.urlaub_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Antrag nicht gefunden';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Antrag wurde bereits bearbeitet';
  end if;

  update public.urlaub_requests
  set
    status = 'rejected',
    reviewed_by = p_reviewer_id,
    reviewed_at = now(),
    rejection_reason = p_reason,
    updated_at = now()
  where id = p_request_id
  returning * into v_request;

  insert into recruiting.notifications (
    user_id,
    type,
    title,
    message,
    session_id,
    runde,
    meta
  )
  values (
    v_request.user_id,
    'urlaub_rejected',
    'Urlaubsantrag abgelehnt',
    'Dein Urlaubsantrag ' || to_char(v_request.start_date, 'DD.MM.YYYY') ||
      ' - ' || to_char(v_request.end_date, 'DD.MM.YYYY') ||
      case when p_reason is null then ' wurde abgelehnt.'
        else ' wurde abgelehnt: ' || p_reason end,
    null,
    null,
    jsonb_build_object(
      'request_id', v_request.id,
      'reason', p_reason,
      'source', 'urlaubsplanung'
    )
  );

  return v_request;
end;
$$;

create or replace function public.approve_urlaub_request(
  p_request_id uuid,
  p_reviewer_id uuid,
  p_days numeric,
  p_member_id uuid,
  p_title text,
  p_events jsonb
)
returns public.urlaub_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.urlaub_requests%rowtype;
  v_balance numeric;
  v_event jsonb;
  v_event_id uuid;
  v_first_event_id uuid;
begin
  if p_days < 0.5 then
    raise exception 'Antrag enthält keine gültigen Urlaubstage';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then
    raise exception 'Kalendereintrag konnte nicht erstellt werden';
  end if;

  select *
  into v_request
  from public.urlaub_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Antrag nicht gefunden';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Antrag wurde bereits bearbeitet';
  end if;

  select coalesce(urlaubstage, 30)
  into v_balance
  from users.profiles
  where id = v_request.user_id
  for update;

  if not found then
    raise exception 'Profil nicht gefunden';
  end if;
  if v_balance < p_days then
    raise exception 'Nicht genug Urlaubstage (% verfügbar)', v_balance;
  end if;

  update users.profiles
  set urlaubstage = v_balance - p_days, updated_at = now()
  where id = v_request.user_id;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    insert into team_kalender.events (
      member_id,
      type,
      title,
      start_date,
      end_date,
      note,
      day_part,
      is_system,
      urlaub_request_id
    )
    values (
      p_member_id,
      'urlaub',
      p_title,
      (v_event->>'start_date')::date,
      (v_event->>'end_date')::date,
      v_request.note,
      coalesce(v_event->>'day_part', 'full'),
      false,
      v_request.id
    )
    returning id into v_event_id;

    if v_first_event_id is null then
      v_first_event_id := v_event_id;
    end if;
  end loop;

  update public.urlaub_requests
  set
    status = 'approved',
    reviewed_by = p_reviewer_id,
    reviewed_at = now(),
    team_member_id = p_member_id,
    calendar_event_id = v_first_event_id,
    updated_at = now()
  where id = p_request_id
  returning * into v_request;

  insert into recruiting.notifications (
    user_id,
    type,
    title,
    message,
    session_id,
    runde,
    meta
  )
  values (
    v_request.user_id,
    'urlaub_approved',
    'Urlaub genehmigt',
    'Dein Urlaubsantrag ' || to_char(v_request.start_date, 'DD.MM.YYYY') ||
      ' - ' || to_char(v_request.end_date, 'DD.MM.YYYY') ||
      ' wurde genehmigt und im Team-Kalender eingetragen.',
    null,
    null,
    jsonb_build_object(
      'request_id', v_request.id,
      'source', 'urlaubsplanung'
    )
  );

  return v_request;
end;
$$;

create or replace function public.cancel_approved_urlaub_request(
  p_request_id uuid,
  p_user_id uuid,
  p_refund_days numeric
)
returns public.urlaub_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.urlaub_requests%rowtype;
  v_balance numeric;
begin
  select *
  into v_request
  from public.urlaub_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Antrag nicht gefunden';
  end if;
  if v_request.user_id <> p_user_id then
    raise exception 'Keine Berechtigung';
  end if;
  if v_request.status <> 'approved' then
    raise exception 'Nur genehmigter Urlaub kann storniert werden';
  end if;
  if exists (
    select 1
    from team_kalender.events event
    where (
      event.urlaub_request_id = v_request.id
      or event.id = v_request.calendar_event_id
    )
    and event.is_system
  ) then
    raise exception 'Betriebsferien und firmenfreie Tage können nicht storniert werden';
  end if;

  select coalesce(urlaubstage, 30)
  into v_balance
  from users.profiles
  where id = v_request.user_id
  for update;

  if not found then
    raise exception 'Profil nicht gefunden';
  end if;

  delete from team_kalender.events event
  where event.urlaub_request_id = v_request.id
    or event.id = v_request.calendar_event_id;

  update users.profiles
  set urlaubstage = v_balance + p_refund_days, updated_at = now()
  where id = v_request.user_id;

  update public.urlaub_requests
  set status = 'cancelled', calendar_event_id = null, updated_at = now()
  where id = p_request_id
  returning * into v_request;

  insert into recruiting.notifications (
    user_id,
    type,
    title,
    message,
    session_id,
    runde,
    meta
  )
  select
    profile.id,
    'urlaub_cancelled',
    'Genehmigter Urlaub storniert',
    v_request.applicant_name || ' hat genehmigten Urlaub ' ||
      to_char(v_request.start_date, 'DD.MM.YYYY') || ' - ' ||
      to_char(v_request.end_date, 'DD.MM.YYYY') ||
      ' storniert. Der Kalendereintrag wurde entfernt.',
    null,
    null,
    jsonb_build_object(
      'request_id', v_request.id,
      'user_id', v_request.user_id,
      'applicant_name', v_request.applicant_name,
      'source', 'urlaubsplanung'
    )
  from users.profiles profile
  where profile.app_role = 'admin';

  return v_request;
end;
$$;

revoke all on function public.submit_urlaub_request(uuid, text, date, date, text, text)
  from public, anon, authenticated;
revoke all on function public.withdraw_urlaub_request(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.reject_urlaub_request(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.approve_urlaub_request(uuid, uuid, numeric, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.cancel_approved_urlaub_request(uuid, uuid, numeric)
  from public, anon, authenticated;

grant execute on function public.submit_urlaub_request(uuid, text, date, date, text, text)
  to service_role;
grant execute on function public.withdraw_urlaub_request(uuid, uuid)
  to service_role;
grant execute on function public.reject_urlaub_request(uuid, uuid, text)
  to service_role;
grant execute on function public.approve_urlaub_request(uuid, uuid, numeric, uuid, text, jsonb)
  to service_role;
grant execute on function public.cancel_approved_urlaub_request(uuid, uuid, numeric)
  to service_role;
