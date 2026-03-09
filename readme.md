# Throxy Persona Ranker

MVP de cualificación de leads B2B que puntúa leads comerciales frente a un Perfil de Cliente Ideal (ICP). Sube un CSV, obtén leads puntuados y descalificados en tiempo real por streaming. Incluye Optimización Automática de Prompts (APO) para mejorar el prompt de ranking a partir de datos etiquetados.

## 🎬 Demo

https://github.com/user-attachments/assets/30c6e4d6-fd52-4437-bd29-b5d9f65b1380

## 🚀 Inicio Rápido

```bash
git clone https://github.com/Hugongra/THROXY.git
cd THROXY/throxy-ranker
npm install
```

Crea `.env.local` en `throxy-ranker`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENAI_API_KEY=your-openai-api-key
```

Coloca `eval_set.csv - Evaluation Set.csv` y `personas_spec.md` en la raíz del proyecto (carpeta padre de `throxy-ranker`) para APO. Ejecuta las migraciones de Supabase (ver `supabase/migrations/`), luego:

```bash
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000).

---

## ☁️ Despliegue en Vercel

### Configuración

1. **Root Directory:** En Configuración del Proyecto Vercel → General, establece **Root Directory** en `throxy-ranker`.
2. **Variables de entorno:** Añade `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `OPENAI_API_KEY`.

### Timeout de la función APO (Hobby vs Pro)

La función **Run APO** usa una función serverless que puede ejecutarse varios minutos. Vercel limita el tiempo de ejecución según el plan:

| Plan | Duración máx. | APO en navegador |
|------|---------------|-------------------|
| **Hobby** (gratis) | 300 seg (5 min) | Puede hacer timeout en eval sets grandes |
| **Pro** | 900 seg (15 min) | Ejecuciones APO completas soportadas |

- **Hobby:** La ruta `api/apo/run` está limitada a 300 segundos. Si APO hace timeout, ejecútalo en local: `npm run apo` en `throxy-ranker` (sin límite).
- **Pro:** Cuesta **20$/usuario/mes** ([vercel.com/pricing](https://vercel.com/pricing)). Permite hasta 900 segundos por función, suficiente para ejecuciones APO típicas en el navegador.

---

## 🛠️ El MVP principal (Flujo de Ranking)

- **Subida y parseo de CSV** — Arrastra y suelta o selecciona un CSV. PapaParse normaliza las cabeceras (minúsculas, snake_case). Espera `account_name`, `lead_first_name`, `lead_last_name`, `lead_job_title`, `account_domain`, `account_employee_range`, `account_industry`.
- **Agrupación por empresa** — Los leads se agrupan por `(account_name, account_domain)`. Cada empresa se puntúa como unidad para inferir jerarquía (ej. VP vs Director) respecto a sus pares.
- **Evaluación con IA** — `gpt-4o-mini` puntúa leads usando un esquema JSON Chain-of-Thought: razonamiento primero, luego `is_disqualified` (filtro RRHH), luego `rank_score` (1–10). La spec de persona define reglas ICP, rangos de tamaño de empresa y exclusiones duras/blandas.
- **Resultados en streaming** — Los resultados se transmiten vía SSE al frontend y aparecen en una TanStack Table con ordenación y exportación a CSV.

---

## 🧠 El bonus difícil: Motor APO

Ejecuta `npm run apo` (o **Run APO** en Prompts → pestaña Optimización de Prompts) para optimizar el system prompt contra datos de evaluación etiquetados usando OPRO (Optimization by Prompting).

### División estratificada por grupo (Protegiendo el filtro RRHH)

Con 777 leads en 10 empresas, una división 80/20 ingenua puede dejar todas las empresas con leads descalificados ("-") en el train set. El test set no tendría ejemplos DQ y no podría medir si el filtro RRHH funciona.

Dividimos por empresa en dos cubos: `withDq` (tiene al menos un lead "-") y `withoutDq`. Cada cubo se divide 80% train / 20% test, luego se fusionan. Tanto train como test reciben una cuota representativa de empresas DQ, así el hold-out evalúa justamente las restricciones negativas de la IA.

**Por qué importó:** Al explorar `eval_set.csv - Evaluation Set.csv`, encontré que "DraftAid" tenía 14 leads y ninguno descalificado. Con una división aleatoria estándar, DraftAid podría haber contaminado la representatividad del test set, dejando pocos ejemplos DQ para evaluar bien el filtro RRHH. La estratificación no solo corrige esta anomalía en los datos actuales sino que hace el pipeline de evaluación robusto ante cualquier CSV asimétrico que Data ingiera en el futuro.

### Chunking y concurrencia

Algunas empresas tienen ~300 leads. Enviarlos en una sola llamada superaría `max_tokens` y arriesgaría rate limits 429.

El evaluador divide empresas grandes en chunks de 40 leads y fusiona resultados con `.flat()` antes de calcular la pérdida. La concurrencia se ajusta para mantenerse bajo el límite **30k tokens/min (TPM)** de OpenAI para gpt-4o-mini:

- **`CONCURRENCY=3`** (por defecto) — máx. 3 empresas en paralelo. Override: `APO_CONCURRENCY=2` si 429.
- **`CHUNK_CONCURRENCY=2`** (por defecto) — 2 chunks por empresa en paralelo (más rápido para empresas grandes). Override: `APO_CHUNK_CONCURRENCY=1` si 429.

> **Por qué:** Antes 10×2 = 20 concurrentes → 429. Los valores actuales (3×2 = máx. 6) se mantienen dentro de 30k TPM. Si hay rate limit: `APO_CONCURRENCY=2 APO_CHUNK_CONCURRENCY=1 npm run apo`.

**Tradeoff:** Más concurrencia = ejecuciones más rápidas pero mayor riesgo de HTTP 429 (rate limit). Cuando ocurre, el script espera 12s y reintenta. En cuentas OpenAI tier-1 (30k TPM), usa valores conservadores (`APO_CONCURRENCY=2`, `APO_CHUNK_CONCURRENCY=1`) si ves rate limits frecuentes. En tiers superiores, puedes subir para más velocidad.

### Flujo APO (resumen)

1. Cargar `eval_set.csv - Evaluation Set.csv` y `personas_spec.md` (desde raíz del proyecto); división estratificada por empresa.
2. Evaluar empresas de train (con chunking); calcular pérdida (FP, inversiones, colapso de distribución).
3. Judge (gpt-4o-mini) diagnostica peores errores; Optimizer (gpt-4o-mini) reescribe el prompt.
4. Bucle hasta 5 iteraciones con early stopping cuando FP=0, inversiones=0, varianza OK.
5. Evaluar test set con el mejor prompt; insertar en Supabase `prompt_versions` (nombre `runned APO vN`). Sin auto-activación — el usuario activa manualmente desde la pestaña Versiones de Prompts.

### Baseline vs Optimized (Phase 6)

APO inserta **dos** registros por ejecución en `prompt_versions`:

- **`runned APO vN (Baseline)`** — `PERSONA_SYSTEM_PROMPT` original evaluado en el test set. `is_active: false`.
- **`runned APO vN (Optimized)`** — El mejor prompt del bucle de entrenamiento. El usuario activa manualmente desde la pestaña Versiones de Prompts.

Esto permite comparar métricas Baseline vs Optimized en la pestaña Versiones de Prompts (badge delta en las tarjetas Optimized).

### ¿Cómo funcionan Baseline y APO Optimization?

**Baseline** es el prompt **original** (`PERSONA_SYSTEM_PROMPT`): las reglas de ranking que definiste manualmente (ICP, exclusiones, matriz de seniority, etc.). No ha pasado por ninguna optimización.

**APO Optimization** es un bucle automático (OPRO) que:

1. **Divide** el eval set en train (80%) y test (20%) por empresa, preservando empresas con leads descalificados en ambos conjuntos.
2. **Evalúa** el prompt actual sobre el train: la IA puntúa cada lead y se calculan errores:
   - **FP (False Positives):** leads que deberían estar descalificados pero la IA los puntuó.
   - **Inv (Inversiones):** leads que deberían rankear mejor que otros pero la IA los puntuó peor.
   - **Collapse:** si la IA da puntuaciones muy similares a todos (poca discriminación).
3. **Judge:** un LLM analiza los peores errores y responde: "¿Qué parte del prompt confundió a la IA?"
4. **Optimizer:** otro LLM reescribe el prompt incorporando el diagnóstico del Judge.
5. **Repite** hasta 5 iteraciones o hasta que FP=0, Inv=0 y la varianza sea OK.

**Al final (Phase 6):** se evalúa tanto el **Baseline** como el **Optimized** en el mismo test set. Ambos se guardan en Supabase para que puedas comparar métricas (MAE, FP, Inv, DQ accuracy) lado a lado. El Optimized es el que ha mejorado tras el bucle; el Baseline es el que tenías al inicio.

### Opción Evaluate (métricas de un solo prompt)

Los prompts creados manualmente (ej. **v1 Initial**) no tienen métricas por defecto. Usa el botón **Evaluate** en la pestaña Versiones de Prompts para:

1. Evaluar ese prompt en el test set (misma lógica que APO Phase 6).
2. Actualizar el registro con MAE, FP, Inv y DQ.
3. Mostrar métricas en la tarjeta; el botón Evaluate desaparece cuando ya existen métricas.

**Equivalente CLI:**

```bash
npx tsx scripts/apo.ts --evaluate-only=<prompt-uuid>
```

Tarda ~2–5 minutos. Coste: ~0,10–0,50$ (gpt-4o-mini). Ejecuta Evaluate y Run APO **secuencialmente** para evitar rate limits de OpenAI.

### MAE: Promedio macro por empresa (¿Por qué no el promedio simple de leads?)

Calculamos el MAE como **promedio macro entre empresas**, no como micro-promedio entre todos los leads:

```
MAE = (1 / N_companies) × Σ MAE_company_i
     donde MAE_company_i = (1 / N_leads_i) × Σ |ai_score - expected_score| para leads en empresa i
```

**Micro-promedio (lo que evitamos):** `MAE_micro = Σ todos |error| / total_leads` — las empresas con muchos leads dominan la métrica.

**Por qué el macro es más preciso:** En nuestro eval set, las empresas tienen tamaños muy distintos (ej. una con ~300 leads, otras con 5–20). Un promedio ponderado por leads dejaría que la empresa más grande dominara el MAE. Si el modelo rankea mal esa empresa pero bien el resto, la métrica penalizaría de más. El macro-promedio da **peso igual a cada empresa**, así el MAE refleja "qué bien rankea el modelo de media por empresa" — que encaja con nuestro caso: puntuamos leads **dentro** de cada empresa y nos importa la calidad por empresa, no el volumen agregado.

| Enfoque | Empresa A (300 leads) | Empresa B (10 leads) | Empresa C (5 leads) | Resultado |
|---------|------------------------|----------------------|---------------------|-----------|
| MAE empresa | 2,0 | 0,5 | 1,0 | — |
| **Macro** | peso 1/3 | peso 1/3 | peso 1/3 | **(2,0 + 0,5 + 1,0) / 3 = 1,17** |
| **Micro** | peso 300/315 | peso 10/315 | peso 5/315 | ≈ **1,94** (dominado por A) |

El macro-promedio hace la representación más fiel y menos dependiente de empresas con muchos leads.

### Lecciones aprendidas: Prompt Drift y Sweet Spot

Ejecuté APO varias veces y observé el fenómeno **"Prompt Drift"**. Al sobre-optimizar para pequeñas inversiones de ranking, el modelo "olvidaba" las reglas DQ estrictas y el MAE empeoraba. Como el sistema mantiene historial de métricas por versión, pude identificar el **"Sweet Spot"** (la iteración con 100% DQ y menor MAE), volver a esa versión y establecerla como prompt activo para producción.

### Tradeoffs y funciones diferidas (tiempo / tamaño del proyecto)

**Tradeoffs de modelos:**

- **Modelo Optimizer (o1-mini vs gpt-4o-mini):** Aunque `o1-mini` ofrece razonamiento más profundo para matching de personas complejo, sus tokens de razonamiento ocultos hacen cada llamada al optimizer 2–4× más lenta que `gpt-4o-mini`. Con hasta 5 iteraciones, puede añadir 5–15+ minutos a la ejecución APO completa. Usamos `gpt-4o-mini` para el optimizer para priorizar tiempo de ejecución.
- **Modelo de evaluación (o1 vs gpt-4o-mini):** Aunque `o1` ofrece razonamiento más profundo para matching de personas complejo, sus tokens ocultos exigirían chunking más estricto y backoffs más largos para evitar rate limits TPM durante la evaluación masiva. Usamos `gpt-4o-mini` para mantenernos dentro de límites.
- **o1 para reescritura de prompts (lección aprendida):** Probé usar `o1` para el Optimizer (reescritura de prompts) y se acabaron los créditos en la primera ejecución APO. El mayor coste del modelo o1 y sus tokens de razonamiento ocultos consumieron el presupuesto demasiado rápido. Cambié a `gpt-4o-mini` para todo el pipeline.

**Funciones diferidas (futuro / escalabilidad):** Funciones para escalar entre campañas, datasets y clientes.

- **Capa de mapeo de columnas** — Actual: columnas fijas. Extensión: mapeo configurable de columnas CSV arbitrarias → esquema interno (ej. `Company` → `account_name`, `First Name` → `lead_first_name`). Guardar mapeos por tipo de dataset o campaña.
- **APO multi-campaña / multi-tenant** — Actual: un solo prompt global, un eval set, una persona spec. Extensión: aislamiento por campaña (CSV eval, persona y ejecuciones APO específicos por campaña). Añadir `campaign_id` a `prompt_versions`. Evita "Persona Drift".
- **Detección de tipo de dataset** — Actual: asume CSV de puntuación de leads. Extensión: detectar o seleccionar tipo de dataset (Leads, Contactos standalone, Asistentes a eventos, Partners/resellers) antes del ingest; encaminar al pipeline correcto.
- **Agrupación flexible** — Actual: agrupar por `(account_name, account_domain)`. Extensión: clave de agrupación configurable por tipo de dataset (columna única, clave compuesta, sin agrupación).
- **Versionado de Persona Spec** — Actual: un solo `personas_spec.md` en raíz. Extensión: specs de persona en BD, versionados y vinculados a campañas.
- **Selección de modelo pluggable** — Actual: `gpt-4o-mini` hardcodeado para judge/optimizer. Extensión: toggle en UI para seleccionar modelo de evaluación (ej. o1-preview, Llama-3).

| Función | Habilita |
|---------|----------|
| Mapeo de columnas | Cualquier formato CSV → mismo pipeline de ranking |
| APO multi-campaña | ICPs distintos por cliente/campaña |
| Detección de tipo de dataset | Soporte leads, contactos, eventos, partners, etc. |
| Agrupación flexible | Por empresa, plana o agrupación personalizada |
| Versionado de persona | Persona y evolución de prompt por campaña |

---

## 🏗️ Arquitectura del sistema y flujo de datos

Para un análisis detallado del diseño del sistema y los flujos de datos, consulta el archivo completo [ARCHITECTURE.md](ARCHITECTURE.md).

A continuación un resumen de alto nivel del sistema.

### Arquitectura de alto nivel

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                             THROXY PERSONA RANKER                                 │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│   [ FLUJO PRODUCCIÓN ]                             [ LLMOps: FLUJO APO ]          │
│                                                                                   │
│  ┌──────────────────┐                            ┌──────────────────┐             │
│  │ Frontend (UI)    │                            │ Archivos locales  │             │
│  │ - Zustand Store  │                            │ - eval_set.csv*  │             │
│  │ - TanStack Table │                            │ - personas_spec   │             │
│  └────────┬─────────┘                            └────────┬─────────┘             │
│           │ POST CSV                                      │                       │
│           ▼                                               ▼                       │
│  ┌──────────────────┐                            ┌──────────────────┐             │
│  │ Next.js API      │                            │ Script APO       │             │
│  │ - CSV Parser     │                            │ - División estr.  │             │
│  │ - Group by Acc   │                            │   (80/20)        │             │
│  │ - SSE Streams    │                            │ - Función pérdida│             │
│  └────┬────────┬────┘                            └────┬────────┬────┘             │
│       │        │                                      │        │                  │
│       │        └──────────────────┐  ┌────────────────┘        │                  │
│       ▼                           ▼  ▼                         ▼                  │
│  ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐         │
│  │ Supabase (DB)    │      │ OpenAI API       │      │ Agentes IA (OPRO)│         │
│  │ - accounts       │◀──── │ - Chunking (20–40) │ ────▶│ - Evaluator      │         │
│  │ - leads          │      │ - Rate Limiter   │      │ - Judge          │         │
│  │ - prompt_versions│      │   (30k TPM)      │      │ - Optimizer      │         │
│  └──────────────────┘      └──────────────────┘      └──────────────────┘         │
└───────────────────────────────────────────────────────────────────────────────────┘
```

*\* eval_set.csv = `eval_set.csv - Evaluation Set.csv` (raíz del proyecto)*

### 1. Flujos de datos principales

**A. Ranking en producción (Pipeline de ingest)**

- **Subida y agrupación:** El CSV se parsea y los leads se agrupan estrictamente por `account_name` y `domain` para mantener el contexto de jerarquía corporativa.
- **Chunking y concurrencia:** Los leads se procesan en chunks de 20. `p-limit` asegura que nos mantenemos dentro de los límites TPM (Tokens Por Minuto) de OpenAI.
- **Puntuación:** El sistema obtiene el prompt `is_active: true` de Supabase. `gpt-4o-mini` devuelve un JSON Array estricto con `rank_score`, `is_disqualified` y `reasoning`.
- **Streaming:** Los resultados se guardan en Supabase y se transmiten al cliente vía Server-Sent Events (SSE).

**B. Optimización automática de prompts (Pipeline APO)**

- **División estratificada:** `eval_set.csv - Evaluation Set.csv` se divide 80/20 (Train/Test), asegurando que ambos conjuntos reciban una cuota proporcional de empresas con leads Descalificados (DQ) para proteger el filtro RRHH.
- **Evaluación:** El Evaluator puntúa el conjunto Train.
- **Función de pérdida:** Calcula False Positives (incumplimientos filtro RRHH), Inversiones de ranking (puntuar un Manager por encima de un VP) y Colapso de distribución.
- **Bucle OPRO:** Judge diagnostica errores → Optimizer reescribe el prompt → El bucle se repite hasta 5 iteraciones.
- **Generalización y grupo de control:** El pipeline evalúa primero el prompt baseline original contra el Test Set, luego evalúa el nuevo prompt optimizado. Ambos se guardan en Supabase para demostrar el ROI relativo (Delta) matemáticamente.
- **Evaluación standalone:** Los prompts manuales pueden evaluarse vía el flag `--evaluate-only`, convirtiendo el sistema en un banco de pruebas LLMOps completo.

### 2. Esquema de base de datos (Supabase)

Nuestro esquema PostgreSQL relacional asegura integridad de datos y seguimiento de métricas:

- **accounts:** Una entrada por empresa (name, domain, employee_range, industry).
- **leads:** Vinculados a accounts (first_name, last_name, job_title).
- **rankings:** Almacena la salida del LLM (rank_score, is_disqualified, reasoning) vinculada a una versión de prompt concreta.
- **prompt_versions:** El núcleo del pipeline LLMOps. Almacena texto del prompt, origen (manual vs APO) y métricas históricas de rendimiento (mae, dq_accuracy, test_inversions, test_false_positives). Solo una fila tiene `is_active: true` a la vez.

### 3. Escalabilidad y visión futura

Aunque este MVP se centra en la funcionalidad end-to-end, la arquitectura está pensada para escalar hacia una plataforma LLMOps robusta:

- **APO multi-campaña:** Definir eval sets y personas por cliente para evitar "Persona Drift".
- **Selección de modelo pluggable:** Modelos por niveles equilibrando coste/velocidad (gpt-4o-mini para ingest/optimización) vs fidelidad de razonamiento. Nota: los modelos o1 se excluyeron intencionadamente de la evaluación masiva para evitar rate limits catastróficos por tokens de razonamiento ocultos.
- **Mapeo dinámico de columnas:** Permitir ingest de estructuras CSV arbitrarias.

---

## 🤖 Integración IA (diseño de prompts, coste, info relevante)

**Diseño de prompts:** System prompt estructurado con criterios explícitos de ranking (tamaño de empresa, prioridad de departamento, matriz de seniority, exclusiones duras/blandas). El esquema Chain-of-Thought obliga a razonar antes de puntuar. Zod impone la forma de salida.

**Conciencia de coste:** Uso de tokens rastreado en ingest (`GPT4O_MINI_INPUT/OUTPUT_COST`) y APO (`CostTracker`, `costUSD()`). Coste registrado por iteración APO y al final; el ingest transmite `total_cost_usd` en el evento done. Chunking (20–40 leads) y límites de concurrencia mantienen las llamadas dentro del TPM.

**Solo info relevante:** Por llamada enviamos solo lo necesario: nombre de empresa, bucket de tamaño, rango de empleados, industria, dominio y los leads de ese chunk—sin fugas entre empresas. El Judge recibe máx. 6 muestras de fallo; el Optimizer recibe diagnóstico + narrativas de error condensadas. La eval APO añade `personas_spec.md` para alineación con ground-truth.

---

## 📐 Estructura del código

Estructura sobre ingenio. Componentes reutilizables (`Spinner`, `PromptDiff`), lógica compartida en `lib/` (`apo-version.ts` para parsing APO) y dominios semánticos (`app/prompts/`, `app/api/`, `components/ui/`). Buenas prácticas React: dependencias correctas en `useEffect`, Zustand para estado compartido.

---

## 💻 Stack tecnológico

- **Next.js 16**, App Router, TypeScript, Tailwind CSS, shadcn/ui
- **Supabase** (Postgres) — accounts, leads, rankings, prompt_versions
- **Vercel AI SDK** — `gpt-4o-mini` para ranking, evaluación APO, judge y optimizer (~0,50–2$ por ejecución APO)
- **Zustand** — estado cliente (leads, ingest, prompts, APO)
- **PapaParse** (CSV), **Zod** (salidas estructuradas), **p-limit** (concurrencia)
