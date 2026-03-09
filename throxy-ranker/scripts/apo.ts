/**
 * =============================================================================
 * APO — Automatic Prompt Optimization | Throxy Hard Bonus
 * OPRO (Optimization by Prompting) Framework
 * =============================================================================
 *
 * Production-ready implementation per System Directive & Architecture Spec.
 * Handles 777+ leads across companies with:
 * - Stratified Group Split (withDq / withoutDq buckets)
 * - Chunking (CHUNK_SIZE=40) to avoid LLM output token limits
 * - Multi-metric Loss: FP, Rank Inversions, Distribution Collapse
 * - LLM-as-a-Judge + gpt-4o-mini Optimizer
 * - Supabase persistence
 *
 * @see ARCHITECTURE.md for system overview
 * Usage: npx tsx scripts/apo.ts
 */

import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";
import pLimit from "p-limit";
import { openai } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import dotenv from "dotenv";
import { PERSONA_SYSTEM_PROMPT } from "../lib/persona-prompt";
import { getSupabase } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "..");
const THROXY_ROOT = path.resolve(PROJECT_ROOT, "..");

const EVAL_CSV_PATH = path.join(THROXY_ROOT, "eval_set.csv - Evaluation Set.csv");
const PERSONA_SPEC_PATH = path.join(THROXY_ROOT, "personas_spec.md");
const LEADS_CSV_PATH = path.join(THROXY_ROOT, "leads.csv - Sheet1.csv");
const OUTPUT_PATH = path.join(PROJECT_ROOT, "lib", "ai", "optimized-system-prompt.txt");

const MAX_ITERATIONS = 5; // Per spec: max OPRO loop iterations
const MAX_RETRIES = 5; // Higher for rate-limit resilience (TPM 30k)
const CONCURRENCY = parseInt(process.env.APO_CONCURRENCY ?? "3", 10); // Companies in parallel (default 3; reduce to 2 if 429)
const CHUNK_SIZE = 40; // Per spec: prevents max_tokens overflow (~300 leads/company)
const CHUNK_CONCURRENCY = parseInt(process.env.APO_CHUNK_CONCURRENCY ?? "2", 10); // Chunks per company in parallel (default 2; reduce to 1 if 429)
const TRAIN_SPLIT = 0.8;
const SPLIT_SEED = 42;
const UNLABELED_SAMPLE_COMPANIES = 2;
const TOP_WORST_COMPANIES = 2;
const MIN_VARIANCE_THRESHOLD = 1.5; // Distribution Collapse: std dev < this → Score Inflation penalty
const COLLAPSE_PENALTY_WEIGHT = 2;

// USD per 1M tokens (OpenAI pricing)
const GPT4O_MINI_INPUT = 0.15;
const GPT4O_MINI_OUTPUT = 0.6;

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

interface EvalLead {
  lead_id: string;
  full_name: string;
  title: string;
  company: string;
  employee_range: string;
  expected_score: number;
  expected_disqualified: boolean;
}

interface UnlabeledLead {
  lead_id: string;
  full_name: string;
  title: string;
  company: string;
  employee_range: string;
}

interface CompanyGroup {
  company: string;
  employee_range: string;
  leads: EvalLead[];
}

interface UnlabeledCompanyGroup {
  company: string;
  employee_range: string;
  leads: UnlabeledLead[];
}

interface ScoredLead {
  lead: EvalLead;
  ai_score: number;
  ai_disqualified: boolean;
  ai_reasoning: string;
}

interface CompanyResult {
  company: string;
  leads: ScoredLead[];
  falsePositives: number;
  inversions: number;
  collapsePenalty: number;
  errorNarrative: string;
}

interface CostTracker {
  gpt4oMiniInput: number;
  gpt4oMiniOutput: number;
}

// -----------------------------------------------------------------------------
// PHASE 1: DUAL INGESTION & ADVANCED STRATIFIED SPLIT
// -----------------------------------------------------------------------------

function loadPersonaSpec(): string {
  const p = PERSONA_SPEC_PATH;
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  const fallback = path.join(THROXY_ROOT, "persona_spec.md");
  if (fs.existsSync(fallback)) return fs.readFileSync(fallback, "utf-8");
  throw new Error(`persona_spec.md not found. Tried: ${p}, ${fallback}`);
}

/**
 * Maps raw Rank column to ground-truth labels.
 * @remarks CRITICAL MAPPING (per spec): Rank "-" → expected_disqualified=true, expected_score=0.
 * Numeric Rank 1..10 → expected_score = 11 - Rank, expected_disqualified=false.
 */
function mapRankToGroundTruth(raw: string): {
  expected_score: number;
  expected_disqualified: boolean;
} {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "-" || trimmed === "") {
    return { expected_score: 0, expected_disqualified: true };
  }
  const rank = parseInt(trimmed, 10);
  if (isNaN(rank) || rank < 1 || rank > 10) {
    return { expected_score: 0, expected_disqualified: true };
  }
  return { expected_score: Math.max(1, 11 - rank), expected_disqualified: false };
}

/** Load labeled eval_set.csv (777 leads) from project root. */
function loadEvalSet(): EvalLead[] {
  const csvPath = EVAL_CSV_PATH;
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Eval CSV not found: ${csvPath}`);
  }
  const csvText = fs.readFileSync(csvPath, "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const leads: EvalLead[] = [];
  for (const row of parsed.data) {
    const fullName = row["Full Name"]?.trim();
    const title = row["Title"]?.trim();
    const company = row["Company"]?.trim();
    const employeeRange = row["Employee Range"]?.trim();
    const rankRaw = row["Rank"]?.trim();
    if (!fullName || !title || !company || rankRaw === undefined) continue;
    if (fullName === "Company" || company === "Company") continue;

    const { expected_score, expected_disqualified } = mapRankToGroundTruth(rankRaw);
    leads.push({
      lead_id: "",
      full_name: fullName,
      title,
      company,
      employee_range: employeeRange ?? "Unknown",
      expected_score,
      expected_disqualified,
    });
  }
  return leads;
}

/**
 * Load unlabeled leads.csv and sample N random companies for Distribution Collapse.
 * @remarks Used to detect Score Inflation (model gives everyone 8+).
 */
function loadUnlabeledSample(nCompanies: number): UnlabeledCompanyGroup[] {
  const leadsPath = fs.existsSync(LEADS_CSV_PATH)
    ? LEADS_CSV_PATH
    : path.join(THROXY_ROOT, "leads.csv");
  if (!fs.existsSync(leadsPath)) {
    console.warn("    ⚠ leads.csv not found — skipping Distribution Collapse check.");
    return [];
  }
  const csvText = fs.readFileSync(leadsPath, "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  const byCompany = new Map<string, UnlabeledLead[]>();
  for (const row of parsed.data) {
    const accountName = row["account_name"]?.trim();
    const firstName = row["lead_first_name"]?.trim();
    const lastName = row["lead_last_name"]?.trim();
    const jobTitle = row["lead_job_title"]?.trim();
    const range = row["account_employee_range"]?.trim();
    if (!accountName || !firstName || !jobTitle) continue;

    const fullName = `${firstName} ${lastName ?? ""}`.trim();
    const list = byCompany.get(accountName) ?? [];
    list.push({
      lead_id: String(list.length),
      full_name: fullName,
      title: jobTitle,
      company: accountName,
      employee_range: range ?? "Unknown",
    });
    byCompany.set(accountName, list);
  }

  const entries = [...byCompany.entries()].filter(([, leads]) => leads.length >= 3);
  const shuffled = shuffleWithSeed(entries, SPLIT_SEED + 1);
  return shuffled.slice(0, nCompanies).map(([company, leads]) => ({
    company,
    employee_range: leads[0]?.employee_range ?? "Unknown",
    leads,
  }));
}

function groupByCompany(leads: EvalLead[]): CompanyGroup[] {
  const map = new Map<string, EvalLead[]>();
  for (const lead of leads) {
    const key = lead.company.trim();
    const list = map.get(key) ?? [];
    list.push(lead);
    map.set(key, list);
  }
  return [...map.entries()].map(([company, leadList]) => ({
    company,
    employee_range: leadList[0]?.employee_range ?? "Unknown",
    leads: leadList.map((l, i) => ({ ...l, lead_id: String(i) })),
  }));
}

function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Stratified Group Split (per spec).
 * @remarks STRATIFIED SPLIT: Separate companies into withDq (has "-" leads) and withoutDq.
 * Split each bucket 80% Train / 20% Test. Merge back. Ensures both train and test
 * get proportional DQ-companies so the HR filter can be learned and evaluated.
 * @remarks Edge case: If only 1 company has DQ leads, it goes to Train (trainCount=1),
 * Test gets 0 DQ companies → log warning.
 */
function stratifiedSplit(
  groups: CompanyGroup[]
): { train: CompanyGroup[]; test: CompanyGroup[] } {
  const hasDq = (g: CompanyGroup) => g.leads.some((l) => l.expected_disqualified);
  const withDq = groups.filter(hasDq);
  const withoutDq = groups.filter((g) => !hasDq(g));

  const splitBucket = (arr: CompanyGroup[]): { train: CompanyGroup[]; test: CompanyGroup[] } => {
    const shuffled = shuffleWithSeed(arr, SPLIT_SEED);
    const n = shuffled.length;
    if (n === 0) return { train: [], test: [] };
    const trainCount = Math.max(1, Math.floor(n * TRAIN_SPLIT));
    return {
      train: shuffled.slice(0, trainCount),
      test: shuffled.slice(trainCount),
    };
  };

  const dqSplit = splitBucket(withDq);
  const noDqSplit = splitBucket(withoutDq);

  const train = [...dqSplit.train, ...noDqSplit.train];
  const test = [...dqSplit.test, ...noDqSplit.test];

  const testDqCount = test.filter(hasDq).length;
  if (withDq.length > 0 && testDqCount === 0) {
    console.warn("  ⚠ Test set has no companies with DQ leads. HR Filter cannot be evaluated on test.");
  }
  return { train, test };
}

// -----------------------------------------------------------------------------
// PHASE 2: GROUPWISE EVALUATOR WITH CHUNKING
// -----------------------------------------------------------------------------

/**
 * Zod schema enforcing Chain-of-Thought (per spec).
 * @remarks CRITICAL: Order matters. reasoning BEFORE is_disqualified and score
 * forces the LLM to justify hierarchy/persona fit before committing.
 */
const evalCoTSchema = z.object({
  scored_leads: z.array(
    z.object({
      lead_id: z.string(),
      reasoning: z.string().describe("Chain-of-thought: justify hierarchy vs other leads"),
      is_disqualified: z.boolean(),
      score: z.number().min(0).max(10),
    })
  ),
});

/** Evaluate one chunk (≤ CHUNK_SIZE). Single generateObject call. */
async function evaluateOneChunk(
  company: string,
  employee_range: string,
  chunkLeads: (EvalLead | UnlabeledLead)[],
  systemPrompt: string,
  personaSpec: string,
  tokenAcc: { input: number; output: number }
): Promise<ScoredLead[]> {
  const leadList = chunkLeads.map((l) => `[${l.lead_id}] ${l.full_name} — "${l.title}"`).join("\n");

  const fullSystemPrompt = `${systemPrompt}

---
PERSONA SPECIFICATION:
---
${personaSpec}
---
`;

  const userPrompt = `Company: "${company}"
Employee range: ${employee_range}

Leads to rank (consider ALL together; identify the true decision-maker):

${leadList}

Return exactly ${chunkLeads.length} entries. Use the [index] as lead_id.`;

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { object, usage } = await generateObject({
        model: openai("gpt-4o-mini"),
        system: fullSystemPrompt,
        schema: evalCoTSchema,
        prompt: userPrompt,
      });

      const u = usage as { promptTokens?: number; inputTokens?: number; completionTokens?: number; outputTokens?: number };
      tokenAcc.input += u?.promptTokens ?? u?.inputTokens ?? 0;
      tokenAcc.output += u?.completionTokens ?? u?.outputTokens ?? 0;

      const scoredById = new Map<string, (typeof object.scored_leads)[0]>();
      for (const s of object.scored_leads) {
        scoredById.set(s.lead_id, s);
      }

      return chunkLeads.map((lead) => {
        const s = scoredById.get(lead.lead_id) ?? { reasoning: "", is_disqualified: false, score: 5 };
        const ai_score = s.is_disqualified ? 0 : s.score;
        return {
          lead: lead as EvalLead,
          ai_score,
          ai_disqualified: s.is_disqualified,
          ai_reasoning: s.reasoning,
        };
      });
    } catch (err) {
      lastErr = err as Error;
      if (attempt < MAX_RETRIES) {
        const e = err as { statusCode?: number; cause?: { statusCode?: number }; lastError?: { statusCode?: number } };
        const status429 =
          e?.statusCode === 429 || e?.cause?.statusCode === 429 || e?.lastError?.statusCode === 429;
        const isRateLimit = status429 || /rate limit/i.test(String((err as Error).message));
        const delay = isRateLimit ? 12000 : 1000 * attempt; // 12s for TPM reset
        if (isRateLimit) {
          console.warn(`  [Rate limit] Waiting ${delay / 1000}s before retry ${attempt}/${MAX_RETRIES}...`);
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr ?? new Error("Evaluation failed after retries");
}

/**
 * Chunking (per spec): Companies may have ~300 leads. Slice into CHUNK_SIZE=40,
 * run chunks with p-limit(CHUNK_CONCURRENCY=2), .flat() merge results.
 */
async function runEvaluator(
  group: CompanyGroup | UnlabeledCompanyGroup,
  systemPrompt: string,
  personaSpec: string,
  tokenAcc: { input: number; output: number }
): Promise<ScoredLead[]> {
  const { company, employee_range, leads } = group;

  if (leads.length <= CHUNK_SIZE) {
    return evaluateOneChunk(company, employee_range, leads, systemPrompt, personaSpec, tokenAcc);
  }

  const chunks: (EvalLead | UnlabeledLead)[][] = [];
  for (let i = 0; i < leads.length; i += CHUNK_SIZE) {
    chunks.push(leads.slice(i, i + CHUNK_SIZE));
  }

  const chunkLimit = pLimit(CHUNK_CONCURRENCY);
  const chunkResults = await Promise.all(
    chunks.map((chunkLeads) =>
      chunkLimit(() =>
        evaluateOneChunk(company, employee_range, chunkLeads, systemPrompt, personaSpec, tokenAcc)
      )
    )
  );

  return chunkResults.flat();
}

async function runEvaluatorUnlabeled(
  group: UnlabeledCompanyGroup,
  systemPrompt: string,
  personaSpec: string,
  tokenAcc: { input: number; output: number }
): Promise<number[]> {
  const scored = await runEvaluator(group, systemPrompt, personaSpec, tokenAcc);
  return scored.map((s) => s.ai_score).filter((v) => v > 0);
}

// -----------------------------------------------------------------------------
// PHASE 3: LOSS FUNCTION & DISTRIBUTION COLLAPSE
// -----------------------------------------------------------------------------

/**
 * Standard deviation for Distribution Collapse.
 * @remarks Score Inflation: If std dev < 1.5, model gives everyone high scores
 * and fails to discriminate → severe penalty.
 */
function stdDev(scores: number[]): number {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, x) => sum + (x - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

/**
 * Multi-metric loss: FP (HR filter), Rank Inversions, Distribution Collapse.
 */
function calculateMetrics(
  scored: ScoredLead[],
  unlabeledScoresByCompany: number[][]
): {
  falsePositives: number;
  inversions: number;
  collapsePenalty: number;
  minVariance: number;
  narrative: string;
} {
  let falsePositives = 0;
  const fpLeads: ScoredLead[] = [];
  for (const s of scored) {
    if (s.lead.expected_disqualified && !s.ai_disqualified) {
      falsePositives++;
      fpLeads.push(s);
    }
  }

  let inversions = 0;
  const invPairs: { worse: ScoredLead; better: ScoredLead }[] = [];
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const a = scored[i];
      const b = scored[j];
      if (a.lead.expected_score > b.lead.expected_score && a.ai_score < b.ai_score) {
        inversions++;
        invPairs.push({ worse: b, better: a });
      }
    }
  }

  let collapsePenalty = 0;
  let minVariance = Infinity;
  for (const scores of unlabeledScoresByCompany) {
    const sd = stdDev(scores);
    if (scores.length >= 2) minVariance = Math.min(minVariance, sd);
    if (sd < MIN_VARIANCE_THRESHOLD && scores.length >= 2) {
      collapsePenalty += (MIN_VARIANCE_THRESHOLD - sd) * COLLAPSE_PENALTY_WEIGHT;
    }
  }
  if (unlabeledScoresByCompany.length === 0) minVariance = Infinity;

  const lines: string[] = [];
  for (const s of fpLeads.slice(0, 3)) {
    lines.push(`- You did not disqualify "${s.lead.full_name}" (${s.lead.title}) — should be DQ.`);
  }
  for (const { worse, better } of invPairs.slice(0, 3)) {
    lines.push(
      `- Inversion: "${worse.lead.full_name}" (${worse.lead.title}) scored above "${better.lead.full_name}" (${better.lead.title}).`
    );
  }
  const narrative = lines.join("\n") || "No critical errors.";
  return { falsePositives, inversions, collapsePenalty, minVariance, narrative };
}

// -----------------------------------------------------------------------------
// PHASE 4: LLM-AS-A-JUDGE & OPTIMIZER
// -----------------------------------------------------------------------------

/**
 * Judge (gpt-4o-mini): Feeds reasoning from top 2 worst companies.
 * Asks: "What part of the System Prompt confused the evaluating AI?"
 */
async function runJudge(
  worstErrors: CompanyResult[],
  costTracker: CostTracker
): Promise<string> {
  const reasoningSamples: string[] = [];

  for (const c of worstErrors) {
    for (const s of c.leads.filter((l) => l.lead.expected_disqualified && !l.ai_disqualified).slice(0, 2)) {
      reasoningSamples.push(`[FP] Lead: ${s.lead.full_name} (${s.lead.title})\nAI reasoning: "${s.ai_reasoning}"`);
    }
    for (let i = 0; i < c.leads.length; i++) {
      for (let j = i + 1; j < c.leads.length; j++) {
        const a = c.leads[i];
        const b = c.leads[j];
        if (
          a.lead.expected_score > b.lead.expected_score &&
          a.ai_score < b.ai_score
        ) {
          reasoningSamples.push(
            `[Inv] Better: ${a.lead.full_name} (${a.lead.title}) | Worse: ${b.lead.full_name} (${b.lead.title})\n` +
              `Better reasoning: "${a.ai_reasoning}"\nWorse reasoning: "${b.ai_reasoning}"`
          );
        }
      }
    }
  }

  const samples = reasoningSamples.slice(0, 6);
  if (samples.length === 0) {
    return "Rank inversion and/or HR filter errors. Review exclusion rules and relative ranking.";
  }

  const judgePrompt = `You are an expert reviewer. The lead-evaluating AI made these errors (did not disqualify when it should have, or inverted the hierarchy).

AI REASONING IN FAILURES:
---
${samples.join("\n\n---\n\n")}
---

Question: What part of the System Prompt likely confused the evaluating AI and caused these errors? Answer in 2-4 sentences, being specific.`;

  const { text, usage } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: judgePrompt,
  });

  const u = usage as { promptTokens?: number; inputTokens?: number; completionTokens?: number; outputTokens?: number };
  costTracker.gpt4oMiniInput += u?.promptTokens ?? u?.inputTokens ?? 0;
  costTracker.gpt4oMiniOutput += u?.completionTokens ?? u?.outputTokens ?? 0;

  return text.trim();
}

/**
 * Optimizer (gpt-4o-mini): Rewrites prompt from Judge diagnosis.
 * Uses internal Chain of Thought to deduce rules. Instructs Few-Shot injection.
 */
async function runOptimizer(
  currentPrompt: string,
  worstErrors: CompanyResult[],
  judgeDiagnosis: string,
  costTracker: CostTracker
): Promise<string> {
  const errorsText = worstErrors
    .map(
      (c, i) =>
        `Company ${i + 1}: ${c.company}\n  FP: ${c.falsePositives} | Inv: ${c.inversions} | Collapse: ${c.collapsePenalty.toFixed(1)}\n  ${c.errorNarrative}`
    )
    .join("\n\n");

  const metaPrompt = `You are an expert AI Engineer. A Judge analyzed the evaluating AI's failures and concluded:

JUDGE'S DIAGNOSIS:
---
${judgeDiagnosis}
---

FAILURE EXAMPLES:
${errorsText}

CURRENT PROMPT:
---
${currentPrompt}
---

Instructions:
1. Rewrite the System Prompt to fix these exact edge cases. Use your reasoning to deduce the best rules that avoid Rank Inversions and False Positives.
2. Add Few-Shot examples based on the failures if it helps (e.g. "If title is 'Angel Investor' → is_disqualified: true").
3. Keep the original structure. Add rules or examples where they clarify boundaries.

Return ONLY the new prompt. No explanations, no markdown.`;

  const { text, usage } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: metaPrompt,
  });

  const u = usage as { promptTokens?: number; inputTokens?: number; completionTokens?: number; outputTokens?: number };
  costTracker.gpt4oMiniInput += u?.promptTokens ?? u?.inputTokens ?? 0;
  costTracker.gpt4oMiniOutput += u?.completionTokens ?? u?.outputTokens ?? 0;

  return stripMarkdownFences(text);
}

function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:text|markdown|plaintext)?\s*\n?/i, "");
  cleaned = cleaned.replace(/\n?```\s*$/i, "");
  return cleaned.trim();
}

// -----------------------------------------------------------------------------
// COST AWARENESS (per spec: track tokens, log USD)
// -----------------------------------------------------------------------------

function costUSD(tracker: CostTracker): number {
  return (
    (tracker.gpt4oMiniInput / 1e6) * GPT4O_MINI_INPUT +
    (tracker.gpt4oMiniOutput / 1e6) * GPT4O_MINI_OUTPUT
  );
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** Emit progress for UI (parsed by API and forwarded as SSE) */
function reportProgress(percent: number, label: string) {
  process.stdout.write(`__APO_PROGRESS__${JSON.stringify({ percent, label })}\n`);
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

/** Evaluate a single prompt by ID on test set and update Supabase. Usage: npx tsx scripts/apo.ts --evaluate-only=<uuid> */
async function runEvaluateOnly(promptId: string) {
  const costTracker: CostTracker = { gpt4oMiniInput: 0, gpt4oMiniOutput: 0 };
  const evalTokens = { input: 0, output: 0 };

  console.log("");
  console.log("  [EVALUATE ONLY] Evaluating prompt", promptId);
  const personaSpec = loadPersonaSpec();
  const allLeads = loadEvalSet();
  const companyGroups = groupByCompany(allLeads);
  const { test } = stratifiedSplit(companyGroups);

  const supabase = getSupabase();
  const { data: row, error: fetchErr } = await supabase
    .from("prompt_versions")
    .select("id, version, prompt_text")
    .eq("id", promptId)
    .single();

  if (fetchErr || !row?.prompt_text) {
    throw new Error(`Prompt not found: ${promptId}`);
  }

  const limit = pLimit(CONCURRENCY);
  const testResults: CompanyResult[] = await Promise.all(
    test.map((group) =>
      limit(async () => {
        const scored = await runEvaluator(group, row.prompt_text as string, personaSpec, evalTokens);
        const { falsePositives, inversions, narrative } = calculateMetrics(scored, []);
        return {
          company: group.company,
          leads: scored,
          falsePositives,
          inversions,
          collapsePenalty: 0,
          errorNarrative: narrative,
        };
      })
    )
  );

  costTracker.gpt4oMiniInput += evalTokens.input;
  costTracker.gpt4oMiniOutput += evalTokens.output;

  const testFp = testResults.reduce((s, c) => s + c.falsePositives, 0);
  const testInv = testResults.reduce((s, c) => s + c.inversions, 0);
  const mae =
    testResults.length > 0
      ? testResults.reduce((sum, c) => {
          const errs = c.leads.map((s) =>
            Math.abs(s.ai_score - (s.lead as EvalLead).expected_score)
          );
          return sum + errs.reduce((a, b) => a + b, 0) / errs.length;
        }, 0) / testResults.length
      : 0;
  let dqCorrect = 0;
  let dqTotal = 0;
  for (const c of testResults) {
    for (const s of c.leads) {
      dqTotal++;
      if (s.lead.expected_disqualified === s.ai_disqualified) dqCorrect++;
    }
  }
  const dqAccuracy = dqTotal > 0 ? Math.round((dqCorrect / dqTotal) * 1000) / 10 : null;

  const roundedMae = Math.round(mae * 1000) / 1000;
  const { error: updateErr } = await supabase
    .from("prompt_versions")
    .update({
      mae: roundedMae,
      dq_accuracy: dqAccuracy,
      test_inversions: testInv,
      test_false_positives: testFp,
    })
    .eq("id", promptId);

  if (updateErr) throw updateErr;
  console.log(`  ✓ ${row.version}: MAE=${roundedMae} | FP=${testFp} | Inv=${testInv} | DQ=${dqAccuracy ?? "N/A"}%`);
  console.log(`  Cost: ${formatCost(costUSD(costTracker))}`);
}

async function main() {
  const evaluateOnlyId = process.argv.find((a) => a.startsWith("--evaluate-only="))?.split("=")[1];
  if (evaluateOnlyId) {
    await runEvaluateOnly(evaluateOnlyId);
    return;
  }

  console.log("");
  console.log("═".repeat(72));
  console.log("  🤖 APO — Automatic Prompt Optimization");
  console.log("  Throxy Persona Ranker | OPRO + LLM-as-Judge");
  console.log("═".repeat(72));
  console.log("");
  reportProgress(0, "Starting APO...");

  const costTracker: CostTracker = {
    gpt4oMiniInput: 0,
    gpt4oMiniOutput: 0,
  };
  const evalTokens = { input: 0, output: 0 };

  // ---- PHASE 1 ----
  console.log("  [PHASE 1] Dual ingestion + stratified split");
  const personaSpec = loadPersonaSpec();
  console.log(`    ✓ persona_spec (${personaSpec.length} chars)`);
  const allLeads = loadEvalSet();
  const companyGroups = groupByCompany(allLeads);
  const { train, test } = stratifiedSplit(companyGroups);

  const unlabeledSample = loadUnlabeledSample(UNLABELED_SAMPLE_COMPANIES);
  console.log(`    ✓ eval_set: ${allLeads.length} leads, ${companyGroups.length} companies`);
  console.log(`    ✓ Train: ${train.length} | Test: ${test.length}`);
  console.log(`    ✓ Unlabeled sample: ${unlabeledSample.length} companies (variance check)`);
  console.log("");
  reportProgress(5, "Loaded data & stratified split");

  let currentPrompt = PERSONA_SYSTEM_PROMPT;
  let bestPrompt = PERSONA_SYSTEM_PROMPT;
  let bestTotalError = Infinity;
  const limit = pLimit(CONCURRENCY);

  // ---- PHASE 5: COST-AWARE LOOP & EARLY STOPPING ----
  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const iterBase = 5 + (iter - 1) * (70 / MAX_ITERATIONS);
    reportProgress(Math.round(iterBase), `Iteration ${iter}/${MAX_ITERATIONS} — Evaluating train set`);
    console.log("  " + "─".repeat(70));
    console.log(`  [ITERATION ${iter}/${MAX_ITERATIONS}]`);
    console.log(`  Evaluating ${train.length} companies...`);
    console.log("  " + "─".repeat(70));

    const companyResults: CompanyResult[] = [];
    let completed = 0;

    const tasks = train.map((group) =>
      limit(async () => {
        const scored = await runEvaluator(group, currentPrompt, personaSpec, evalTokens);
        const { falsePositives, inversions, narrative } = calculateMetrics(scored, []);
        companyResults.push({
          company: group.company,
          leads: scored,
          falsePositives,
          inversions,
          collapsePenalty: 0,
          errorNarrative: narrative,
        });
        completed++;
        const pct = Math.round(iterBase + (completed / train.length) * (70 / MAX_ITERATIONS) * 0.4);
        reportProgress(Math.min(pct, 75), `Iteration ${iter}/${MAX_ITERATIONS} — ${completed}/${train.length} companies`);
        process.stdout.write(`  [${completed}/${train.length}] ${group.company}\n`);
      })
    );
    await Promise.all(tasks);

    costTracker.gpt4oMiniInput += evalTokens.input;
    costTracker.gpt4oMiniOutput += evalTokens.output;
    evalTokens.input = 0;
    evalTokens.output = 0;

    let unlabeledScoresByCompany: number[][] = [];
    if (unlabeledSample.length > 0) {
      unlabeledScoresByCompany = await Promise.all(
        unlabeledSample.map((ug) => runEvaluatorUnlabeled(ug, currentPrompt, personaSpec, evalTokens))
      );
      costTracker.gpt4oMiniInput += evalTokens.input;
      costTracker.gpt4oMiniOutput += evalTokens.output;
      evalTokens.input = 0;
      evalTokens.output = 0;
    }

    let totalCollapse = 0;
    let minVariance = Infinity;
    for (const scores of unlabeledScoresByCompany) {
      const sd = stdDev(scores);
      if (scores.length >= 2) minVariance = Math.min(minVariance, sd);
      if (sd < MIN_VARIANCE_THRESHOLD && scores.length >= 2) {
        totalCollapse += (MIN_VARIANCE_THRESHOLD - sd) * COLLAPSE_PENALTY_WEIGHT;
      }
    }
    if (unlabeledScoresByCompany.length === 0) minVariance = Infinity;

    const totalFp = companyResults.reduce((s, c) => s + c.falsePositives, 0);
    const totalInv = companyResults.reduce((s, c) => s + c.inversions, 0);
    const totalErr = totalFp + totalInv + totalCollapse;

    console.log(
      `    Errors: ${totalFp} FP + ${totalInv} inv + ${totalCollapse.toFixed(1)} collapse = ${totalErr.toFixed(1)}`
    );
    if (unlabeledSample.length > 0) {
      console.log(`    Min variance: ${minVariance === Infinity ? "N/A" : minVariance.toFixed(2)}`);
    }
    console.log(`    Cost: ${formatCost(costUSD(costTracker))}`);

    if (totalErr < bestTotalError) {
      bestTotalError = totalErr;
      bestPrompt = currentPrompt;
    }

    /** Early stopping (per spec): 0 FP, 0 inv, Variance ≥ 1.5 */
    if (
      totalFp === 0 &&
      totalInv === 0 &&
      (unlabeledSample.length === 0 || minVariance >= MIN_VARIANCE_THRESHOLD)
    ) {
      console.log("");
      console.log("    ✓ Early stopping: 0 FP, 0 inv, variance OK.");
      break;
    }

    const sorted = [...companyResults].sort(
      (a, b) => b.falsePositives + b.inversions - (a.falsePositives + a.inversions)
    );
    const worst = sorted.slice(0, TOP_WORST_COMPANIES);

    console.log(`    Worst ${TOP_WORST_COMPANIES}:`);
    for (const c of worst) {
      console.log(`      - ${c.company}: ${c.falsePositives} FP, ${c.inversions} inv`);
    }

    if (iter < MAX_ITERATIONS) {
      console.log("");
      reportProgress(Math.round(iterBase + 12), "LLM-as-Judge analyzing errors");
      console.log("  [PHASE 4.1] LLM-as-a-Judge...");
      const judgeDiagnosis = await runJudge(worst, costTracker);
      reportProgress(Math.round(iterBase + 14), "OPRO Optimizer rewriting prompt");
      console.log("  [PHASE 4.2] OPRO Optimizer (gpt-4o-mini)...");
      currentPrompt = await runOptimizer(currentPrompt, worst, judgeDiagnosis, costTracker);
    }

    console.log("");
  }

  // ---- PHASE 6: TEST SET VALIDATION & SUPABASE INTEGRATION ----
  reportProgress(80, "Test set validation");
  console.log("  " + "═".repeat(70));
  console.log("  [PHASE 6] Test set validation + Supabase (Baseline vs Optimized)");
  console.log("  " + "═".repeat(70));

  /** Helper: compute MAE, FP, Inv, DQ from CompanyResult[] */
  function computeTestMetrics(results: CompanyResult[]): {
    mae: number;
    testFp: number;
    testInv: number;
    dqAccuracy: number | null;
  } {
    const testFp = results.reduce((s, c) => s + c.falsePositives, 0);
    const testInv = results.reduce((s, c) => s + c.inversions, 0);
    const mae =
      results.length > 0
        ? results.reduce((sum, c) => {
            const errs = c.leads.map((s) =>
              Math.abs(s.ai_score - (s.lead as EvalLead).expected_score)
            );
            return sum + errs.reduce((a, b) => a + b, 0) / errs.length;
          }, 0) / results.length
        : 0;
    let dqCorrect = 0;
    let dqTotal = 0;
    for (const c of results) {
      for (const s of c.leads) {
        dqTotal++;
        if (s.lead.expected_disqualified === s.ai_disqualified) dqCorrect++;
      }
    }
    const dqAccuracy = dqTotal > 0 ? Math.round((dqCorrect / dqTotal) * 1000) / 10 : null;
    return { mae, testFp, testInv, dqAccuracy };
  }

  // 6.1 — Evaluate Baseline (original PERSONA_SYSTEM_PROMPT)
  reportProgress(82, "Evaluating baseline on test set");
  console.log("  [6.1] Evaluating Baseline (original prompt)...");
  const baselineResults: CompanyResult[] = await Promise.all(
    test.map((group) =>
      limit(async () => {
        const scored = await runEvaluator(group, PERSONA_SYSTEM_PROMPT, personaSpec, evalTokens);
        const { falsePositives, inversions, narrative } = calculateMetrics(scored, []);
        return {
          company: group.company,
          leads: scored,
          falsePositives,
          inversions,
          collapsePenalty: 0,
          errorNarrative: narrative,
        };
      })
    )
  );
  costTracker.gpt4oMiniInput += evalTokens.input;
  costTracker.gpt4oMiniOutput += evalTokens.output;
  evalTokens.input = 0;
  evalTokens.output = 0;

  const baseline = computeTestMetrics(baselineResults);
  console.log(`    Baseline: FP=${baseline.testFp} | Inv=${baseline.testInv} | MAE≈${baseline.mae.toFixed(2)} | DQ=${baseline.dqAccuracy != null ? baseline.dqAccuracy + "%" : "N/A"}`);

  // 6.2 — Evaluate Optimized (bestPrompt)
  reportProgress(85, "Evaluating optimized prompt on test set");
  console.log("  [6.2] Evaluating Optimized (best prompt)...");
  const testResults: CompanyResult[] = await Promise.all(
    test.map((group) =>
      limit(async () => {
        const scored = await runEvaluator(group, bestPrompt, personaSpec, evalTokens);
        const { falsePositives, inversions, narrative } = calculateMetrics(scored, []);
        return {
          company: group.company,
          leads: scored,
          falsePositives,
          inversions,
          collapsePenalty: 0,
          errorNarrative: narrative,
        };
      })
    )
  );

  costTracker.gpt4oMiniInput += evalTokens.input;
  costTracker.gpt4oMiniOutput += evalTokens.output;

  const optimized = computeTestMetrics(testResults);
  const testFp = optimized.testFp;
  const testInv = optimized.testInv;
  const mae = optimized.mae;
  const dqAccuracy = optimized.dqAccuracy;

  // 6.3 — Log Delta / Improvement
  const maeDelta = baseline.mae - mae;
  const maePct = baseline.mae > 0 ? ((maeDelta / baseline.mae) * 100).toFixed(1) : "0";
  const fpDelta = baseline.testFp - testFp;
  const invDelta = baseline.testInv - testInv;
  reportProgress(90, `Baseline MAE: ${baseline.mae.toFixed(2)} | Optimized MAE: ${mae.toFixed(2)} (${maeDelta >= 0 ? "Improved" : "Worse"} by ${Math.abs(parseFloat(maePct))}%)`);
  console.log("");
  console.log("  [6.3] Delta (Baseline → Optimized):");
  console.log(`    MAE: ${baseline.mae.toFixed(2)} → ${mae.toFixed(2)} (${maeDelta >= 0 ? "Improved" : "Worse"} by ${maePct}%)`);
  console.log(`    FP:  ${baseline.testFp} → ${testFp} (${fpDelta >= 0 ? fpDelta === 0 ? "No change" : `-${fpDelta}` : `+${Math.abs(fpDelta)}`})`);
  console.log(`    Inv: ${baseline.testInv} → ${testInv} (${invDelta >= 0 ? invDelta === 0 ? "No change" : `-${invDelta}` : `+${Math.abs(invDelta)}`})`);
  console.log(`    Test: FP=${testFp} | Inv=${testInv} | MAE≈${mae.toFixed(2)} | DQ=${dqAccuracy != null ? dqAccuracy + "%" : "N/A"}`);
  console.log("");
  reportProgress(95, "Saving to Supabase");

  /** CRITICAL: Insert Baseline + Optimized into Supabase prompt_versions */
  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from("prompt_versions")
    .select("version")
    .eq("source", "apo")
    .like("version", "runned APO v%");
  const nextV =
    existing?.length
      ? Math.max(
          ...existing.map((r) => {
            const m = r.version?.match(/runned APO v(\d+)/);
            return m ? parseInt(m[1], 10) : 0;
          })
        ) + 1
      : 1;
  const versionBase = `runned APO v${nextV}`;
  const roundedMae = Math.round(mae * 1000) / 1000;
  const baselineRoundedMae = Math.round(baseline.mae * 1000) / 1000;
  try {
    // No auto-activation: user manually activates from Prompt Versions tab.
    const isActive = false;

    // Record 1 — Baseline
    const { data: baselineData, error: baselineErr } = await supabase
      .from("prompt_versions")
      .insert({
        version: `${versionBase} (Baseline)`,
        prompt_text: PERSONA_SYSTEM_PROMPT,
        is_active: false,
        source: "apo",
        mae: baselineRoundedMae,
        dq_accuracy: baseline.dqAccuracy,
        test_inversions: baseline.testInv,
        test_false_positives: baseline.testFp,
        iteration: MAX_ITERATIONS,
      })
      .select()
      .single();

    if (baselineErr) throw baselineErr;
    console.log(`  ✓ Baseline inserted (version: ${versionBase} (Baseline), id: ${baselineData?.id})`);

    // Record 2 — Optimized
    const { data: optimizedData, error: optimizedErr } = await supabase
      .from("prompt_versions")
      .insert({
        version: `${versionBase} (Optimized)`,
        prompt_text: bestPrompt,
        is_active: isActive,
        source: "apo",
        mae: roundedMae,
        dq_accuracy: dqAccuracy,
        test_inversions: testInv,
        test_false_positives: testFp,
        iteration: MAX_ITERATIONS,
      })
      .select()
      .single();

    if (optimizedErr) throw optimizedErr;

    console.log(`  ✓ Optimized inserted (version: ${versionBase} (Optimized), id: ${optimizedData?.id})`);
    console.log(`    MAE: ${mae.toFixed(3)} | Inversions: ${testInv} | False Positives: ${testFp}`);
    const beatsBaseline = roundedMae < baselineRoundedMae;
    console.log(
      `    ℹ Activate manually from Prompt Versions tab. ${beatsBaseline ? `Optimized beats baseline (${baselineRoundedMae}).` : `Baseline MAE ${baselineRoundedMae} is lower.`}`
    );
  } catch (dbErr) {
    console.error("  ✗ Supabase insert failed:", (dbErr as Error).message);
    console.warn("    Ensure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.");
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, bestPrompt, "utf-8");
  console.log(`  ✓ Prompt saved to: ${OUTPUT_PATH}`);
  console.log(`  TOTAL COST: ${formatCost(costUSD(costTracker))}`);
  console.log("");
  reportProgress(100, "APO complete");
}

main().catch((err) => {
  console.error("APO failed:", err);
  process.exit(1);
});
