import { RankedLead } from "./dto/ranked-lead";
import { IngestResponse } from "./dto/ingest-response";
import { CsvRow } from "./dto/csv-row";
import { PromptVersion } from "./dto/prompt-version";

export type { RankedLead, IngestResponse, CsvRow, PromptVersion };

// SSE streaming events
export type StreamEvent =
  | { type: "progress"; companies_total: number; companies_done: number; leads_scored: number }
  | { type: "batch"; ranked_leads: RankedLead[]; cost: number }
  | { type: "done"; total_processed: number; companies_analyzed: number; total_cost_usd: number; disqualified_count: number }
  | { type: "error"; message: string };
