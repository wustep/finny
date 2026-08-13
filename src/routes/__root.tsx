import { Outlet, createRootRoute, useLocation } from "@tanstack/react-router";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { AccessGuard } from "@/components/access-gate";
import { AppShell, PublicShell } from "@/components/app-shell";
import { SignIn } from "@/components/sign-in";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";

export const Route = createRootRoute({
  component: RootLayout,
});

// Routes reachable without sign-in or the access password.
const PUBLIC_PATHS = new Set(["/policy"]);

function RootLayout() {
  const { pathname } = useLocation();
  if (PUBLIC_PATHS.has(pathname.replace(/\/$/, "") || "/")) {
    return (
      <>
        <PublicShell>
          <Outlet />
        </PublicShell>
        <Toaster />
      </>
    );
  }
  return (
    <>
      <AuthLoading>
        <div className="flex min-h-svh items-center justify-center">
          <Skeleton className="h-8 w-48" />
        </div>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <AccessGuard>
          <AppShell>
            <Outlet />
          </AppShell>
        </AccessGuard>
      </Authenticated>
      <Toaster />
    </>
  );
}
