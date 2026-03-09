"use client";

import { useEffect, useState } from "react";
import { useApoStore } from "@/app/prompts/prompts-service";
import { PromptDiff } from "@/app/prompts/versions/prompt-diff";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Play, RefreshCw } from "lucide-react";

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function PromptOptimizationPage() {
    const apoLogs = useApoStore((s) => s.logs);
    const apoRunning = useApoStore((s) => s.loading);
    const apoProgress = useApoStore((s) => s.progress);
    const apoLabel = useApoStore((s) => s.progressLabel);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    useEffect(() => {
      if (apoRunning) {
        const start = Date.now();
        setElapsedSeconds(0);
        const interval = setInterval(() => {
          setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
        }, 1000);
        return () => clearInterval(interval);
      }
    }, [apoRunning]);
    const compareData = useApoStore((s) => s.compareData);
    const compareLoaded = useApoStore((s) => s.loaded);
    const fetchCompare = useApoStore((s) => s.fetchCompare);
    const runApo = useApoStore((s) => s.runApo);

    useEffect(() => {
      if (!compareLoaded) {
        fetchCompare();
      }
    }, [compareLoaded, fetchCompare]);
    
    return(
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Run Automatic Prompt Optimization</CardTitle>
            <p className="text-sm text-muted-foreground">
              APO iteratively improves the system prompt by evaluating leads against the eval set and rewriting based on worst errors. Uses ranked leads only (80% train, 20% hold-out). Requires eval_set.csv and OpenAI API key.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <Button
                  onClick={runApo}
                  disabled={apoRunning}
                >
                  {apoRunning ? (
                    <>
                      <span className="mr-2 inline-block">
                        <Spinner size="sm" variant="current" />
                      </span>
                      Running...
                    </>
                  ) : (
                    <>
                      <Play className="mr-2 h-4 w-4" />
                      Run APO
                    </>
                  )}
                </Button>
                {compareData?.optimized && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchCompare}
                    disabled={apoRunning}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Refresh Compare
                  </Button>
                )}
              </div>
              {apoRunning && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{apoLabel || "Starting..."}</span>
                    <span className="font-mono text-muted-foreground">
                      {apoProgress}% · Elapsed: {formatElapsed(elapsedSeconds)}
                    </span>
                  </div>
                  <Progress value={apoProgress} className="h-2 w-full" />
                </div>
              )}
            </div>
            {apoLogs.length > 0 && (
              <div className="rounded-lg border bg-muted/50 p-4">
                <p className="mb-2 text-sm font-medium">Live output</p>
                <pre className="max-h-64 overflow-auto text-xs leading-relaxed whitespace-pre-wrap font-mono">
                  {apoLogs.join("\n")}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Compare prompts</CardTitle>
            <p className="text-sm text-muted-foreground">
              Original system prompt vs APO-optimized version. Activate the optimized prompt from the Prompt Versions tab to use it for ranking.
            </p>
          </CardHeader>
          <CardContent>
            {compareData ? (
                compareData.optimized ? (
                  <div className="space-y-4">
                    {/* Metrics from Supabase (latest APO run) — no hardcoded values */}
                    {compareData.latestApoRun && (
                      <div className="rounded-lg border bg-muted/30 p-4">
                        <p className="mb-3 text-sm font-medium">Evaluation metrics (test set)</p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b">
                                <th className="pb-2 pr-4 text-left font-medium">Metric</th>
                                <th className="pb-2 pr-4 text-right font-mono">Baseline</th>
                                <th className="pb-2 text-right font-mono">Optimized</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr className="border-b">
                                <td className="py-2 pr-4 text-muted-foreground">MAE</td>
                                <td className="py-2 pr-4 text-right font-mono">
                                  {typeof compareData.latestApoRun.baseline.mae === "number"
                                    ? compareData.latestApoRun.baseline.mae.toFixed(3)
                                    : compareData.latestApoRun.baseline.mae}
                                </td>
                                <td className="py-2 text-right font-mono">
                                  {typeof compareData.latestApoRun.optimized.mae === "number"
                                    ? compareData.latestApoRun.optimized.mae.toFixed(3)
                                    : compareData.latestApoRun.optimized.mae}
                                </td>
                              </tr>
                              <tr className="border-b">
                                <td className="py-2 pr-4 text-muted-foreground">FP (false positives)</td>
                                <td className="py-2 pr-4 text-right font-mono">{compareData.latestApoRun.baseline.testFp}</td>
                                <td className="py-2 text-right font-mono">{compareData.latestApoRun.optimized.testFp}</td>
                              </tr>
                              <tr className="border-b">
                                <td className="py-2 pr-4 text-muted-foreground">Inv (inversions)</td>
                                <td className="py-2 pr-4 text-right font-mono">{compareData.latestApoRun.baseline.testInv}</td>
                                <td className="py-2 text-right font-mono">{compareData.latestApoRun.optimized.testInv}</td>
                              </tr>
                              <tr>
                                <td className="py-2 pr-4 text-muted-foreground">DQ accuracy</td>
                                <td className="py-2 pr-4 text-right font-mono">
                                  {compareData.latestApoRun.baseline.dqAccuracy != null
                                    ? `${Number(compareData.latestApoRun.baseline.dqAccuracy).toFixed(1)}%`
                                    : "—"}
                                </td>
                                <td className="py-2 text-right font-mono">
                                  {compareData.latestApoRun.optimized.dqAccuracy != null
                                    ? `${Number(compareData.latestApoRun.optimized.dqAccuracy).toFixed(1)}%`
                                    : "—"}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <p className="mb-2 text-sm font-medium">Original</p>
                      <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/30 p-4 text-xs leading-relaxed whitespace-pre-wrap font-mono">
                        {compareData.original}
                      </pre>
                    </div>
                    <div>
                      <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                        Active (used for ranking)
                        <span className="flex gap-2 text-xs font-normal text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-green-200/80 dark:bg-green-900/40" />
                            Added
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-200/80 dark:bg-red-900/40" />
                            Removed
                          </span>
                        </span>
                      </p>
                      <PromptDiff
                        previous={compareData.original}
                        current={compareData.optimized}
                      />
                    </div>
                  </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-muted-foreground text-sm">
                      No optimized prompt yet. Run APO to generate one.
                    </p>
                    <div>
                      <p className="mb-2 text-sm font-medium">Original</p>
                      <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/30 p-4 text-xs leading-relaxed whitespace-pre-wrap">
                        {compareData.original}
                      </pre>
                    </div>
                  </div>
                )
            ) : (
              <p className="text-muted-foreground text-sm">Loading...</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
}
