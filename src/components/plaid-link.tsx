import { useAction, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "@/lib/notify";
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
// exchanges the public token on success. Call start(connectionId) to run
// Link in update mode (reconnect) instead of creating a new connection.
//
// Mount this hook ONCE per page. Each usePlaidLink instance embeds the Plaid
// script again (it warns about it in the console), so instead of one hook per
// connection card, a single instance tracks which connection Link is open for.
export function usePlaidConnect() {
  const createLinkToken = useAction(api.plaid.createLinkToken);
  const createUpdateLinkToken = useAction(api.plaid.createUpdateLinkToken);
  const exchangePublicToken = useAction(api.plaid.exchangePublicToken);
  const markReconnected = useMutation(api.connections.markReconnected);

  const [token, setToken] = useState<string | null>(null);
  // null = idle, "new" = adding a connection, otherwise the connection being
  // reconnected. Lets callers disable only the button that was clicked.
  const [busyFor, setBusyFor] = useState<Id<"bankConnections"> | "new" | null>(
    null,
  );
  // Mirrors busyFor for the Plaid callbacks: the handler is created when the
  // token arrives, so a ref avoids it closing over stale state.
  const activeConnection = useRef<Id<"bankConnections"> | null>(null);

  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (publicToken) => {
      const connectionId = activeConnection.current;
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
          .finally(() => setBusyFor(null));
        return;
      }
      if (publicToken === null) {
        setBusyFor(null);
        return;
      }
      exchangePublicToken({ publicToken, origin: window.location.origin })
        .then(() => toast.success("Bank connected"))
        .catch(() => toast.error("Failed to save the connection"))
        .finally(() => setBusyFor(null));
    },
    onExit: (error) => {
      setToken(null);
      clearPlaidLinkSession();
      setBusyFor(null);
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

  const start = useCallback(
    (connectionId?: Id<"bankConnections">) => {
      setBusyFor(connectionId ?? "new");
      activeConnection.current = connectionId ?? null;
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
          setBusyFor(null);
        });
    },
    [createLinkToken, createUpdateLinkToken],
  );

  return { start, busy: busyFor !== null, busyFor };
}
