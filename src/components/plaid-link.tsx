import { useAction, useMutation } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// OAuth institutions leave the page mid-Link; the session is stashed here so
// the /plaid-oauth route can resume it after the bank redirects back.
export const PLAID_LINK_SESSION_KEY = "finny_plaid_link_session";

export interface PlaidLinkSession {
  token: string;
  connectionId: string | null;
}

export function readPlaidLinkSession(): PlaidLinkSession | null {
  try {
    const raw = sessionStorage.getItem(PLAID_LINK_SESSION_KEY);
    return raw ? (JSON.parse(raw) as PlaidLinkSession) : null;
  } catch {
    return null;
  }
}

export function clearPlaidLinkSession() {
  sessionStorage.removeItem(PLAID_LINK_SESSION_KEY);
}

// Fetches a link token on demand, opens Plaid Link once it's ready, and
// exchanges the public token on success. Pass connectionId to run Link in
// update mode (reconnect) instead of creating a new connection.
export function usePlaidConnect(options?: {
  connectionId?: Id<"bankConnections">;
}) {
  const createLinkToken = useAction(api.plaid.createLinkToken);
  const createUpdateLinkToken = useAction(api.plaid.createUpdateLinkToken);
  const exchangePublicToken = useAction(api.plaid.exchangePublicToken);
  const markReconnected = useMutation(api.connections.markReconnected);

  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connectionId = options?.connectionId;

  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (publicToken) => {
      setToken(null);
      clearPlaidLinkSession();
      if (connectionId) {
        // Update mode: credentials fixed at Plaid; nothing to exchange, so
        // clearing the error and syncing is on us.
        markReconnected({ connectionId })
          .then(() => toast.success("Connection repaired — syncing now"))
          .catch((error: unknown) => {
            console.error(error);
            toast.error("Reconnected, but the sync could not be started");
          })
          .finally(() => setBusy(false));
        return;
      }
      if (publicToken === null) {
        setBusy(false);
        return;
      }
      exchangePublicToken({ publicToken, origin: window.location.origin })
        .then(() => toast.success("Bank connected"))
        .catch(() => toast.error("Failed to save the connection"))
        .finally(() => setBusy(false));
    },
    onExit: (error) => {
      setToken(null);
      clearPlaidLinkSession();
      setBusy(false);
      // error is null when the user just closed Link; anything else is a
      // real failure (e.g. an unregistered OAuth redirect URI) that would
      // otherwise fail silently.
      if (error) {
        console.error("Plaid Link exited with error:", error);
        toast.error(error.display_message || error.error_message || "Plaid Link failed");
      }
    },
  });

  useEffect(() => {
    if (token && ready) {
      open();
    }
  }, [token, ready, open]);

  const start = useCallback(() => {
    setBusy(true);
    const origin = window.location.origin;
    const request = connectionId
      ? createUpdateLinkToken({ connectionId, origin })
      : createLinkToken({ origin });
    request
      .then((linkToken) => {
        // Stash for the OAuth return leg before Link opens.
        sessionStorage.setItem(
          PLAID_LINK_SESSION_KEY,
          JSON.stringify({
            token: linkToken,
            connectionId: connectionId ?? null,
          } satisfies PlaidLinkSession),
        );
        setToken(linkToken);
      })
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Could not start Plaid Link — are the Plaid keys set?");
        setBusy(false);
      });
  }, [connectionId, createLinkToken, createUpdateLinkToken]);

  return { start, busy };
}
