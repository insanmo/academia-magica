create or replace function academy_abandon_quiz(p_session_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := academy_current_user_id();
  v_session academy_quiz_sessions;
  v_seconds int;
begin
  if v_user_id is null then raise exception 'not registered'; end if;

  select * into v_session from academy_quiz_sessions
  where id = p_session_id and user_id = v_user_id for update;
  if v_session.id is null then raise exception 'invalid quiz session'; end if;
  if v_session.submitted_at is not null then return; end if;

  v_seconds := greatest(1, least(180, extract(epoch from (now() - v_session.started_at))::int));
  update academy_quiz_sessions set submitted_at = now() where id = v_session.id;

  insert into academy_attempts (user_id, course_id, quiz_session_id, score, passed, quiz_time_seconds)
  values (v_user_id, v_session.course_id, v_session.id, 0, false, v_seconds);

  insert into academy_progress (user_id, course_id, best_score, attempts)
  values (v_user_id, v_session.course_id, 0, 1)
  on conflict (user_id, course_id) do update set
    attempts = academy_progress.attempts + 1,
    best_score = greatest(coalesce(academy_progress.best_score, 0), 0),
    updated_at = now();
end;
$$;

revoke all on function academy_abandon_quiz(uuid) from public, anon;
grant execute on function academy_abandon_quiz(uuid) to authenticated;
