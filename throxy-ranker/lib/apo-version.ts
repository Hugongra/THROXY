/**
 * Parse APO version strings like "runned APO v1 (Baseline)" or "runned APO v1 (Optimized)".
 * Returns { runNumber, role } or null if not an APO pair version.
 */
export function parseApoVersion(version: string): { runNumber: number; role: "Baseline" | "Optimized" } | null {
  const m = version?.match(/runned APO v(\d+)\s*\((Baseline|Optimized)\)/);
  if (!m) return null;
  return { runNumber: parseInt(m[1], 10), role: m[2] as "Baseline" | "Optimized" };
}

/** Build a map of run number -> { baseline?, optimized? } from prompt list. */
export function buildApoRunPairs<T extends { version?: string | null }>(
  prompts: T[]
): Map<number, { baseline?: T; optimized?: T }> {
  const pairs = new Map<number, { baseline?: T; optimized?: T }>();
  for (const p of prompts) {
    const parsed = parseApoVersion(p.version ?? "");
    if (!parsed) continue;
    const entry = pairs.get(parsed.runNumber) ?? {};
    if (parsed.role === "Baseline") entry.baseline = p;
    else entry.optimized = p;
    pairs.set(parsed.runNumber, entry);
  }
  return pairs;
}
