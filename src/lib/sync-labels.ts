export const triggerLabels = {
  initial: "First sync",
  webhook: "Bank update",
  manual: "Manual sync",
  cron: "Scheduled sync",
  retry: "Retry",
} as const;

export const runStatusLabels = {
  running: "Running",
  success: "Done",
  error: "Failed",
} as const;

export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export type SyncRunStats = {
  added: number;
  modified: number;
  removed: number;
  skipped?: number;
};

// "+3 / ~1 / −0", plus what a run gave up on. Skipped rows are the ones
// Notion refused often enough that the sync moved past them, so they are
// worth naming rather than folding into the other counts.
export function statsSummary(stats?: SyncRunStats | null) {
  if (!stats) {
    return null;
  }
  const { added, modified, removed, skipped } = stats;
  if (added + modified + removed + (skipped ?? 0) === 0) {
    return null;
  }
  return `+${added} / ~${modified} / −${removed}${
    skipped ? ` · ${skipped} skipped` : ""
  }`;
}
