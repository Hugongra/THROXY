"use client";

import { useEffect, useState } from "react";
import { usePromptsStore } from "@/app/prompts/prompts-service";
import { buildApoRunPairs, parseApoVersion } from "@/lib/apo-version";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { PromptDiff } from "./prompt-diff";

function sourceBadge(source: string) {
  switch (source) {
    case "apo":
      return <Badge className="bg-purple-600 text-white">APO</Badge>;
    case "initial":
      return <Badge variant="secondary">Initial</Badge>;
    case "manual":
      return <Badge variant="outline">Manual</Badge>;
    default:
      return <Badge variant="outline">{source}</Badge>;
  }
}

export default function PromptsVersionsPage() {
  
  const prompts = usePromptsStore((s) => s.prompts);
  const promptsLoading = usePromptsStore((s) => s.loading);
  const promptsLoaded = usePromptsStore((s) => s.loaded);
  
  const activatePrompt = usePromptsStore((s) => s.activatePrompt);
  const deactivateAll = usePromptsStore((s) => s.deactivateAll);
  const deleteApoVersionsAndReset = usePromptsStore((s) => s.deleteApoVersionsAndReset);
  const evaluatePrompt = usePromptsStore((s) => s.evaluatePrompt);
  const fetchPrompts = usePromptsStore((s) => s.fetchPrompts);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  
  useEffect(() => {
    if (!promptsLoaded) {
      fetchPrompts();
    }
  }, [promptsLoaded, fetchPrompts]);

  return(
    <div className="space-y-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Click a prompt to expand it. Activate a prompt to use it for the next ranking run.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={deactivateAll}>
            Reset to Default
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm("Delete all APO versions and reset to default? This cannot be undone.")) {
                deleteApoVersionsAndReset();
              }
            }}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Delete all APO & reset
          </Button>
        </div>
      </div>
      {promptsLoading ? (
        <div className="flex justify-center py-12">
          <Spinner size="md" />
        </div>
      ) : prompts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No prompt versions found. Run <code className="rounded bg-muted px-1.5 py-0.5 text-sm">npm run apo</code> to generate optimized prompts.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(() => {
            const sorted = [...prompts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
            const runPairs = buildApoRunPairs(prompts);
            return sorted.map((p, idx, arr) => {
              const prev = idx < arr.length - 1 ? arr[idx + 1] : null;
              const parsed = parseApoVersion(p.version ?? "");
              const pair = parsed?.role === "Optimized" ? runPairs.get(parsed.runNumber) : null;
              const baselineMae = pair?.baseline?.mae != null ? Number(pair.baseline.mae) : null;
              const optimizedMae = p.mae != null ? Number(p.mae) : null;
              const deltaPct = baselineMae != null && baselineMae > 0 && optimizedMae != null
                ? ((baselineMae - optimizedMae) / baselineMae) * 100
                : null;
              return (
                <Card
                  key={p.id}
                  className={`transition-colors ${p.is_active ? "border-primary bg-primary/5" : ""}`}
                >
                  <CardHeader
                    className="cursor-pointer pb-3"
                    onClick={() =>
                      setExpandedId(expandedId === p.id ? null : p.id)
                    }
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <CardTitle className="text-base">
                          {p.version}
                        </CardTitle>
                        {sourceBadge(p.source)}
                        {deltaPct != null && (
                          <Badge variant={deltaPct >= 0 ? "default" : "secondary"} className={deltaPct >= 0 ? "bg-emerald-600" : ""}>
                            vs Baseline: {deltaPct >= 0 ? "↓" : "↑"} {Math.abs(deltaPct).toFixed(1)}%
                          </Badge>
                        )}
                        {p.is_active && (
                          <Badge className="bg-emerald-600 text-white">
                            ACTIVE
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        {p.mae !== null && (
                          <span className="text-sm text-muted-foreground">
                            MAE: <span className="font-mono font-medium">{Number(p.mae).toFixed(3)}</span>
                          </span>
                        )}
                        {p.test_false_positives != null && (
                          <span className="text-sm text-muted-foreground">
                            FP: <span className="font-mono font-medium">{p.test_false_positives}</span>
                          </span>
                        )}
                        {p.test_inversions != null && (
                          <span className="text-sm text-muted-foreground">
                            Inv: <span className="font-mono font-medium">{p.test_inversions}</span>
                          </span>
                        )}
                        {p.dq_accuracy !== null && (
                          <span className="text-sm text-muted-foreground">
                            DQ: <span className="font-mono font-medium">{Number(p.dq_accuracy).toFixed(1)}%</span>
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {new Date(p.created_at).toLocaleDateString()}
                        </span>
                        {p.mae == null && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              evaluatePrompt(p.id);
                            }}
                          >
                            Evaluate
                          </Button>
                        )}
                        {!p.is_active && (
                          <Button
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              activatePrompt(p.id);
                            }}
                          >
                            Activate
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardHeader>

                  {expandedId === p.id && (
                    <CardContent>
                      {prev ? (
                        <>
                          <p className="mb-2 text-sm text-muted-foreground">
                            Changes from {prev.version}:
                          </p>
                          <PromptDiff
                            current={p.prompt_text}
                            previous={prev.prompt_text}
                          />
                        </>
                      ) : (
                        <>
                          <p className="mb-2 text-sm text-muted-foreground">
                            Initial version (no previous to compare)
                          </p>
                          <PromptDiff current={p.prompt_text} previous={null} />
                        </>
                      )}
                    </CardContent>
                  )}
                </Card>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}