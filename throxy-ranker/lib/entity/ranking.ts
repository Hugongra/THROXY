export interface Ranking {
  id: string;
  lead_id: string;
  rank_score: number | null;
  is_disqualified: boolean;
  reasoning: string | null;
  prompt_version: string;
  cost_usd: number;
  created_at: string;
}
