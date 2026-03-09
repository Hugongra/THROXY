"use client";

import { useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { RankedLead } from "@/lib/types";

function rankBadge(lead: RankedLead) {
  if (lead.is_disqualified) {
    return <Badge variant="destructive">DQ</Badge>;
  }
  const score = lead.rank_score;
  if (score === null) return <Badge variant="outline">--</Badge>;
  if (score <= 2)
    return <Badge className="bg-emerald-600 text-white">{score}</Badge>;
  if (score <= 5)
    return <Badge className="bg-amber-500 text-white">{score}</Badge>;
  if (score <= 7) return <Badge variant="secondary">{score}</Badge>;
  return <Badge variant="outline">{score}</Badge>;
}

const columns: ColumnDef<RankedLead>[] = [
  {
    accessorKey: "rank_score",
    header: "Rank",
    size: 64,
    sortingFn: (a, b) => {
      // DQ leads always at bottom; non-DQ sorted ascending (1=best at top)
      const aDisq = a.original.is_disqualified;
      const bDisq = b.original.is_disqualified;
      if (aDisq && !bDisq) return 1;
      if (!aDisq && bDisq) return -1;
      const aScore = a.original.rank_score ?? 11;
      const bScore = b.original.rank_score ?? 11;
      return aScore - bScore;
    },
    cell: ({ row }) => rankBadge(row.original),
  },
  {
    id: "name",
    header: "Name",
    accessorFn: (row) =>
    `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
    sortingFn: (a, b) => {
      const nameA = `${a.original.first_name ?? ""} ${a.original.last_name ?? ""}`.trim();
      const nameB = `${b.original.first_name ?? ""} ${b.original.last_name ?? ""}`.trim();
      return nameA.localeCompare(nameB, "en", { sensitivity: "base" });
    },
    cell: ({ row }) => (
      <span
        className={`font-medium ${row.original.is_disqualified ? "line-through" : ""}`}
      >
        {row.original.first_name} {row.original.last_name ?? ""}
      </span>
    ),
  },
  {
    accessorKey: "job_title",
    header: "Job Title",
    sortingFn: (a, b) =>
    (a.getValue<string>("job_title") ?? "").localeCompare(
      b.getValue<string>("job_title") ?? "",
      "en",
      { sensitivity: "base" }
    ),
    cell: ({ row }) => (
      <span className={row.original.is_disqualified ? "line-through" : ""}>
        {row.original.job_title ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "account_name",
    header: "Company",
    sortingFn: (a, b) =>
      (a.getValue<string>("account_name") ?? "").localeCompare(
        b.getValue<string>("account_name") ?? "",
        "en",
        { sensitivity: "base" }
      ),
  },
  {
    accessorKey: "employee_range",
    header: "Size",
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.employee_range ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "industry",
    header: "Industry",
    sortingFn: (a, b) =>
      (a.getValue<string>("industry") ?? "").localeCompare(
        b.getValue<string>("industry") ?? "",
        "en",
        { sensitivity: "base" }
    ),
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.industry ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "reasoning",
    header: "AI Reasoning",
    size: 250,
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.reasoning ?? "—"}
      </span>
    ),
  },
];

interface LeadsTableProps {
  leads: RankedLead[];
}

export function LeadsTable({ leads }: LeadsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "rank_score", desc: false },
  ]);

  const table = useReactTable({
    data: leads,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (leads.length === 0) return null;

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={
                    header.column.getCanSort()
                      ? "cursor-pointer select-none"
                      : ""
                  }
                  onClick={header.column.getToggleSortingHandler()}
                  style={{ width: header.getSize() }}
                >
                  <div className="flex items-center gap-1">
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                    {header.column.getIsSorted() === "asc" && " ↑"}
                    {header.column.getIsSorted() === "desc" && " ↓"}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className={row.original.is_disqualified ? "opacity-50" : ""}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
