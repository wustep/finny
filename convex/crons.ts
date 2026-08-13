import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Daily balance snapshots + safety-net sync for webhooks that never arrived.
crons.daily(
  "daily sync sweep",
  { hourUTC: 11, minuteUTC: 0 }, // ~6-7am ET
  internal.syncData.sweep,
);

export default crons;
