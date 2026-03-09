import { NextRequest } from "next/server";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import pLimit from "p-limit";
import { getSupabase } from "@/lib/supabase";
import { PERSONA_SYSTEM_PROMPT, PROMPT_VERSION } from "@/lib/persona-prompt";
import { CsvRow } from "@/lib/dto/csv-row";
import { AccountBatch } from "@/lib/dto/account-batch";
import { Account } from "@/lib/entity/account";
import { Lead } from "@/lib/entity/lead";
import { StreamEvent } from "@/lib/types";
import { RankedLead } from "@/lib/dto/ranked-lead";

const limit = pLimit(5);

const GPT4O_MINI_INPUT_COST = 0.15 / 1_000_000;
const GPT4O_MINI_OUTPUT_COST = 0.60 / 1_000_000;
const CHUNK_SIZE = 20;

async function getActivePrompt(): Promise<{ prompt: string; version: string }> {
  try {
    const { data } = await getSupabase()
      .from("prompt_versions")
      .select("prompt_text, version")
      .eq("is_active", true)
      .limit(1)
      .single();

    if (data?.prompt_text) {
      return { prompt: data.prompt_text, version: data.version };
    }
  } catch {
    // Table may not exist yet or no active prompt — fall back
  }

  return { prompt: PERSONA_SYSTEM_PROMPT, version: PROMPT_VERSION };
}

function getCompanySizeBucket(employeeRange: string): string {
  const range = (employeeRange ?? "").trim().toLowerCase();
  if (["2-10", "11-50", "1-10"].includes(range)) return "Startup (1-50 employees)";
  if (["51-200"].includes(range)) return "SMB (51-200 employees)";
  if (["201-500", "501-1000"].includes(range)) return "Mid-Market (201-1,000 employees)";
  if (["1001-5000", "5001-10000", "10001+"].includes(range)) return "Enterprise (1,000+ employees)";
  return "Unknown size";
}

async function upsertAccountsAndLeads(rows: CsvRow[]): Promise<AccountBatch[]> {
  const accountMap = new Map<string, { rows: CsvRow[] }>();

  for (const row of rows) {
    const key = `${row.account_name}::${row.account_domain}`.toLowerCase();
    const existing = accountMap.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      accountMap.set(key, { rows: [row] });
    }
  }

  const batches: AccountBatch[] = [];

  for (const [, group] of accountMap) {
    const sample = group.rows[0];

    const { data: account, error: accError } = await getSupabase()
      .from("accounts")
      .upsert(
        {
          name: sample.account_name,
          domain: sample.account_domain || null,
          employee_range: sample.account_employee_range || null,
          industry: sample.account_industry || null,
        },
        { onConflict: "name,domain" }
      )
      .select()
      .single();

    if (accError || !account) {
      console.error("Account upsert error:", accError);
      continue;
    }

    const leadsToInsert = group.rows.map((r) => ({
      account_id: account.id,
      first_name: r.lead_first_name,
      last_name: r.lead_last_name || null,
      job_title: r.lead_job_title || null,
      linkedin_url: null,
    }));

    const { data: leads, error: leadError } = await getSupabase()
      .from("leads")
      .insert(leadsToInsert)
      .select();

    if (leadError || !leads) {
      console.error("Lead insert error:", leadError);
      continue;
    }

    batches.push({ account: account as Account, leads: leads as Lead[] });
  }

  return batches;
}

const scoringSchema = z.object({
  scored_leads: z.array(
    z.object({
      index: z.number().describe("The [index] number from the input list"),
      rank_score: z.number().min(1).max(10).nullable().describe("1=best fit, 10=worst fit. null if disqualified"),
      is_disqualified: z.boolean().describe("true if lead matches a hard exclusion"),
      reasoning: z.string().describe("1-2 sentence explanation for the ranking decision"),
    })
  ),
});

async function scoreLeadChunk(
  leads: Lead[],
  account: Account,
  sizeBucket: string,
  systemPrompt: string
) {
  const leadSummaries = leads.map(
    (l, i) => `[${i}] ${l.first_name} ${l.last_name ?? ""} — "${l.job_title ?? "Unknown"}"`
  );

  const { object, usage } = await generateObject({
    model: openai("gpt-4o-mini"),
    system: systemPrompt,
    schema: scoringSchema,
    prompt: `Rank the following leads from company "${account.name}".
Company size: ${sizeBucket}
Employee range: ${account.employee_range ?? "Unknown"}
Industry: ${account.industry ?? "Unknown"}
Domain: ${account.domain ?? "Unknown"}

Leads to rank:
${leadSummaries.join("\n")}

IMPORTANT: Return exactly ${leads.length} entries. Use the [index] number from each lead as the "index" field.`,
  });

  return {
    scored: object.scored_leads,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

async function scoreAccountBatch(
  batch: AccountBatch,
  emit: (event: StreamEvent) => void,
  companiesDone: { count: number },
  companiesTotal: number,
  systemPrompt: string,
  promptVersion: string
): Promise<{ rankedLeads: RankedLead[]; cost: number }> {
  const sizeBucket = getCompanySizeBucket(batch.account.employee_range ?? "");
  const batchLeads: RankedLead[] = [];
  let totalCost = 0;

  for (let start = 0; start < batch.leads.length; start += CHUNK_SIZE) {
    const chunk = batch.leads.slice(start, start + CHUNK_SIZE);

    const { scored, inputTokens, outputTokens } = await scoreLeadChunk(
      chunk,
      batch.account,
      sizeBucket,
      systemPrompt
    );

    const callCost =
      inputTokens * GPT4O_MINI_INPUT_COST +
      outputTokens * GPT4O_MINI_OUTPUT_COST;
    const costPerLead = chunk.length > 0 ? callCost / chunk.length : 0;
    totalCost += callCost;

    const validScores = scored.filter(
      (s) => s.index >= 0 && s.index < chunk.length
    );

    const rankingsToInsert = validScores.map((s) => ({
      lead_id: chunk[s.index].id,
      rank_score: s.is_disqualified ? null : s.rank_score,
      is_disqualified: s.is_disqualified,
      reasoning: s.reasoning,
      prompt_version: promptVersion,
      cost_usd: costPerLead,
    }));

    if (rankingsToInsert.length > 0) {
      await getSupabase().from("rankings").insert(rankingsToInsert);
    }

    const chunkLeads: RankedLead[] = validScores.map((s) => {
      const lead = chunk[s.index];
      return {
        lead_id: lead.id,
        first_name: lead.first_name,
        last_name: lead.last_name,
        job_title: lead.job_title,
        account_name: batch.account.name,
        account_domain: batch.account.domain,
        employee_range: batch.account.employee_range,
        industry: batch.account.industry,
        rank_score: s.is_disqualified ? null : s.rank_score,
        is_disqualified: s.is_disqualified,
        reasoning: s.reasoning,
        cost_usd: costPerLead,
      };
    });

    batchLeads.push(...chunkLeads);
  }

  companiesDone.count++;

  emit({
    type: "batch",
    ranked_leads: batchLeads,
    cost: totalCost,
  });

  emit({
    type: "progress",
    companies_total: companiesTotal,
    companies_done: companiesDone.count,
    leads_scored: batchLeads.length,
  });

  return { rankedLeads: batchLeads, cost: totalCost };
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const { rows } = (await request.json()) as { rows: CsvRow[] };

        if (!rows || !Array.isArray(rows) || rows.length === 0) {
          emit({ type: "error", message: "No rows provided." });
          controller.close();
          return;
        }

        emit({ type: "progress", companies_total: 0, companies_done: 0, leads_scored: 0 });

        const batches = await upsertAccountsAndLeads(rows);

        emit({ type: "progress", companies_total: batches.length, companies_done: 0, leads_scored: 0 });

        const { prompt: activePrompt, version: activeVersion } = await getActivePrompt();
        const companiesDone = { count: 0 };

        const results = await Promise.all(
          batches.map((batch) =>
            limit(() => scoreAccountBatch(batch, emit, companiesDone, batches.length, activePrompt, activeVersion))
          )
        );

        const allRankedLeads = results.flatMap((r) => r.rankedLeads);
        const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
        const disqualifiedCount = allRankedLeads.filter((l) => l.is_disqualified).length;

        emit({
          type: "done",
          total_processed: allRankedLeads.length,
          companies_analyzed: batches.length,
          total_cost_usd: totalCost,
          disqualified_count: disqualifiedCount,
        });
      } catch (error) {
        console.error("Ingest error:", error);
        emit({ type: "error", message: "Failed to process leads. Check server logs." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
