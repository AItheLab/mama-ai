-- 001_initial.sql
-- Core Mama schema for memory, audit, jobs, usage, and skills.

-- Episodic memory
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL,
  channel TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  metadata JSON,
  consolidated BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp);
CREATE INDEX IF NOT EXISTS idx_episodes_consolidated ON episodes(consolidated);

-- Consolidated memory
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  source_episodes JSON,
  embedding BLOB,
  active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(active);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL,
  capability TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  params JSON,
  result TEXT NOT NULL,
  output TEXT,
  approved_by TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_capability ON audit_log(capability);
CREATE INDEX IF NOT EXISTS idx_audit_log_result ON audit_log(result);

-- Scheduled jobs
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  schedule TEXT,
  task TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  last_run DATETIME,
  next_run DATETIME,
  run_count INTEGER DEFAULT 0,
  last_result JSON
);

CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run);

-- LLM usage tracking
CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  task_type TEXT,
  latency_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_timestamp ON llm_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_usage_provider ON llm_usage(provider);
CREATE INDEX IF NOT EXISTS idx_llm_usage_model ON llm_usage(model);

-- Skills registry
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  installed_at DATETIME NOT NULL,
  manifest JSON NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  checksum TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
