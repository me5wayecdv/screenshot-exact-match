-- Additive, contains only one aggregate count per UTC day.
-- No effect on user limits/plans. Apply before configuring a request budget.
CREATE TABLE IF NOT EXISTS ai_provider_daily_budget (
  day TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0)
);

-- Optional per-network-attempt ledger. No user/student/content columns.
CREATE TABLE IF NOT EXISTS ai_provider_attempts (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('response','network_error')),
  http_status INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  agreement_request INTEGER NOT NULL DEFAULT 0 CHECK (agreement_request IN (0,1))
);
