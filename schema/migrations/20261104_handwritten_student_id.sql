-- Handwritten grades: link a graded paper to an enrolled student account.
-- Run ONLY against existing D1 databases (live + staging) BEFORE deploying
-- code that saves student_id: the new INSERT lists the column, so a save
-- fails on a database that lacks it. Fresh databases do NOT need this
-- file: schema/d1-schema.sql already declares the column, and running
-- this ALTER there fails with "duplicate column name".
-- Safe to re-run? No: SQLite ALTER TABLE ADD COLUMN has no IF NOT EXISTS.
-- Run once per existing database, then verify with:
--   SELECT sql FROM sqlite_master WHERE name = 'handwritten_grades';
ALTER TABLE handwritten_grades
  ADD COLUMN student_id TEXT REFERENCES profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS handwritten_grades_student_idx
  ON handwritten_grades(student_id, created_at DESC);
