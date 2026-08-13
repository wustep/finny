// Constant-time-ish string comparison; avoids the obvious early-exit
// timing leak when checking shared secrets.
export function timingSafeEqualish(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}
