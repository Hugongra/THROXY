import { NextResponse } from "next/server";
import { buildApoRunPairs } from "@/lib/apo-version";
import { PERSONA_SYSTEM_PROMPT } from "@/lib/persona-prompt";
import { getSupabase } from "@/lib/supabase";

/** Returns Original (baseline) and Optimized = exactly what ranking uses (active prompt or default).
 * Also returns latest APO run metrics (Baseline vs Optimized) for UI comparison. */
export async function GET() {
  let optimized = PERSONA_SYSTEM_PROMPT;
  let latestApoRun: {
    baseline: { mae: number; testFp: number; testInv: number; dqAccuracy: number | null; prompt_text: string };
    optimized: { mae: number; testFp: number; testInv: number; dqAccuracy: number | null; prompt_text: string };
    versionBase: string;
  } | null = null;

  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("prompt_versions")
      .select("prompt_text")
      .eq("is_active", true)
      .maybeSingle();
    if (data?.prompt_text) {
      optimized = data.prompt_text as string;
    }

    // Fetch latest APO run (Baseline + Optimized pair)
    const { data: apoVersions } = await supabase
      .from("prompt_versions")
      .select("version, mae, dq_accuracy, test_inversions, test_false_positives, prompt_text")
      .eq("source", "apo")
      .like("version", "runned APO v%")
      .order("created_at", { ascending: false });

    if (apoVersions?.length) {
      const versionToRun = buildApoRunPairs(apoVersions);
      const runs = [...versionToRun.entries()].filter(([, v]) => v.baseline && v.optimized);
      const latest = runs.sort((a, b) => b[0] - a[0])[0];
      if (latest) {
        const [, pair] = latest;
        latestApoRun = {
          versionBase: `runned APO v${latest[0]}`,
          baseline: {
            mae: Number(pair.baseline!.mae ?? 0),
            testFp: Number(pair.baseline!.test_false_positives ?? 0),
            testInv: Number(pair.baseline!.test_inversions ?? 0),
            dqAccuracy: pair.baseline!.dq_accuracy != null ? Number(pair.baseline!.dq_accuracy) : null,
            prompt_text: (pair.baseline!.prompt_text as string) ?? "",
          },
          optimized: {
            mae: Number(pair.optimized!.mae ?? 0),
            testFp: Number(pair.optimized!.test_false_positives ?? 0),
            testInv: Number(pair.optimized!.test_inversions ?? 0),
            dqAccuracy: pair.optimized!.dq_accuracy != null ? Number(pair.optimized!.dq_accuracy) : null,
            prompt_text: (pair.optimized!.prompt_text as string) ?? "",
          },
        };
      }
    }
  } catch {
    // Table missing or no active — use default (same as ingest)
  }

  return NextResponse.json({
    original: PERSONA_SYSTEM_PROMPT,
    optimized: optimized || null,
    latestApoRun,
  });
}
