"use client";

import { useState } from "react";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import type { RankedLead } from "@/lib/types";

interface ExportCsvProps {
  leads: RankedLead[];
}

export function ExportCsv({ leads }: ExportCsvProps) {
  const [topN, setTopN] = useState(3);

  const handleExport = () => {
    const qualified = leads.filter((l) => !l.is_disqualified && l.rank_score !== null);

    const grouped = new Map<string, RankedLead[]>();
    for (const lead of qualified) {
      const existing = grouped.get(lead.account_name) ?? [];
      existing.push(lead);
      grouped.set(lead.account_name, existing);
    }

    const exportRows: RankedLead[] = [];
    for (const [, companyLeads] of grouped) {
      const sorted = companyLeads
        .sort((a, b) => (a.rank_score ?? 11) - (b.rank_score ?? 11))
        .slice(0, topN);
      exportRows.push(...sorted);
    }

    const csvData = exportRows.map((l) => ({
      rank: l.rank_score,
      first_name: l.first_name,
      last_name: l.last_name ?? "",
      job_title: l.job_title ?? "",
      company: l.account_name,
      domain: l.account_domain ?? "",
      employee_range: l.employee_range ?? "",
      industry: l.industry ?? "",
      reasoning: l.reasoning ?? "",
    }));

    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `top_${topN}_leads_per_company.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm text-muted-foreground">Export top</label>
      <input
        type="number"
        min={1}
        max={20}
        value={topN}
        onChange={(e) => setTopN(Math.max(1, parseInt(e.target.value) || 1))}
        className="h-9 w-16 rounded-md border border-input bg-background px-2 text-center text-sm"
      />
      <label className="text-sm text-muted-foreground">per company</label>
      <Button variant="outline" size="sm" onClick={handleExport}>
        Download CSV
      </Button>
    </div>
  );
}
