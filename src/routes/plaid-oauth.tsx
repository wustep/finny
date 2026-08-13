import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { useEffect, useMemo } from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import {
  clearPlaidLinkSession,
  readPlaidLinkSession,
} from "@/components/plaid-link";
import { Skeleton } from "@/components/ui/skeleton";

// OAuth banks redirect back here mid-Link; re-initialize Link with the
// stored token and the received redirect URI to finish the flow.
export const Route = createFileRoute("/plaid-oauth")({
  component: PlaidOAuthReturn,
});

function PlaidOAuthReturn() {
  const navigate = useNavigate();
  const exchangePublicToken = useAction(api.plaid.exchangePublicToken);
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
        toast.success("Connection repaired");
        void navigate({ to: "/" });
        return;
      }
      if (publicToken === null) {
        void navigate({ to: "/" });
        return;
      }
      exchangePublicToken({ publicToken })
        .then(() => toast.success("Bank connected"))
        .catch(() => toast.error("Failed to save the connection"))
        .finally(() => void navigate({ to: "/" }));
    },
    onExit: (error) => {
      if (error) {
        console.error("Plaid Link exited with error:", error);
        toast.error(error.display_message || error.error_message || "Plaid Link failed");
      }
      finish();
    },
  });

  useEffect(() => {
    if (session?.token && ready) {
      open();
    }
  }, [session, ready, open]);

  useEffect(() => {
    // Landed here without a pending Link session — most likely the browser
    // didn't carry sessionStorage across the bank's redirect (e.g. a
    // different tab, or third-party storage partitioning), so the flow
    // can't be resumed. Say so instead of silently bouncing home.
    if (!session?.token) {
      toast.error(
        "Couldn't resume the bank connection — please try connecting again.",
      );
      void navigate({ to: "/" });
    }
  }, [session, navigate]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 py-16">
      <Skeleton className="h-8 w-64" />
      <p className="text-sm text-muted-foreground">
        Finishing your bank connection…
      </p>
    </div>
  );
}
