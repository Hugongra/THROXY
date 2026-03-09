import { spawn } from "child_process";
import path from "path";

export const maxDuration = 300; // 5 min max (Vercel Hobby limit)

export async function POST() {
  const encoder = new TextEncoder();
  const projectRoot = process.cwd();
  const scriptPath = path.join(projectRoot, "scripts", "apo.ts");

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const safeClose = (payload?: { type: string; [k: string]: unknown }) => {
        if (closed) return;
        closed = true;
        try {
          if (payload) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            );
          }
          controller.close();
        } catch {
          // Controller already closed (e.g. client disconnected)
        }
      };

      const push = (data: string) => {
        if (closed || !data) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "log", text: data })}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      const pushProgress = (percent: number, label: string) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "progress", percent, label })}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      // Use shell so npx resolves on Windows (npx.cmd) and PATH is respected
      const proc = spawn(`npx tsx "${scriptPath}"`, [], {
        cwd: projectRoot,
        env: { ...process.env, FORCE_COLOR: "0", NODE_OPTIONS: "--no-warnings" },
        shell: true,
      });

      let lastOutput = Date.now();
      let lineBuffer = "";
      const processChunk = (chunk: Buffer) => {
        lastOutput = Date.now();
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("__APO_PROGRESS__")) {
            try {
              const json = line.slice("__APO_PROGRESS__".length);
              const { percent, label } = JSON.parse(json);
              pushProgress(percent, label ?? "");
            } catch {
              push(line);
            }
          } else if (line.trim()) {
            push(line);
          }
        }
      };
      proc.stdout?.on("data", processChunk);
      proc.stderr?.on("data", processChunk);

      // Heartbeat: at most 1 per minute when quiet (prevents "stuck" UX without spam)
      let heartbeatCount = 0;
      const heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          return;
        }
        const silent = Date.now() - lastOutput > 30000;
        if (silent && proc.exitCode == null && heartbeatCount < 2) {
          heartbeatCount++;
          push("  … still running …");
        }
      }, 60000);

      proc.on("close", (code) => {
        clearInterval(heartbeat);
        safeClose({ type: "done", code });
      });
      proc.on("error", (err) => {
        clearInterval(heartbeat);
        safeClose({ type: "error", message: err.message });
      });
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
