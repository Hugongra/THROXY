/**
 * Renames apo-* prompt versions to runned APO v1, v2, ... (by created_at)
 * Run: npx tsx scripts/rename-apo-versions.ts
 */
import * as path from "path";
import * as dotenv from "dotenv";
import { getSupabase } from "../lib/supabase";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

async function main() {
  const supabase = getSupabase();

  const { data: rows, error } = await supabase
    .from("prompt_versions")
    .select("id, version")
    .eq("source", "apo")
    .like("version", "apo-%")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Failed to fetch:", error.message);
    process.exit(1);
  }
  if (!rows?.length) {
    console.log("No apo-* versions found. Nothing to rename.");
    return;
  }

  console.log(`Found ${rows.length} version(s) to rename:`);
  for (let i = 0; i < rows.length; i++) {
    const newVersion = `runned APO v${i + 1}`;
    const tempVersion = `__migrate_${rows[i].id}`;
    const { error: upd1 } = await supabase
      .from("prompt_versions")
      .update({ version: tempVersion })
      .eq("id", rows[i].id);
    if (upd1) {
      console.error(`  Failed to rename ${rows[i].version}:`, upd1.message);
      continue;
    }
    const { error: upd2 } = await supabase
      .from("prompt_versions")
      .update({ version: newVersion })
      .eq("id", rows[i].id);
    if (upd2) {
      console.error(`  Failed final rename for ${rows[i].version}:`, upd2.message);
    } else {
      console.log(`  ${rows[i].version} → ${newVersion}`);
    }
  }
  console.log("Done.");
}

main();
