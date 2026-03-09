-- accounts table
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR NOT NULL,
  domain VARCHAR,
  employee_range VARCHAR,
  industry VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name, domain)
);

-- leads table
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  first_name VARCHAR NOT NULL,
  last_name VARCHAR,
  job_title VARCHAR,
  linkedin_url VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- rankings table (one per ranking run per lead)
CREATE TABLE rankings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  rank_score INT CHECK (rank_score BETWEEN 1 AND 10),
  is_disqualified BOOLEAN DEFAULT false,
  reasoning TEXT,
  prompt_version VARCHAR DEFAULT 'v1',
  cost_usd DECIMAL(10, 6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_leads_account_id ON leads(account_id);
CREATE INDEX idx_rankings_lead_id ON rankings(lead_id);
CREATE INDEX idx_rankings_created_at ON rankings(created_at DESC);

-- Enable RLS with permissive policies for MVP
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE rankings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON accounts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON leads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON rankings FOR ALL USING (true) WITH CHECK (true);
