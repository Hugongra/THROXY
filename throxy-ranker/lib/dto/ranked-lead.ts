export interface RankedLead {
  lead_id: string;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  account_name: string;
  account_domain: string | null;
  employee_range: string | null;
  industry: string | null;
  rank_score: number | null;
  is_disqualified: boolean;
  reasoning: string | null;
  cost_usd: number;
}
