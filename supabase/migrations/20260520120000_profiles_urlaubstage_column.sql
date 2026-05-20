alter table users.profiles
  add column if not exists urlaubstage integer not null default 30
  check (urlaubstage >= 0);

comment on column users.profiles.urlaubstage is 'Verbleibende Urlaubstage (Standard 30, wird bei Genehmigung abgezogen)';

update users.profiles
set app_settings = app_settings - 'urlaubstage'
where app_settings ? 'urlaubstage';

create or replace view public.profiles as
  select
    id,
    email,
    full_name,
    hourly_rate,
    weekly_hours,
    position,
    app_settings,
    created_at,
    updated_at,
    avatar_url,
    linkedin_url,
    app_role,
    urlaubstage
  from users.profiles;
