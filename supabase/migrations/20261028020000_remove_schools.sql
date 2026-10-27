-- Remove the school feature (product decision 2026-10-28: teachers +
-- students only). Drops the school tables, the school-wide colleague
-- sharing policies (Phase 7), and the school helper functions.
-- Kept: teacher/student roles (school_teacher + tutor are both teacher
-- types), teacher_students / join_teacher, lessons + enrollments,
-- grade_review_requests, LMS export, analytics (lesson groups only).
-- Pre-pilot database: no real schools exist, only test rows.

-- 1. Phase 7 colleague policies on tables that stay.
drop policy if exists "school colleagues read assessments" on public.assessments;
drop policy if exists "school colleagues read questions" on public.questions;
drop policy if exists "school colleagues read submissions" on public.submissions;
drop policy if exists "school colleagues read answers" on public.answers;
drop policy if exists "school colleagues read classes" on public.classes;
drop policy if exists "school colleagues read class members" on public.class_members;
drop policy if exists "school colleagues read student profiles" on public.profiles;

-- 2. School tables (dropping them also drops their own policies).
drop table if exists public.class_members;
drop table if exists public.classes;
drop table if exists public.school_teachers;
drop table if exists public.schools;

-- 3. School helper functions (unused once the policies above are gone).
drop function if exists public.same_school(uuid);
drop function if exists public.is_school_member(uuid);
drop function if exists public.is_school_teacher(uuid);
drop function if exists public.join_school(text);
