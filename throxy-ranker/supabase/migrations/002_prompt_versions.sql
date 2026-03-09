CREATE TABLE prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version VARCHAR NOT NULL UNIQUE,
  prompt_text TEXT NOT NULL,
  is_active BOOLEAN DEFAULT false,
  source VARCHAR DEFAULT 'manual',
  mae DECIMAL(6, 3),
  dq_accuracy DECIMAL(5, 1),
  iteration INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_prompt_versions_active ON prompt_versions(is_active) WHERE is_active = true;

ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON prompt_versions FOR ALL USING (true) WITH CHECK (true);
