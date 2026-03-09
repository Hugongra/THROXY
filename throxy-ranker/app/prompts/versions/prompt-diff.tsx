"use client";

import * as Diff from "diff";

export interface PromptDiffProps {
  current: string;
  previous: string | null;
}

export function PromptDiff({ current, previous }: PromptDiffProps) {
  if (!previous) {
    return (
      <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed whitespace-pre-wrap">
        {current}
      </pre>
    );
  }

  const changes = Diff.diffLines(previous, current);

  return (
    <div className="max-h-96 overflow-auto rounded-lg border bg-muted p-4">
      <Legend />
      <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {changes.map((part, i) => (
          <DiffLine key={i} part={part} />
        ))}
      </pre>
    </div>
  );
}

function Legend() {
  return (
    <div className="mb-2 flex gap-4 text-xs">
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-sm bg-red-200/80 dark:bg-red-900/40" />
        Removed
      </span>

      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-sm bg-green-200/80 dark:bg-green-900/40" />
        Added
      </span>
    </div>
  );
}

function DiffLine({ part }: { part: Diff.Change }) {
  if (part.added) {
    return (
      <span className="block bg-green-200/80 dark:bg-green-900/40">
        {part.value}
      </span>
    );
  }

  if (part.removed) {
    return (
      <span className="block bg-red-200/80 dark:bg-red-900/40 line-through">
        {part.value}
      </span>
    );
  }

  return <span>{part.value}</span>;
}
