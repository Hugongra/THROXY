import { RankedLead } from "./ranked-lead";

export interface IngestResponse {
  ranked_leads: RankedLead[];
  total_processed: number;
  companies_analyzed: number;
  total_cost_usd: number;
  disqualified_count: number;
}
