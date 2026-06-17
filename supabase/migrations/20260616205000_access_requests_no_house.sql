create or replace function public.academy_admin_get_access_requests()
returns table(
  request_type text,
  request_id uuid,
  user_id uuid,
  full_name text,
  indra_email text,
  role text,
  house text,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor academy_users;
begin
  select * into v_actor from academy_users where id = academy_current_user_id();
  if v_actor.id is null or v_actor.role not in ('focal', 'admin') then
    raise exception 'forbidden';
  end if;

  return query
  select
    'password'::text,
    r.id,
    u.id,
    u.full_name,
    u.indra_email,
    u.role,
    coalesce(h.name, 'Sin casa')::text,
    r.requested_at
  from academy_password_reset_requests r
  join academy_users u on u.id = r.user_id
  left join academy_houses h on h.id = u.house_id
  where r.status = 'pending'
    and u.active
    and (
      v_actor.role = 'admin'
      or (u.house_id = v_actor.house_id and u.role = 'student')
    )
  union all
  select
    'account'::text,
    a.id,
    null::uuid,
    a.full_name,
    a.indra_email,
    'new'::text,
    h.name,
    a.requested_at
  from academy_account_requests a
  join academy_houses h on h.id = a.house_id
  where a.status = 'pending'
    and (v_actor.role = 'admin' or a.house_id = v_actor.house_id)
  order by 8;
end;
$$;
