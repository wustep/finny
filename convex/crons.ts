import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Daily balance snapshots + safety-net sync for webhooks that never arrived.
// The sweep also closes out runs whose action died without finishing (see
// syncData.sweepStuckRuns) before it schedules the day's syncs.
crons.daily(
  "daily sync sweep",
  { hourUTC: 11, minuteUTC: 0 }, // ~6-7am ET
  internal.syncData.sweep,
  // No continuation cursor: this is the first pass, which also closes out
  // stale runs before scheduling the day's syncs.
  {},
);

export default crons;
