"use client";

import { useCallback, useRef } from "react";
import { CsvUpload } from "@/components/csv-upload";
import { LeadsTable } from "@/components/leads-table";
import { ExportCsv } from "@/components/export-csv";
import { Card, CardContent } from "@/components/ui/card";
import type { RankedLead, IngestResponse } from "@/lib/types";
import { useIngestStore, useLeadsStore } from "./ranker-service";

export default function Home() {
  const leads = useLeadsStore((state) => state.leads);
  const setLeads = useLeadsStore((state) => state.setLeads);
  const addLeads = useLeadsStore((state) => state.addLeads);
  
  const summary = useIngestStore((s) => s.summary);
  const liveStats = useIngestStore((s) => s.liveStats);
  const setSummary = useIngestStore((s) => s.setSummary);
  const setLiveStats = useIngestStore((s) => s.setLiveStats);
  const updateLiveStats = useIngestStore((s) => s.updateLiveStats);
  
  const costRef = useRef(0);
  const hasResetRef = useRef(false);

  const handleBatch = useCallback((batchLeads: RankedLead[], cost: number) => {
    if (!hasResetRef.current) {
      setLeads(batchLeads);
      setSummary(null);
      setLiveStats({
        companiesDone: 0,
        companiesTotal: 0,
        totalCost: 0,
      });
      costRef.current = cost;
      hasResetRef.current = true;
    } else {
      addLeads(batchLeads);
      costRef.current += cost;
    }
    updateLiveStats({ totalCost: costRef.current });
  }, []);

  const handleProgress = useCallback((companiesDone: number, companiesTotal: number) => {
    updateLiveStats({
      companiesDone,
      companiesTotal,
    });
    if (companiesTotal > 0 && companiesDone === 0) {
      setLeads([]);
      setSummary(null);
      costRef.current = 0;
      hasResetRef.current = false;
    }
  }, []);

  const handleDone = useCallback((done: IngestResponse) => {
    setSummary(done);
    costRef.current = 0;
    hasResetRef.current = false;
  }, []);

  const totalProcessed = summary ? summary.total_processed : leads.length;
  const companiesAnalyzed = summary ? summary.companies_analyzed : liveStats.companiesTotal;
  const disqualifiedCount = summary
    ? summary.disqualified_count
    : leads.filter((l) => l.is_disqualified).length;
  const totalCost = summary ? summary.total_cost_usd : liveStats.totalCost;

  return (
    <div className="space-y-6 sm:space-y-8 w-full max-w-full min-w-0">
      <section className="space-y-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-throxy-black">Ranker</h1>
        <p className="mt-2 text-muted-foreground">
          Upload a CSV of leads to qualify and rank them against the Throxy persona spec.
        </p>
      </section>
      <CsvUpload onBatch={handleBatch} onProgress={handleProgress} onDone={handleDone}/>
      {(leads.length > 0 || summary) && (
        <section className="space-y-6 sm:space-y-8">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">Leads Ranked</p>
                  <p className="text-2xl font-bold">{totalProcessed}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">Companies</p>
                  <p className="text-2xl font-bold">{companiesAnalyzed}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">Disqualified</p>
                  <p className="text-2xl font-bold text-destructive">{disqualifiedCount}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">AI Cost</p>
                  <p className="text-2xl font-bold">${totalCost.toFixed(4)}</p>
                </CardContent>
              </Card>
            </div>
            <ExportCsv leads={leads} />
            <LeadsTable leads={leads} />
        </section>
      )}
    </div>
  );
}
