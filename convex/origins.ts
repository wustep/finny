// Origins the app is served from. OAuth flows may only redirect back to
// one of these.
export function allowedOrigins(): string[] {
  return [process.env.SITE_URL ?? "http://localhost:3466", "https://finny.vercel.app"];
}

// Resolve a redirect target (relative or absolute) against the allowlist.
export function resolveRedirect(redirectTo: string): string {
  const base = process.env.SITE_URL ?? "http://localhost:3466";
  const url = new URL(redirectTo, base);
  if (!allowedOrigins().includes(url.origin)) {
    throw new Error(`Redirect to ${url.origin} is not allowed`);
  }
  return url.toString();
}
