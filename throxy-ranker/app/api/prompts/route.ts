import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export async function GET() {
  const { data, error } = await getSupabase()
    .from("prompt_versions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ prompts: data });
}

export async function POST(request: NextRequest) {
  const { action, id, version, prompt_text } = await request.json();

  if (action === "activate") {
    // Deactivate all, then activate the selected one
    await getSupabase()
      .from("prompt_versions")
      .update({ is_active: false })
      .neq("id", "00000000-0000-0000-0000-000000000000");

    const { error } = await getSupabase()
      .from("prompt_versions")
      .update({ is_active: true })
      .eq("id", id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  }

  if (action === "create") {
    const { data, error } = await getSupabase()
      .from("prompt_versions")
      .insert({
        version,
        prompt_text,
        source: "manual",
        is_active: false,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ prompt: data });
  }

  if (action === "deactivate_all") {
    await getSupabase()
      .from("prompt_versions")
      .update({ is_active: false })
      .neq("id", "00000000-0000-0000-0000-000000000000");

    return NextResponse.json({ success: true });
  }

  if (action === "evaluate") {
    if (!id) {
      return NextResponse.json({ error: "Missing prompt id" }, { status: 400 });
    }
    const { spawn } = await import("child_process");
    const projectRoot = process.cwd();
    const child = spawn("npx", ["tsx", "scripts/apo.ts", `--evaluate-only=${id}`], {
      cwd: projectRoot,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code !== 0) {
        console.error("evaluate-prompt failed:", stderr);
      }
    });
    return NextResponse.json({ success: true, message: "Evaluation started. Refresh in a few minutes." });
  }

  if (action === "delete_apo_versions") {
    const { error } = await getSupabase()
      .from("prompt_versions")
      .delete()
      .eq("source", "apo")
      .like("version", "runned APO v%");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await getSupabase()
      .from("prompt_versions")
      .update({ is_active: false })
      .neq("id", "00000000-0000-0000-0000-000000000000");

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
