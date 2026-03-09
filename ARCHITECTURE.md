# Throxy Persona Ranker — Architecture & System Overview

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           THROXY PERSONA RANKER                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Frontend   │───▶│  Next.js API │───▶│   Supabase   │◀───│  APO Script  │  │
│  │  (React/UI)  │    │   Routes     │    │  (Postgres)  │    │ (CLI/Batch)  │  │
│  └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                    │                    │                    │        │
│         │                    │                    │                    │        │
│         ▼                    ▼                    │                    ▼        │
│  ┌──────────────┐    ┌──────────────┐             │           ┌──────────────┐  │
│  │  CSV Upload  │    │  OpenAI API  │             │           │personas_spec │  │
│  │  Leads Table │    │(gpt-4o-mini) │             │           │  eval_set    │  │
│  │  Export CSV  │    │              │             │           │  leads.csv   │  │
│  └──────────────┘    └──────────────┘             │           └──────────────┘  │
│                                                    │                             │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │              Prompts Panel (Prompt Versions, APO Run, Compare)             │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Overview

| Layer | Components | Purpose |
|-------|-------------|---------|
| **Frontend** | `app/page.tsx`, `app/ranker-service.ts`, `components/csv-upload.tsx`, `leads-table.tsx`, `export-csv.tsx` | User uploads CSV, views ranked leads, exports results; Zustand stores for leads/ingest |
| **Prompts UI** | `app/prompts/` (layout, page, versions, optimization), `prompts-service.ts` | Prompt versions, APO run, compare; Zustand stores for prompts/APO |
| **API** | `api/ingest`, `api/prompts`, `api/apo/*` | Ingest, prompt CRUD, APO trigger |
| **Backend Logic** | `lib/persona-prompt.ts`, `lib/supabase.ts`, `lib/dto/`, `lib/entity/` | System prompt, DB client, DTOs, entities |
| **APO Pipeline** | `scripts/apo.ts` | Offline prompt optimization (OPRO) |
| **Data Store** | Supabase (accounts, leads, rankings, prompt_versions) | Persistence |

---

## 3. Data Flow

### 3.1 Ingest & Ranking (Production Flow)

```
CSV (leads)  ──►  CsvUpload  ──►  POST /api/ingest
                                       │
                                       ├── Parse & group by (account_name, account_domain)
                                       ├── Upsert accounts → Supabase
                                       ├── Insert leads → Supabase
                                       ├── Load active prompt from prompt_versions
                                       ├── For each company (p-limit 5):
                                       │      ├── Chunk leads (20/group)
                                       │      ├── generateObject (GPT-4o-mini) → scores
                                       │      └── Insert rankings → Supabase
                                       └── Stream progress/batch/done via SSE
                                                    │
                                                    ▼
                                              Home page updates
                                              LeadsTable, Export CSV
```

- **Input CSV** columns: `account_name`, `lead_first_name`, `lead_last_name`, `lead_job_title`, `account_domain`, `account_employee_range`, `account_industry`
- **Grouping**: One batch per unique `(account_name, account_domain)`
- **Chunking**: Ingest uses `CHUNK_SIZE=20` per LLM call; APO uses `CHUNK_SIZE=40`
- **Prompt source**: Active row in `prompt_versions` (APO or manual), else `PERSONA_SYSTEM_PROMPT` from `persona-prompt.ts`

### 3.2 APO — Automatic Prompt Optimization

```
eval_set.csv + personas_spec.md  ──►  scripts/apo.ts
                                            │
  PHASE 1: Ingestion & Split                │
  ├── Load personas_spec                     │
  ├── Load eval_set (labeled: Rank 1–10 or "-")  │
  ├── Group by company                      │
  ├── Stratified split: 80% train / 20% test  │
  │   (stratified by DQ vs non-DQ companies)│
  └── Load unlabeled sample from leads.csv  │
                                            │
  PHASE 2: Groupwise Evaluation             │
  ├── For each TRAIN company:                │
  │   └── Chunk leads (40/chunk) → evaluate with GPT-4o-mini
  └── Collect scored leads                   │
                                            │
  PHASE 3: Loss Function                    │
  ├── False Positives (HR filter breach)    │
  ├── Rank Inversions                       │
  └── Distribution Collapse (unlabeled)     │
                                            │
  PHASE 4: Judge + Optimizer                 │
  ├── Judge (gpt-4o-mini): diagnose errors   │
  └── Optimizer (gpt-4o-mini): rewrite prompt │
                                            │
  PHASE 5: Loop (up to MAX_ITERATIONS)      │
  └── Repeat 2–4 until convergence/stop    │
                                            │
  PHASE 6: Test Set Generalization           │
  ├── Evaluate TEST companies with Baseline (original prompt)
  ├── Evaluate TEST companies with best Optimized prompt
  └── Compute MAE (macro-averaged), inversions, false positives
                                            │
  Output: Baseline + Optimized → Supabase prompt_versions (2 rows)
          + lib/ai/optimized-system-prompt.txt
```

### 3.3 How Baseline and APO Optimization Work

**Baseline** is the **original** prompt (`PERSONA_SYSTEM_PROMPT`): the manual ranking rules you defined (ICP, exclusions, seniority matrix, etc.). It has not gone through any optimization.

**APO Optimization** is an automated loop (OPRO) that:

1. **Splits** the eval set into train (80%) and test (20%) by company, preserving companies with disqualified leads in both sets.
2. **Evaluates** the current prompt on the train set: the AI scores each lead and errors are calculated:
   - **FP (False Positives):** leads that should be disqualified but were scored.
   - **Inv (Inversions):** leads that should rank higher than others but were scored lower.
   - **Collapse:** if the AI gives very similar scores to everyone (poor discrimination).
3. **Judge:** an LLM analyzes the worst errors and answers: "What part of the prompt confused the AI?"
4. **Optimizer:** another LLM rewrites the prompt incorporating the Judge's diagnosis.
5. **Repeats** up to 5 iterations or until FP=0, Inv=0, and variance is OK.

**At the end (Phase 6):** both the **Baseline** and the **Optimized** prompts are evaluated on the same test set. Both are saved to Supabase so you can compare metrics (MAE, FP, Inv, DQ accuracy) side-by-side.

---

## 4. Database Schema

### 4.1 Core Tables

| Table | Purpose |
|-------|---------|
| **accounts** | One per company (name, domain, employee_range, industry) |
| **leads** | One per person, linked to account (first_name, last_name, job_title) |
| **rankings** | One per lead per run (rank_score, is_disqualified, reasoning, prompt_version, cost_usd) |
| **prompt_versions** | System prompts (manual, APO, initial) with optional MAE/inversions/FP metrics. MAE is macro-averaged (avg per company, then across companies). |

### 4.2 Relationships

```
accounts (1) ──► (N) leads
leads (1) ──► (N) rankings
prompt_versions: single active row used for ranking
```

---

## 5. APIs

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/ingest` | POST | Ingest CSV rows, upsert accounts/leads, score via LLM, stream SSE |
| `/api/prompts` | GET/POST | List prompts, set active, insert new |
| `/api/apo/run` | POST | Spawn `scripts/apo.ts`, stream logs via SSE |
| `/api/apo/compare` | GET | Baseline vs Optimized metrics + prompt diff (latest APO run) |

---

## 6. Models & Scoring

### 6.1 Persona System Prompt

- **Location**: `lib/persona-prompt.ts`
- **Content**: ICP rules (company size → ideal titles), department priority, seniority matrix, hard/soft exclusions, industry notes
- **Output**: 1–10 score per lead, or `is_disqualified: true`

### 6.2 Scoring Schema (Ingest)

- **Model**: `gpt-4o-mini`
- **Output**: `{ scored_leads: [{ index, rank_score, is_disqualified, reasoning }] }`
- **Context**: Company name, size bucket, employee range, industry, domain, lead list

### 6.3 APO Evaluator Schema

- **Model**: `gpt-4o-mini` (chosen over gpt-4o/o1 to maintain strict TPM rate limits); Judge and Optimizer also use `gpt-4o-mini`
- **Output**: `{ scored_leads: [{ lead_id, reasoning, is_disqualified, score }] }`
- **Chain-of-Thought**: Reasoning before score
- **Chunking**: Up to 40 leads per call
- **Rate limit**: Concurrency tuned to stay under 30k TPM; 12s backoff on 429

---

## 7. APO Configuration (scripts/apo.ts)

| Setting | Default | Effect |
|---------|---------|--------|
| `MAX_ITERATIONS` | 5 | OPRO loop limit |
| `TOP_WORST_COMPANIES` | 2 | Companies sent to Judge/Optimizer |
| `CONCURRENCY` | 3 (env: `APO_CONCURRENCY`) | Parallel company evaluations |
| `CHUNK_SIZE` | 40 | Max leads per evaluator call |
| `CHUNK_CONCURRENCY` | 2 (env: `APO_CHUNK_CONCURRENCY`) | Chunks per company in parallel |
| `MAX_RETRIES` | 5 | Retries per chunk (incl. rate-limit backoff) |
| `TRAIN_SPLIT` | 0.8 | 80% train, 20% test |
| `SPLIT_SEED` | 42 | Reproducible split |

**Rate limit (TPM):** OpenAI gpt-4o-mini has a 30k tokens/min limit. High concurrency (e.g. 10×2) causes bursts exceeding this → HTTP 429. Values above stay under the limit; on 429 the script waits 12s and retries.
---

## 8. File Structure

```
THROXY_CHALLENGE/
├── readme.md                         # User-facing docs
├── ARCHITECTURE.md                   # This file
├── personas_spec.md                  # ICP (used by APO + ingest)
├── eval_set.csv - Evaluation Set.csv # Labeled eval data (Rank 1–10, "-")
├── leads.csv - Sheet1.csv             # Unlabeled (optional, for collapse check)
│
└── throxy-ranker/
    ├── app/
    │   ├── page.tsx                  # Main UI: upload, leads table, export
    │   ├── layout.tsx
    │   ├── ranker-service.ts         # Zustand: leads, ingest state
    │   ├── prompts/
    │   │   ├── layout.tsx            # Prompts panel shell + tabs
    │   │   ├── page.tsx              # Prompts landing
    │   │   ├── prompts-service.ts    # Zustand: prompts, APO state
    │   │   ├── versions/page.tsx     # Prompt versions, activate, delete APO
    │   │   ├── optimization/page.tsx # Run APO, compare prompts
    │   │   └── versions/prompt-diff.tsx
    │   └── api/
    │       ├── ingest/route.ts       # CSV ingest + ranking
    │       ├── prompts/route.ts      # Prompt CRUD
    │       ├── apo/run/route.ts      # Trigger APO (SSE)
    │       └── apo/compare/route.ts  # Prompt diff
    │
    ├── components/
    │   ├── csv-upload.tsx
    │   ├── leads-table.tsx
    │   ├── export-csv.tsx
    │   └── ui/                       # shadcn/ui
    │
    ├── lib/
    │   ├── persona-prompt.ts         # Default system prompt
    │   ├── types.ts                 # Re-exports from dto/
    │   ├── supabase.ts
    │   ├── dto/                     # Data transfer objects
    │   │   ├── account-batch.ts
    │   │   ├── csv-row.ts
    │   │   ├── ingest-response.ts
    │   │   ├── prompt-version.ts
    │   │   └── ranked-lead.ts
    │   ├── entity/                  # Domain entities
    │   │   ├── account.ts
    │   │   ├── lead.ts
    │   │   └── ranking.ts
    │   └── ai/
    │       └── optimized-system-prompt.txt  # APO output (fallback)
    │
    ├── scripts/
    │   ├── apo.ts                   # APO pipeline (OPRO)
    │   └── rename-apo-versions.ts   # Utility for APO version naming
    │
    └── supabase/migrations/
        ├── 001_initial_schema.sql
        ├── 002_prompt_versions.sql
        ├── 003_apo_metrics.sql
        └── 004_rename_apo_versions.sql
```

---

## 9. End-to-End User Journeys

### Journey 1: Rank Leads

1. User uploads CSV on Home page.
2. `CsvUpload` parses rows → POST `/api/ingest`.
3. Ingest groups by company, upserts accounts/leads, fetches active prompt.
4. For each company, chunks leads and calls GPT-4o-mini; inserts rankings.
5. SSE streams progress and batches; UI updates `LeadsTable`.
6. User exports ranked CSV.

### Journey 2: Optimize Prompt (APO)

1. User opens Prompts → Prompt Optimization tab.
2. Clicks **Run APO** → POST `/api/apo/run`.
3. API spawns `npx tsx scripts/apo.ts`; streams logs and progress via SSE.
4. APO loads eval_set + personas_spec, stratified split, trains for up to `MAX_ITERATIONS`.
5. Baseline + Optimized prompts → Supabase `prompt_versions` (2 rows), `lib/ai/optimized-system-prompt.txt`.
6. User activates new prompt in Prompt Versions tab.

### Journey 3: Use Optimized Prompt for Ranking

1. User activates APO prompt in Prompt Versions.
2. User uploads CSV; ingest loads active prompt from Supabase.
3. Ranking uses the optimized prompt instead of default.