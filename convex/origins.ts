import { env } from "./_generated/server";

// SITE_URL is set on every real deployment; the fallback is what makes a bare
// local checkout (and the test suite) work without configuring anything.
export function siteUrl(): string {
  return env.SITE_URL ?? "http://localhost:3466";
}

// Origins the app is served from. OAuth flows may only redirect back to
// one of these. Extend via the APP_ORIGINS env var (comma-separated).
export function allowedOrigins(): string[] {
  const extra = (env.APP_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return [
    siteUrl(),
    "https://finny.vercel.app",
    "https://finnys.vercel.app",
    ...extra,
  ];
}

// Resolve a redirect target (relative or absolute) against the allowlist.
export function resolveRedirect(redirectTo: string): string {
  const url = new URL(redirectTo, siteUrl());
  if (!allowedOrigins().includes(url.origin)) {
    throw new Error(`Redirect to ${url.origin} is not allowed`);
  }
  return url.toString();
}
