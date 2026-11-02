-- Tutor teachers never received a teacher join code: handle_new_user()
-- (20261026130000_segmentation.sql) only generates join_code for
-- school_teacher, so the /students page shows "—" for tutors and there
-- is no code a student can use to join them. Fix: generate codes for
-- tutors too, and backfill existing teachers who currently have NULL.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.app_role;
begin
  r := case
    when new.raw_user_meta_data->>'role' in ('school_teacher', 'teacher') then 'school_teacher'::public.app_role
    when new.raw_user_meta_data->>'role' = 'tutor' then 'tutor'::public.app_role
    when new.raw_user_meta_data->>'role' = 'admin' then 'admin'::public.app_role
    else 'student'::public.app_role end;
  insert into public.profiles (id, full_name, join_code)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
          case when r in ('school_teacher', 'tutor') then upper(substr(md5(random()::text || new.id::text), 1, 6)) else null end);
  insert into public.user_roles (user_id, role) values (new.id, r);
  if r in ('school_teacher', 'tutor') then
    insert into public.teacher_profiles (user_id, type) values (new.id, r::text) on conflict do nothing;
  end if;
  return new;
end $$;

-- Backfill: every existing teacher (school_teacher or tutor) without a
-- code gets one. Retry on the (very unlikely) unique collision instead
-- of failing the migration.
DO $$
DECLARE
  r RECORD;
  new_code TEXT;
BEGIN
  FOR r IN
    SELECT p.id FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id
    WHERE ur.role IN ('school_teacher', 'tutor') AND p.join_code IS NULL
  LOOP
    LOOP
      new_code := upper(substr(md5(random()::text || r.id::text), 1, 6));
      BEGIN
        UPDATE public.profiles SET join_code = new_code WHERE id = r.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- collision: try a fresh code
      END;
    END LOOP;
  END LOOP;
END $$;
