-- Read-only precheck for the lesson join rate-limit table.
SELECT 'lesson_join_rate_limits_exists' AS check_name, name
FROM sqlite_master
WHERE type = 'table' AND name = 'lesson_join_rate_limits';
