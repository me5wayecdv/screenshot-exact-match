-- Preserve the high-entropy join-code requirement when the Egyptian-phone
-- migration replaces the signup trigger. That migration kept the phone
-- validation but restored the old six-character code, which violates
-- profiles_join_code_entropy_check for every new teacher/tutor signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r public.app_role;
begin
  r := case
    when new.raw_user_meta_data->>'role' in ('school_teacher', 'teacher') then 'school_teacher'::public.app_role
    when new.raw_user_meta_data->>'role' = 'tutor' then 'tutor'::public.app_role
    else 'student'::public.app_role
  end;

  insert into public.profiles (id, full_name, join_code, parent_phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
    case when r in ('school_teacher', 'tutor')
      then upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
      else null
    end,
    case when r = 'student'
      and coalesce(new.raw_user_meta_data->>'parent_phone', '') ~ '^\+20(10|11|12|15)[0-9]{8}$'
      then new.raw_user_meta_data->>'parent_phone'
      else null
    end
  );

  insert into public.user_roles (user_id, role) values (new.id, r);
  if r in ('school_teacher', 'tutor') then
    insert into public.teacher_profiles (user_id, type)
    values (new.id, r::text)
    on conflict do nothing;
  end if;
  return new;
end $$;
