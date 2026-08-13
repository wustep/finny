import { createFileRoute, redirect } from "@tanstack/react-router";

// The accounts page lives at "/" now; keep old links working and preserve
// search params (e.g. a lingering auth ?code=).
export const Route = createFileRoute("/accounts")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/", search: search as never });
  },
  validateSearch: (search: Record<string, unknown>) => search,
});
