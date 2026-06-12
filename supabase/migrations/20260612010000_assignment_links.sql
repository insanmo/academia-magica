alter table academy_progress add column if not exists assignment_url text;

create or replace function academy_save_assignment(p_course_id uuid, p_assignment_url text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := academy_current_user_id();
  v_url text := trim(p_assignment_url);
begin
  if v_user_id is null then raise exception 'not registered'; end if;
  if not exists (select 1 from academy_courses where id = p_course_id and active) then raise exception 'invalid course'; end if;
  if length(v_url) > 2000 or v_url !~* '^https://' then raise exception 'invalid assignment URL'; end if;
  insert into academy_progress (user_id, course_id, assignment_url)
  values (v_user_id, p_course_id, v_url)
  on conflict (user_id, course_id) do update
  set assignment_url = excluded.assignment_url, updated_at = now();
end;
$$;

drop function if exists academy_get_admin_course_detail();
create or replace function academy_get_admin_course_detail()
returns table(full_name text, indra_email text, role text, house text, leader_name text, course_title text, certificate_url text, assignment_url text, best_score int, attempts int, completed boolean, completed_at timestamptz, best_quiz_time_seconds int)
language plpgsql stable security definer set search_path = public
as $$
declare v_actor academy_users;
begin
  select * into v_actor from academy_users where id = academy_current_user_id();
  if v_actor.id is null or v_actor.role not in ('focal', 'admin') then raise exception 'forbidden'; end if;
  return query
  select u.full_name, u.indra_email, u.role, h.name, h.leader_name, c.title,
    p.certificate_url, p.assignment_url, p.best_score, p.attempts, coalesce(p.completed, false),
    p.completed_at, p.best_quiz_time_seconds
  from academy_users u
  join academy_houses h on h.id = u.house_id
  cross join academy_courses c
  left join academy_progress p on p.user_id = u.id and p.course_id = c.id
  where u.active and c.active
    and (v_actor.role = 'admin' or u.house_id = v_actor.house_id)
  order by h.name, u.full_name, c.sort_order;
end;
$$;

revoke all on function academy_save_assignment(uuid,text) from public, anon;
grant execute on function academy_save_assignment(uuid,text) to authenticated;
revoke all on function academy_get_admin_course_detail() from public, anon;
grant execute on function academy_get_admin_course_detail() to authenticated;
