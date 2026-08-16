import { toast as sonner } from "sonner";

// Sonner with a duration that depends on how much there is to read.
//
// A flat four seconds is generous for "Rule saved" and not nearly enough for
// "Removed 3 connections, but Plaid rejected the revocation for Chase — check
// your Plaid dashboard", which is the one you actually needed to finish. This
// reads at a deliberately slow 180 words a minute and never drops below the
// old default, so nothing gets shorter than it was.
const WORDS_PER_MINUTE = 180;
const MINIMUM_MS = 4000;
const MAXIMUM_MS = 12000;

function durationFor(message: unknown): number {
  if (typeof message !== "string") {
    return MINIMUM_MS;
  }
  const words = message.trim().split(/\s+/).length;
  const reading = (words / WORDS_PER_MINUTE) * 60_000;
  return Math.min(MAXIMUM_MS, Math.max(MINIMUM_MS, Math.round(reading)));
}

type Options = Parameters<typeof sonner.success>[1];

function timed(
  show: (message: string, options?: Options) => string | number,
) {
  return (message: string, options?: Options) =>
    show(message, { duration: durationFor(message), ...options });
}

// The same surface as sonner's, so call sites do not know the difference —
// only the import changes.
export const toast = Object.assign(timed(sonner), {
  success: timed(sonner.success),
  error: timed(sonner.error),
  warning: timed(sonner.warning),
  info: timed(sonner.info),
  message: timed(sonner.message),
  dismiss: sonner.dismiss,
  promise: sonner.promise,
  custom: sonner.custom,
  loading: sonner.loading,
});
