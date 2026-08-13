import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { AccessGuard } from "@/components/access-gate";
import { AppShell } from "@/components/app-shell";
import { SignIn } from "@/components/sign-in";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
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
