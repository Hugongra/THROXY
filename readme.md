# Throxy Persona Ranker

B2B lead qualification MVP that ranks sales leads against an Ideal Customer Profile (ICP). Upload a CSV, get scored and disqualified leads streamed back in real time. Includes Automatic Prompt Optimization (APO) to improve the ranking prompt from labeled data.

## 🎬 Demo

https://github.com/user-attachments/assets/30c6e4d6-fd52-4437-bd29-b5d9f65b1380

## 🚀 Quick Start

```bash
git clone https://github.com/Hugongra/THROXY.git
cd THROXY/throxy-ranker
npm install
```

Create `.env.local` in `throxy-ranker`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENAI_API_KEY=your-openai-api-key
```

Place `eval_set.csv - Evaluation Set.csv` and `personas_spec.md` in the project root (parent of `throxy-ranker`) for APO. Run Supabase migrations (see `supabase/migrations/`), then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## ☁️ Vercel Deployment

### Setup

1. **Root Directory:** In Vercel Project Settings → General, set **Root Directory** to `throxy-ranker`.
2. **Environment variables:** Add `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `OPENAI_API_KEY`.

### APO Function Timeout (Hobby vs Pro)

The **Run APO** feature uses a serverless function that can run for several minutes. Vercel limits execution time by plan:

| Plan | Max duration | APO in browser |
|------|--------------|----------------|
| **Hobby** (free) | 300 sec (5 min) | May timeout on large eval sets |
| **Pro** | 900 sec (15 min) | Full APO runs supported |

- **Hobby:** The `api/apo/run` route is capped at 300 seconds. If APO times out, run it locally: `npm run apo` in `throxy-ranker` (no limit).
- **Pro:** Costs **$20/user/month** ([vercel.com/pricing](https://vercel.com/pricing)). Allows up to 900 seconds per function, enough for typical APO runs in the browser.

---

## 🛠️ The Core MVP (Ranking Workflow)

- **CSV Upload & Parsing** — Drag & drop or select a CSV. PapaParse normalizes headers (lowercase, snake_case). Expects `account_name`, `lead_first_name`, `lead_last_name`, `lead_job_title`, `account_domain`, `account_employee_range`, `account_industry`.
- **Grouping by Company** — Leads are grouped by `(account_name, account_domain)`. Each company is scored as a unit so hierarchy (e.g. VP vs Director) can be inferred relative to peers.
- **AI Evaluation** — `gpt-4o-mini` ranks leads using a Chain-of-Thought JSON schema: reasoning first, then `is_disqualified` (HR filter), then `rank_score` (1–10). The persona spec defines ICP rules, company-size tiers, and hard/soft exclusions.
- **Streaming Results** — Results stream via SSE to the frontend and appear in a TanStack Table with sorting and export to CSV.

---

## 🧠 The Hard Bonus: APO Engine

Run `npm run apo` (or **Run APO** in the Prompts → Prompt Optimization tab) to optimize the system prompt against labeled eval data using OPRO (Optimization by Prompting).

### Stratified Group Split (Protecting the HR Filter)

With 777 leads across 10 companies, a naive 80/20 split can put all companies with disqualified ("-") leads in the train set. The test set would then have no DQ examples and cannot measure whether the HR filter works.

We split by company into two buckets: `withDq` (has at least one "-" lead) and `withoutDq`. Each bucket is split 80% train / 20% test, then merged. Both train and test get a representative share of DQ companies, so the hold-out set fairly evaluates the AI’s negative constraints.

**Why this mattered:** When exploring `eval_set.csv - Evaluation Set.csv`, I found that "DraftAid" had 14 leads and none were disqualified. With a standard random split, DraftAid could have contaminated the test set's representativeness, leaving too few DQ examples to properly evaluate the HR filter. Stratification not only fixes this anomaly in today's data but makes the evaluation pipeline robust to any asymmetric CSV that Data ingests in the future.

### Chunking & Concurrency

Some companies have ~300 leads. Sending them in one call would exceed `max_tokens` and risk 429 rate limits.

The evaluator slices large companies into chunks of 40 leads and merges results with `.flat()` before computing the loss. Concurrency is tuned to stay under OpenAI’s **30k tokens/min (TPM)** limit for gpt-4o-mini:

- **`CONCURRENCY=3`** (default) — max 3 companies in parallel. Override: `APO_CONCURRENCY=2` if 429.
- **`CHUNK_CONCURRENCY=2`** (default) — 2 chunks per company in parallel (faster for large companies). Override: `APO_CHUNK_CONCURRENCY=1` if 429.

> **Why:** Previously 10×2 = 20 concurrent → 429. Current defaults (3×2 = max 6) stay within 30k TPM. If rate limited: `APO_CONCURRENCY=2 APO_CHUNK_CONCURRENCY=1 npm run apo`.

**Tradeoff:** Higher concurrency = faster runs but higher risk of HTTP 429 (rate limit). When that happens, the script waits 12s and retries, which can add delay. On tier-1 OpenAI accounts (30k TPM), use conservative values (`APO_CONCURRENCY=2`, `APO_CHUNK_CONCURRENCY=1`) if you see frequent rate limits. On higher tiers, you can increase for more speed.

### APO Flow (Summary)

1. Load `eval_set.csv - Evaluation Set.csv` and `personas_spec.md` (from project root); stratified split by company.
2. Evaluate train companies (with chunking); compute loss (FP, inversions, distribution collapse).
3. Judge (gpt-4o-mini) diagnoses worst errors; Optimizer (gpt-4o-mini) rewrites the prompt.
4. Loop up to 5 iterations with early stopping when FP=0, inversions=0, variance OK.
5. Evaluate test set with best prompt; insert into Supabase `prompt_versions` (named `runned APO vN`). No auto-activation — user activates manually from Prompt Versions tab.

### Baseline vs Optimized (Phase 6)

APO inserts **two** records per run into `prompt_versions`:

- **`runned APO vN (Baseline)`** — Original `PERSONA_SYSTEM_PROMPT` evaluated on the test set. `is_active: false`.
- **`runned APO vN (Optimized)`** — The best prompt from the training loop. User activates manually from Prompt Versions tab.

This lets you compare Baseline vs Optimized metrics in the Prompt Versions tab (delta badge on Optimized cards).

### ¿Cómo funcionan Baseline y APO Optimization?

**Baseline** es el prompt **original** (`PERSONA_SYSTEM_PROMPT`): las reglas de ranking que definiste manualmente (ICP, exclusiones, matriz de seniority, etc.). No ha pasado por ninguna optimización.

**APO Optimization** es un bucle automático (OPRO) que:

1. **Divide** el eval set en train (80%) y test (20%) por empresa, preservando empresas con leads descalificados en ambos conjuntos.
2. **Evalúa** el prompt actual sobre el train: la IA puntúa cada lead y se calculan errores:
   - **FP (False Positives):** leads que deberían estar descalificados pero la IA los puntuó.
   - **Inv (Inversiones):** leads que deberían rankear mejor que otros pero la IA los puntuó peor.
   - **Collapse:** si la IA da puntuaciones muy similares a todos (poca discriminación).
3. **Judge:** un LLM analiza los peores errores y responde: “¿Qué parte del prompt confundió a la IA?”
4. **Optimizer:** otro LLM reescribe el prompt incorporando el diagnóstico del Judge.
5. **Repite** hasta 5 iteraciones o hasta que FP=0, Inv=0 y la varianza sea OK.

**Al final (Phase 6):** se evalúa tanto el **Baseline** como el **Optimized** en el mismo test set. Ambos se guardan en Supabase para que puedas comparar métricas (MAE, FP, Inv, DQ accuracy) lado a lado. El Optimized es el que ha mejorado tras el bucle; el Baseline es el que tenías al inicio.

### Evaluate Option (Single-Prompt Metrics)

Prompts created manually (e.g. **v1 Initial**) have no metrics by default. Use the **Evaluate** button in the Prompt Versions tab to:

1. Evaluate that prompt on the test set (same logic as APO Phase 6).
2. Update the record with MAE, FP, Inv, and DQ.
3. Display metrics in the card; the Evaluate button disappears once metrics exist.

**CLI equivalent:**

```bash
npx tsx scripts/apo.ts --evaluate-only=<prompt-uuid>
```

Takes ~2–5 minutes. Cost: ~$0.10–0.50 (gpt-4o-mini). Run Evaluate and Run APO **sequentially** to avoid OpenAI rate limits.

### MAE: Macro-Average by Company (Why Not Simple Lead Average?)

We compute MAE as a **macro-average across companies**, not a micro-average across all leads:

```
MAE = (1 / N_companies) × Σ MAE_company_i
     where MAE_company_i = (1 / N_leads_i) × Σ |ai_score - expected_score| for leads in company i
```

**Micro-average (what we avoid):** `MAE_micro = Σ all |error| / total_leads` — companies with many leads dominate the metric.

**Why macro is more accurate:** In our eval set, companies have very different sizes (e.g. one with ~300 leads, others with 5–20). A simple lead-weighted average would let the largest company drive the MAE. If the model ranks that one company poorly but does well on the rest, the metric would over-penalize. Macro-averaging gives **equal weight to each company**, so the MAE reflects "how well does the model rank on average per company" — which matches our use case: we score leads **within** each company and care about per-company quality, not aggregate volume.

| Approach | Company A (300 leads) | Company B (10 leads) | Company C (5 leads) | Result |
|----------|------------------------|----------------------|---------------------|--------|
| Company MAE | 2.0 | 0.5 | 1.0 | — |
| **Macro** | 1/3 weight | 1/3 weight | 1/3 weight | **(2.0 + 0.5 + 1.0) / 3 = 1.17** |
| **Micro** | 300/315 weight | 10/315 weight | 5/315 weight | ≈ **1.94** (dominated by A) |

Macro-averaging makes the representation more accurate and less dependent on companies that have a lot of leads.

### Lessons Learned: Prompt Drift & Sweet Spot

I ran APO multiple times and noticed a **"Prompt Drift"** phenomenon. When over-optimizing for small rank inversions, the model would "forget" the strict DQ rules and MAE would worsen. Because the system keeps a metric history per version, I could identify the **"Sweet Spot"** (the iteration with 100% DQ and lowest MAE), roll back to that version, and set it as the active prompt for production.

### Tradeoffs & Deferred Features (Time / Project Size)

**Model tradeoffs:**

- **Optimizer model (o1-mini vs gpt-4o-mini):** While `o1-mini` provides deeper reasoning for complex persona matching, its hidden reasoning tokens make each optimizer call 2–4× slower than `gpt-4o-mini`. With up to 5 iterations, this can add 5–15+ minutes to the full APO run. We use `gpt-4o-mini` for the optimizer to prioritize execution time.
- **Evaluation model (o1 vs gpt-4o-mini):** While `o1` provides deeper reasoning for complex persona matching, its hidden reasoning tokens would require stricter chunking and longer backoffs to avoid TPM rate limits during mass evaluation. We use `gpt-4o-mini` to stay within limits.
- **o1 for prompt rewriting (lesson learned):** I tried using `o1` for the Optimizer (prompt rewriting) and ran out of credits on the first APO run. The o1 model’s higher cost and hidden reasoning tokens consumed the budget too quickly. Switched to `gpt-4o-mini` for the full pipeline.

**Deferred features (future / scalability):** Features to support scaling across campaigns, datasets, and clients.

- **Column Mapping Layer** — Current: fixed columns. Extension: configurable mapping from arbitrary CSV columns → internal schema (e.g. `Company` → `account_name`, `First Name` → `lead_first_name`). Store mappings per dataset type or campaign.
- **Multi-Campaign / Multi-Tenant APO** — Current: single global prompt, one eval set, one persona spec. Extension: per-campaign isolation (campaign-specific eval CSV, persona, APO runs). Add `campaign_id` to `prompt_versions`. Avoids "Persona Drift".
- **Dataset Type Detection** — Current: assumes lead-scoring CSV. Extension: detect or select dataset type (Leads, Standalone contacts, Event attendees, Partners/resellers) before ingest; route to correct pipeline.
- **Flexible Grouping** — Current: group by `(account_name, account_domain)`. Extension: configurable grouping key per dataset type (single column, composite key, no grouping).
- **Persona Spec Versioning** — Current: single `personas_spec.md` at root. Extension: persona specs in DB, versioned and linked to campaigns.
- **Pluggable Model Selection** — Current: hardcoded `gpt-4o-mini` for judge/optimizer. Extension: UI toggle to select evaluation model (e.g. o1-preview, Llama-3).

| Feature | Enables |
|--------|--------|
| Column mapping | Any CSV format → same ranking pipeline |
| Multi-campaign APO | Different ICPs per client/campaign |
| Dataset type detection | Support leads, contacts, events, partners, etc. |
| Flexible grouping | Company-based, flat, or custom grouping |
| Persona versioning | Per-campaign persona and prompt evolution |

---

## 🏗️ System Architecture & Data Flow

For a deep dive into the system design and data flows, please see the full [ARCHITECTURE.md](ARCHITECTURE.md) file.

Below is a high-level summary of the core system.

### High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                             THROXY PERSONA RANKER                                 │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│   [ PRODUCTION FLOW ]                             [ LLMOps: APO FLOW ]            │
│                                                                                   │
│  ┌──────────────────┐                            ┌──────────────────┐             │
│  │ Frontend (UI)    │                            │ Local Files      │             │
│  │ - Zustand Store  │                            │ - eval_set.csv*  │             │
│  │ - TanStack Table │                            │ - personas_spec   │             │
│  └────────┬─────────┘                            └────────┬─────────┘             │
│           │ POST CSV                                      │                       │
│           ▼                                               ▼                       │
│  ┌──────────────────┐                            ┌──────────────────┐             │
│  │ Next.js API      │                            │ APO Script       │             │
│  │ - CSV Parser     │                            │ - Stratified     │             │
│  │ - Group by Acc   │                            │   Split (80/20)  │             │
│  │ - SSE Streams    │                            │ - Loss Function  │             │
│  └────┬────────┬────┘                            └────┬────────┬────┘             │
│       │        │                                      │        │                  │
│       │        └──────────────────┐  ┌────────────────┘        │                  │
│       ▼                           ▼  ▼                         ▼                  │
│  ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐         │
│  │ Supabase (DB)    │      │ OpenAI API       │      │ AI Agents (OPRO) │         │
│  │ - accounts       │◀──── │ - Chunking (20–40) │ ────▶│ - Evaluator      │         │
│  │ - leads          │      │ - Rate Limiter   │      │ - Judge          │         │
│  │ - prompt_versions│      │   (30k TPM)      │      │ - Optimizer      │         │
│  └──────────────────┘      └──────────────────┘      └──────────────────┘         │
└───────────────────────────────────────────────────────────────────────────────────┘
```

*\* eval_set.csv = `eval_set.csv - Evaluation Set.csv` (project root)*

### 1. Core Data Flows

**A. Production Ranking (Ingest Pipeline)**

- **Upload & Grouping:** CSV is parsed and leads are grouped strictly by `account_name` and `domain` to maintain corporate hierarchy context.
- **Chunking & Concurrency:** Leads are processed in chunks of 20. `p-limit` ensures we stay within OpenAI's TPM (Tokens Per Minute) limits.
- **Scoring:** The system fetches the `is_active: true` prompt from Supabase. `gpt-4o-mini` outputs a strict JSON Array with `rank_score`, `is_disqualified`, and `reasoning`.
- **Streaming:** Results are saved to Supabase and streamed back to the client via Server-Sent Events (SSE).

**B. Automatic Prompt Optimization (APO Pipeline)**

- **Stratified Split:** `eval_set.csv - Evaluation Set.csv` is split 80/20 (Train/Test), ensuring both sets get a proportional share of companies with Disqualified (DQ) leads to protect the HR filter.
- **Evaluation:** Evaluator scores the Train set.
- **Loss Function:** Calculates False Positives (HR breaches), Rank Inversions (scoring a Manager above a VP), and Distribution Collapse.
- **OPRO Loop:** Judge diagnoses errors → Optimizer rewrites the prompt → Loop repeats up to 5 iterations.
- **Generalization & Control Group:** The pipeline evaluates the original baseline prompt against the Test Set first, then evaluates the new optimized prompt. Both are saved to Supabase to prove relative ROI (Delta) mathematically.
- **Standalone Evaluation:** Manual prompts can be benchmarked via the `--evaluate-only` flag, turning the system into a full LLMOps testing ground.

### 2. Database Schema (Supabase)

Our relational PostgreSQL schema ensures data integrity and metric tracking:

- **accounts:** One entry per company (name, domain, employee_range, industry).
- **leads:** Tied to accounts (first_name, last_name, job_title).
- **rankings:** Stores the LLM output (rank_score, is_disqualified, reasoning) tied to a specific prompt version.
- **prompt_versions:** The core of the LLMOps pipeline. Stores prompt text, source (manual vs APO), and historical performance metrics (mae, dq_accuracy, test_inversions, test_false_positives). Only one row is `is_active: true` at a time.

### 3. Scalability & Future Vision

While this MVP focuses on end-to-end functionality, the architecture is designed to scale into a robust LLMOps platform:

- **Multi-Campaign APO:** Scoping evaluation sets and personas per client to prevent "Persona Drift".
- **Pluggable Model Selection:** Tiered models balancing cost/speed (gpt-4o-mini for ingest/optimization) vs. reasoning fidelity. Note: o1 models were intentionally excluded from mass evaluation to avoid catastrophic rate limits from hidden reasoning tokens.
- **Dynamic Column Mapping:** Allowing ingestion of arbitrary CSV structures.

---

## 🤖 AI Integration (Prompt Design, Cost, Relevant Info)

**Prompt design:** Structured system prompt with explicit ranking criteria (company size, department priority, seniority matrix, hard/soft exclusions). Chain-of-Thought schema forces reasoning before score. Zod enforces output shape.

**Cost awareness:** Token usage tracked in ingest (`GPT4O_MINI_INPUT/OUTPUT_COST`) and APO (`CostTracker`, `costUSD()`). Cost logged per APO iteration and at end; ingest streams `total_cost_usd` in done event. Chunking (20–40 leads) and concurrency limits keep calls within TPM.

**Relevant info only:** Per call we send only what’s needed: company name, size bucket, employee range, industry, domain, and the leads in that chunk—no cross-company leakage. Judge gets max 6 failure samples; Optimizer gets diagnosis + condensed error narratives. APO eval appends `personas_spec.md` for ground-truth alignment.

---

## 📐 Code Structure

Structure over cleverness. Reusable components (`Spinner`, `PromptDiff`), shared logic in `lib/` (`apo-version.ts` for APO parsing), and semantic domains (`app/prompts/`, `app/api/`, `components/ui/`). React best practices: proper `useEffect` deps, Zustand for shared state.

---

## 💻 Tech Stack

- **Next.js 16**, App Router, TypeScript, Tailwind CSS, shadcn/ui
- **Supabase** (Postgres) — accounts, leads, rankings, prompt_versions
- **Vercel AI SDK** — `gpt-4o-mini` for ranking, APO evaluation, judge, and optimizer (~$0.50–2 per APO run)
- **Zustand** — client state (leads, ingest, prompts, APO)
- **PapaParse** (CSV), **Zod** (structured outputs), **p-limit** (concurrency)
