alter table academy_courses add column if not exists quiz_duration_minutes int not null default 3;
alter table academy_courses drop constraint if exists academy_courses_quiz_duration_minutes_check;
alter table academy_courses add constraint academy_courses_quiz_duration_minutes_check
  check (quiz_duration_minutes between 1 and 120);

create or replace function academy_start_quiz(p_course_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_user_id uuid := academy_current_user_id(); v_session_id uuid; v_questions jsonb; v_course academy_courses;
begin
  if v_user_id is null then raise exception 'not registered'; end if;
  select * into v_course from academy_courses where id = p_course_id and active;
  if v_course.id is null then raise exception 'invalid course'; end if;
  if not v_course.has_exam then raise exception 'quiz unavailable'; end if;
  if (select count(*) from academy_quiz_sessions where user_id = v_user_id and started_at > now() - interval '10 minutes') >= 10 then
    raise exception 'too many quiz sessions';
  end if;
  if v_course.requires_certificate and not exists (
    select 1 from academy_progress where user_id = v_user_id and course_id = p_course_id and certificate_url is not null
  ) then raise exception 'certificate required'; end if;
  select jsonb_agg(jsonb_build_object('id', id, 'question_text', question_text, 'options', options) order by sort_order)
  into v_questions from academy_questions where course_id = p_course_id and active;
  if coalesce(jsonb_array_length(v_questions), 0) = 0 then raise exception 'quiz unavailable'; end if;
  insert into academy_quiz_sessions (user_id, course_id, expires_at)
  values (v_user_id, p_course_id, now() + make_interval(mins => v_course.quiz_duration_minutes))
  returning id into v_session_id;
  return jsonb_build_object(
    'session_id', v_session_id,
    'expires_in_seconds', v_course.quiz_duration_minutes * 60,
    'questions', v_questions
  );
end;
$$;

create or replace function academy_submit_attempt(p_session_id uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := academy_current_user_id();
  v_session academy_quiz_sessions;
  v_total int; v_answered int; v_correct int; v_score int; v_seconds int; v_passed boolean; v_max_seconds int;
begin
  if v_user_id is null then raise exception 'not registered'; end if;
  if jsonb_typeof(p_answers) <> 'array' then raise exception 'invalid answers'; end if;
  select * into v_session from academy_quiz_sessions where id = p_session_id and user_id = v_user_id for update;
  if v_session.id is null then raise exception 'invalid quiz session'; end if;
  if v_session.submitted_at is not null then raise exception 'quiz already submitted'; end if;
  if now() > v_session.expires_at + interval '10 seconds' then raise exception 'quiz expired'; end if;
  select count(*) into v_total from academy_questions where course_id = v_session.course_id and active;
  select count(distinct q.id) into v_answered
  from jsonb_array_elements(p_answers) a
  join academy_questions q on q.id = (a->>'question_id')::uuid
  where q.course_id = v_session.course_id and q.active;
  if jsonb_array_length(p_answers) <> v_total or v_answered <> v_total then raise exception 'all questions are required exactly once'; end if;
  select count(*) into v_correct
  from jsonb_array_elements(p_answers) a
  join academy_questions q on q.id = (a->>'question_id')::uuid
  where q.course_id = v_session.course_id and q.active
    and (a->>'selected_option') ~ '^[0-9]+$'
    and (a->>'selected_option')::int = q.correct_option;
  v_score := round((v_correct::numeric / v_total) * 20);
  v_passed := v_score >= 15;
  v_max_seconds := greatest(1, extract(epoch from (v_session.expires_at - v_session.started_at))::int);
  v_seconds := greatest(1, least(v_max_seconds, extract(epoch from (now() - v_session.started_at))::int));
  update academy_quiz_sessions set submitted_at = now() where id = v_session.id;
  insert into academy_attempts (user_id, course_id, quiz_session_id, score, passed, quiz_time_seconds)
  values (v_user_id, v_session.course_id, v_session.id, v_score, v_passed, v_seconds);
  insert into academy_progress (user_id, course_id, best_score, attempts, completed, completed_at, best_quiz_time_seconds)
  values (v_user_id, v_session.course_id, v_score, 1, v_passed, case when v_passed then now() end, case when v_passed then v_seconds end)
  on conflict (user_id, course_id) do update set
    attempts = academy_progress.attempts + 1,
    best_score = greatest(coalesce(academy_progress.best_score, 0), v_score),
    completed = academy_progress.completed or v_passed,
    completed_at = case when not academy_progress.completed and v_passed then now() else academy_progress.completed_at end,
    best_quiz_time_seconds = case when not v_passed then academy_progress.best_quiz_time_seconds when academy_progress.best_quiz_time_seconds is null then v_seconds else least(academy_progress.best_quiz_time_seconds, v_seconds) end,
    updated_at = now();
  return jsonb_build_object('score', v_score, 'passed', v_passed, 'quiz_time_seconds', v_seconds);
end;
$$;

create or replace function academy_abandon_quiz(p_session_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := academy_current_user_id(); v_session academy_quiz_sessions; v_seconds int; v_max_seconds int;
begin
  if v_user_id is null then raise exception 'not registered'; end if;
  select * into v_session from academy_quiz_sessions where id = p_session_id and user_id = v_user_id for update;
  if v_session.id is null then raise exception 'invalid quiz session'; end if;
  if v_session.submitted_at is not null then return; end if;
  v_max_seconds := greatest(1, extract(epoch from (v_session.expires_at - v_session.started_at))::int);
  v_seconds := greatest(1, least(v_max_seconds, extract(epoch from (now() - v_session.started_at))::int));
  update academy_quiz_sessions set submitted_at = now() where id = v_session.id;
  insert into academy_attempts (user_id, course_id, quiz_session_id, score, passed, quiz_time_seconds)
  values (v_user_id, v_session.course_id, v_session.id, 0, false, v_seconds);
  insert into academy_progress (user_id, course_id, best_score, attempts)
  values (v_user_id, v_session.course_id, 0, 1)
  on conflict (user_id, course_id) do update set attempts = academy_progress.attempts + 1, best_score = greatest(coalesce(academy_progress.best_score, 0), 0), updated_at = now();
end;
$$;

drop function if exists academy_admin_save_course(uuid,text,text,text,text,text,text,boolean,boolean,int,int,boolean,int);
create or replace function academy_admin_save_course(
  p_course_id uuid, p_code text, p_title text, p_course_url text, p_description text,
  p_material_url text, p_material_label text, p_requires_certificate boolean, p_has_exam boolean,
  p_points int, p_xp int, p_quiz_duration_minutes int, p_active boolean, p_sort_order int
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_actor academy_users; v_id uuid; v_code text := lower(trim(p_code)); v_title text := trim(p_title);
  v_course_url text := nullif(trim(p_course_url), ''); v_material_url text := nullif(trim(p_material_url), '');
begin
  select * into v_actor from academy_users where id = academy_current_user_id();
  if v_actor.id is null or v_actor.role <> 'admin' then raise exception 'admin required'; end if;
  if v_code !~ '^[a-z0-9][a-z0-9_-]{1,49}$' then raise exception 'invalid course code'; end if;
  if length(v_title) < 3 or length(v_title) > 160 then raise exception 'invalid course title'; end if;
  if v_course_url is not null and (length(v_course_url) > 2000 or v_course_url !~* '^https://') then raise exception 'invalid course URL'; end if;
  if v_material_url is not null and (length(v_material_url) > 2000 or v_material_url !~* '^https://') then raise exception 'invalid material URL'; end if;
  if p_points < 0 or p_xp < 0 or p_sort_order < 0 or p_quiz_duration_minutes not between 1 and 120 then raise exception 'invalid numeric values'; end if;
  if p_course_id is null then
    insert into academy_courses (code, title, udemy_name, udemy_url, description, material_url, material_label, requires_certificate, has_exam, points, xp, quiz_duration_minutes, active, sort_order)
    values (v_code, v_title, v_title, v_course_url, nullif(trim(p_description), ''), v_material_url, nullif(trim(p_material_label), ''), p_requires_certificate, p_has_exam, p_points, p_xp, p_quiz_duration_minutes, p_active, p_sort_order)
    returning id into v_id;
  else
    update academy_courses set code = v_code, title = v_title, udemy_name = v_title, udemy_url = v_course_url,
      description = nullif(trim(p_description), ''), material_url = v_material_url, material_label = nullif(trim(p_material_label), ''),
      requires_certificate = p_requires_certificate, has_exam = p_has_exam, points = p_points, xp = p_xp,
      quiz_duration_minutes = p_quiz_duration_minutes, active = p_active, sort_order = p_sort_order
    where id = p_course_id returning id into v_id;
    if v_id is null then raise exception 'course not found'; end if;
  end if;
  return v_id;
end;
$$;

revoke all on function academy_admin_save_course(uuid,text,text,text,text,text,text,boolean,boolean,int,int,int,boolean,int) from public, anon;
grant execute on function academy_admin_save_course(uuid,text,text,text,text,text,text,boolean,boolean,int,int,int,boolean,int) to authenticated;
