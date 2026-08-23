import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  formatDuration,
  runStatusLabels,
  statsSummary,
  triggerLabels,
} from "@/lib/sync-labels";

export type SyncRun = {
  id: string;
  institutionName: string;
  trigger: keyof typeof triggerLabels;
  status: keyof typeof runStatusLabels;
  startedAt: number;
  finishedAt?: number;
  stats?: {
    added: number;
    modified: number;
    removed: number;
    skipped?: number;
  };
  error?: string;
};

export function SyncRunRow({ run }: { run: SyncRun }) {
  const [expanded, setExpanded] = useState(false);
  const failed = run.status === "error";
  const summary = statsSummary(run.stats);
  const duration = run.finishedAt
    ? formatDuration(run.finishedAt - run.startedAt)
    : null;

  return (
    <li
      className={
        failed
          ? "flex flex-col gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
          : "flex flex-col gap-1.5 px-3 py-2 text-sm"
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge
          variant={
            failed
              ? "destructive"
              : run.status === "running"
                ? "outline"
                : "secondary"
          }
        >
          {runStatusLabels[run.status]}
        </Badge>
        <span className="min-w-0 flex-1">
          {run.institutionName}
          <span className="text-muted-foreground">
            {" "}
            · {triggerLabels[run.trigger]}
          </span>
          {summary ? (
            <span className="tabular-nums text-muted-foreground">
              {" "}
              · {summary}
            </span>
          ) : null}
          {duration ? (
            <span className="tabular-nums text-muted-foreground">
              {" "}
              · {duration}
            </span>
          ) : null}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {new Date(run.startedAt).toLocaleString()}
        </span>
      </div>
      {run.error ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="flex cursor-pointer items-start gap-1 text-left text-xs text-destructive"
        >
          <ChevronRight
            aria-hidden
            className={`mt-0.5 size-3 shrink-0 transition-transform duration-150 ${
              expanded ? "rotate-90" : ""
            }`}
          />
          <span className={expanded ? "" : "line-clamp-2"}>{run.error}</span>
        </button>
      ) : null}
    </li>
  );
}
