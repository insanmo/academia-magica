alter table academy_courses add column if not exists material_url text;
alter table academy_courses add column if not exists material_label text;
alter table academy_courses add column if not exists requires_certificate boolean not null default true;
alter table academy_courses add column if not exists has_exam boolean not null default true;

create or replace function academy_save_certificate(p_course_id uuid, p_certificate_url text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := academy_current_user_id();
  v_url text := trim(p_certificate_url);
  v_course academy_courses;
begin
  if v_user_id is null then raise exception 'not registered'; end if;
  select * into v_course from academy_courses where id = p_course_id and active;
  if v_course.id is null then raise exception 'invalid course'; end if;
  if not v_course.requires_certificate then raise exception 'certificate not required'; end if;
  if length(v_url) > 2000 or v_url !~* '^https://([a-z0-9-]+\.)*sharepoint\.com/' then
    raise exception 'invalid SharePoint URL';
  end if;
  insert into academy_progress (user_id, course_id, certificate_url, completed, completed_at)
  values (v_user_id, p_course_id, v_url, not v_course.has_exam, case when not v_course.has_exam then now() end)
  on conflict (user_id, course_id) do update
  set certificate_url = excluded.certificate_url,
      completed = academy_progress.completed or not v_course.has_exam,
      completed_at = case when academy_progress.completed_at is null and not v_course.has_exam then now() else academy_progress.completed_at end,
      updated_at = now();
end;
$$;

create or replace function academy_complete_course(p_course_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := academy_current_user_id();
  v_course academy_courses;
begin
  if v_user_id is null then raise exception 'not registered'; end if;
  select * into v_course from academy_courses where id = p_course_id and active;
  if v_course.id is null then raise exception 'invalid course'; end if;
  if v_course.has_exam then raise exception 'exam required'; end if;
  if v_course.requires_certificate and not exists (
    select 1 from academy_progress where user_id = v_user_id and course_id = p_course_id and certificate_url is not null
  ) then raise exception 'certificate required'; end if;
  insert into academy_progress (user_id, course_id, completed, completed_at)
  values (v_user_id, p_course_id, true, now())
  on conflict (user_id, course_id) do update
  set completed = true, completed_at = coalesce(academy_progress.completed_at, now()), updated_at = now();
end;
$$;

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
  insert into academy_quiz_sessions (user_id, course_id) values (v_user_id, p_course_id) returning id into v_session_id;
  return jsonb_build_object('session_id', v_session_id, 'expires_in_seconds', 180, 'questions', v_questions);
end;
$$;

create or replace function academy_admin_save_course(
  p_course_id uuid, p_code text, p_title text, p_course_url text, p_description text,
  p_material_url text, p_material_label text, p_requires_certificate boolean, p_has_exam boolean,
  p_points int, p_xp int, p_active boolean, p_sort_order int
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
  if p_points < 0 or p_xp < 0 or p_sort_order < 0 then raise exception 'invalid numeric values'; end if;
  if p_course_id is null then
    insert into academy_courses (code, title, udemy_name, udemy_url, description, material_url, material_label, requires_certificate, has_exam, points, xp, active, sort_order)
    values (v_code, v_title, v_title, v_course_url, nullif(trim(p_description), ''), v_material_url, nullif(trim(p_material_label), ''), p_requires_certificate, p_has_exam, p_points, p_xp, p_active, p_sort_order)
    returning id into v_id;
  else
    update academy_courses set code = v_code, title = v_title, udemy_name = v_title, udemy_url = v_course_url,
      description = nullif(trim(p_description), ''), material_url = v_material_url, material_label = nullif(trim(p_material_label), ''),
      requires_certificate = p_requires_certificate, has_exam = p_has_exam, points = p_points, xp = p_xp,
      active = p_active, sort_order = p_sort_order
    where id = p_course_id returning id into v_id;
    if v_id is null then raise exception 'course not found'; end if;
  end if;
  return v_id;
end;
$$;

drop policy if exists "academy_courses_read" on academy_courses;
create policy "academy_courses_read" on academy_courses for select to authenticated
using (active or academy_current_user_role() = 'admin');

revoke all on function academy_complete_course(uuid), academy_admin_save_course(uuid,text,text,text,text,text,text,boolean,boolean,int,int,boolean,int) from public, anon;
grant execute on function academy_complete_course(uuid), academy_admin_save_course(uuid,text,text,text,text,text,text,boolean,boolean,int,int,boolean,int) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('academy-course-materials', 'academy-course-materials', true, 26214400)
on conflict (id) do update set public = true, file_size_limit = 26214400;

drop policy if exists "academy_course_materials_admin_insert" on storage.objects;
create policy "academy_course_materials_admin_insert" on storage.objects for insert to authenticated
with check (bucket_id = 'academy-course-materials' and public.academy_current_user_role() = 'admin');

drop policy if exists "academy_course_materials_admin_update" on storage.objects;
create policy "academy_course_materials_admin_update" on storage.objects for update to authenticated
using (bucket_id = 'academy-course-materials' and public.academy_current_user_role() = 'admin')
with check (bucket_id = 'academy-course-materials' and public.academy_current_user_role() = 'admin');

drop policy if exists "academy_course_materials_admin_delete" on storage.objects;
create policy "academy_course_materials_admin_delete" on storage.objects for delete to authenticated
using (bucket_id = 'academy-course-materials' and public.academy_current_user_role() = 'admin');
