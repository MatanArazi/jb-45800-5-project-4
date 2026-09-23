CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  input_key TEXT,
  result JSONB,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  model_arch TEXT,
  model_accuracy DOUBLE PRECISION,
  inference_ms INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS model_arch TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS model_accuracy DOUBLE PRECISION;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS inference_ms INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at DESC);