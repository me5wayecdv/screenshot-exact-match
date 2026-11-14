-- Read-only precheck for 20261114_ai_quota_refund_idempotency.sql.
-- Run against staging and production before applying the migration.
-- If the table exists, skip the migration (it is safe to re-run, but the
-- result below tells you the schema is already present).
SELECT 'ai_quota_refunds_exists' AS check_name, name
FROM sqlite_master
WHERE type = 'table' AND name = 'ai_quota_refunds';

SELECT 'ai_rate_limits_exists' AS check_name, name
FROM sqlite_master
WHERE type = 'table' AND name = 'ai_rate_limits';

SELECT 'row_counts' AS check_name,
  (SELECT COUNT(*) FROM ai_rate_limits) AS quota_rows;
