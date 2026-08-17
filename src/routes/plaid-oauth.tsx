import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAction, useMutation } from "convex/react";
import { useEffect, useMemo } from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "@/lib/notify";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  clearPlaidLinkSession,
  readPlaidLinkSession,
} from "@/components/plaid-link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// OAuth banks redirect back here mid-Link; re-initialize Link with the
// stored token and the received redirect URI to finish the flow.
export const Route = createFileRoute("/plaid-oauth")({
  component: PlaidOAuthReturn,
});

function PlaidOAuthReturn() {
  const navigate = useNavigate();
  const exchangePublicToken = useAction(api.plaid.exchangePublicToken);
  const markReconnected = useMutation(api.connections.markReconnected);
  const session = useMemo(readPlaidLinkSession, []);

  const finish = () => {
    clearPlaidLinkSession();
    void navigate({ to: "/" });
  };

  const { open, ready } = usePlaidLink({
    token: session?.token ?? null,
    receivedRedirectUri: window.location.href,
    onSuccess: (publicToken) => {
      clearPlaidLinkSession();
      if (session?.connectionId) {
        markReconnected({
          connectionId: session.connectionId as Id<"bankConnections">,
        })
          .then(() => toast.success("Connection repaired — syncing now"))
          .catch((error: unknown) => {
            console.error(error);
            toast.error("Reconnected, but the sync could not be started");
          })
          .finally(() => void navigate({ to: "/" }));
        return;
      }
      if (publicToken === null) {
        void navigate({ to: "/" });
        return;
      }
      exchangePublicToken({ publicToken, origin: window.location.origin })
        .then(() => toast.success("Bank connected"))
        .catch(() => toast.error("Failed to save the connection"))
        .finally(() => void navigate({ to: "/" }));
    },
    onExit: (error) => {
      if (error) {
        console.error("Plaid Link exited with error:", error);
        toast.error(
          error.display_message || error.error_message || "Plaid Link failed",
        );
      }
      finish();
    },
  });

  useEffect(() => {
    if (session?.token && ready) {
      open();
    }
  }, [session, ready, open]);

  // Landed here without a pending Link session — most likely the browser
  // didn't carry sessionStorage across the bank's redirect (e.g. a
  // different tab, or third-party storage partitioning), so the flow
  // can't be resumed. Stay here and say so; bouncing home with a toast
  // is easy to miss.
  if (!session?.token) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <Card>
          <CardHeader className="justify-items-center text-center">
            <CardTitle>Couldn't finish connecting</CardTitle>
            <CardDescription>
              The bank sent you back, but this browser lost the session. Start
              the connection again from Accounts.
            </CardDescription>
            <Button asChild className="mx-auto mt-2 w-fit">
              <Link to="/">Back to Accounts</Link>
            </Button>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 py-16">
      <Skeleton className="h-8 w-64" />
      <p className="text-sm text-muted-foreground">
        Finishing your bank connection…
      </p>
    </div>
  );
}
