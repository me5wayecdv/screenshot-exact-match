-- Read-only precheck for the lesson join rate-limit migration.
-- An empty result for either query means the corresponding object is absent.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'lesson_join_rate_limits'
  ) THEN 'PRESENT' ELSE 'ABSENT' END AS table_status,
  'lesson_join_rate_limits' AS object_name;

SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'lesson_join_rate_limits_updated_idx'
  ) THEN 'PRESENT' ELSE 'ABSENT' END AS index_status,
  'lesson_join_rate_limits_updated_idx' AS object_name;
