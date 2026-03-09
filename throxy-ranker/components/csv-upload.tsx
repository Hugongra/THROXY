"use client";

import { useCallback, useRef, useState } from "react";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import type { CsvRow, RankedLead, StreamEvent, IngestResponse } from "@/lib/types";

interface CsvUploadProps {
  onBatch: (leads: RankedLead[], cost: number) => void;
  onProgress: (companiesDone: number, companiesTotal: number) => void;
  onDone: (summary: IngestResponse) => void;
}

export function CsvUpload({ onBatch, onProgress, onDone }: CsvUploadProps) {

  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [companiesTotal, setCompaniesTotal] = useState(0);
  const [companiesDone, setCompaniesDone] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const progressPct = companiesTotal > 0 ? Math.round((companiesDone / companiesTotal) * 100) : 0;

  const processStream = useCallback(
    async (rows: CsvRow[]) => {
      setIsLoading(true);

      try {
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows }),
        });

        if (!res.ok || !res.body) {
          throw new Error("Server returned an error");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const dataLine = line.trim();
            if (!dataLine.startsWith("data: ")) continue;
            const json = dataLine.slice(6);

            try {
              const event: StreamEvent = JSON.parse(json);

              switch (event.type) {
                case "progress":
                  setCompaniesTotal(event.companies_total);
                  setCompaniesDone(event.companies_done);
                  onProgress(event.companies_done, event.companies_total);
                  break;

                case "batch":
                  onBatch(event.ranked_leads, event.cost);
                  break;

                case "done":
                  onDone({
                    ranked_leads: [],
                    total_processed: event.total_processed,
                    companies_analyzed: event.companies_analyzed,
                    total_cost_usd: event.total_cost_usd,
                    disqualified_count: event.disqualified_count,
                  });
                  toast.success(
                    `Ranked ${event.total_processed} leads across ${event.companies_analyzed} companies`
                  );
                  break;

                case "error":
                  throw new Error(event.message);
              }
            } catch (parseErr) {
              if (parseErr instanceof SyntaxError) continue;
              throw parseErr;
            }
          }
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to process leads");
      } finally {
        setIsLoading(false);
        setCompaniesDone(0);
        setCompaniesTotal(0);
      }
    },
    [onBatch, onProgress, onDone]
  );

  const handleFile = useCallback(
    (file: File) => {
      setFileName(file.name);
      Papa.parse<CsvRow>(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) =>
          header.trim().toLowerCase().replace(/\s+/g, "_"),
        complete: async (results) => {
          if (!results.data || results.data.length === 0) {
            toast.error(
              "The CSV file is empty or invalid. Please upload a valid leads file."
            );
            return;
          }

          const rows = results.data.filter(
            (row) => row.account_name && row.lead_first_name
          );

          if (rows.length === 0) {
            toast.error(
              "The CSV file is empty or invalid. Please upload a valid leads file."
            );
            return;
          }

          setRowCount(rows.length);
          processStream(rows);
        },
        error: (err) => {
          toast.error(`CSV parse error: ${err.message}`);
        },
      });
    },
    [processStream]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith(".csv")) {
        handleFile(file);
      } else {
        toast.error("Please drop a .csv file");
      }
    },
    [handleFile]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload Leads CSV</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed border-muted-foreground/25 p-10 transition-colors hover:border-muted-foreground/50"
        >
          {isLoading ? (
            <div className="flex w-full max-w-md flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-sm font-medium">
                Ranking {rowCount} leads with AI...
              </p>
              <Progress value={progressPct} className="w-full" />
              <p className="text-sm text-muted-foreground">
                {companiesDone} / {companiesTotal || "?"} companies scored &middot; {progressPct}%
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {fileName
                  ? `Last uploaded: ${fileName}`
                  : "Drag & drop your CSV here, or click to browse"}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                Select CSV File
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
