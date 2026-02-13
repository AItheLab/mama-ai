-- 002_memories_reinforcement.sql
-- Adds reinforcement tracking fields for consolidated memory operations.

ALTER TABLE memories ADD COLUMN reinforcement_count INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_reinforced_at DATETIME;
ALTER TABLE memories ADD COLUMN contradictions JSON;

CREATE INDEX IF NOT EXISTS idx_memories_reinforcement_count ON memories(reinforcement_count);
CREATE INDEX IF NOT EXISTS idx_memories_last_reinforced_at ON memories(last_reinforced_at);
