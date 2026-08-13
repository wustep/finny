import { useAction } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// Fetches a link token on demand, opens Plaid Link once it's ready, and
// exchanges the public token on success. Pass connectionId to run Link in
// update mode (reconnect) instead of creating a new connection.
export function usePlaidConnect(options?: {
  connectionId?: Id<"bankConnections">;
}) {
  const createLinkToken = useAction(api.plaid.createLinkToken);
  const createUpdateLinkToken = useAction(api.plaid.createUpdateLinkToken);
  const exchangePublicToken = useAction(api.plaid.exchangePublicToken);

  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connectionId = options?.connectionId;

  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (publicToken) => {
      setToken(null);
      if (connectionId) {
        // Update mode: credentials fixed at Plaid; nothing to exchange.
        toast.success("Connection repaired");
        setBusy(false);
        return;
      }
      if (publicToken === null) {
        setBusy(false);
        return;
      }
      exchangePublicToken({ publicToken })
        .then(() => toast.success("Bank connected"))
        .catch(() => toast.error("Failed to save the connection"))
        .finally(() => setBusy(false));
    },
    onExit: () => {
      setToken(null);
      setBusy(false);
    },
  });

  useEffect(() => {
    if (token && ready) {
      open();
    }
  }, [token, ready, open]);

  const start = useCallback(() => {
    setBusy(true);
    const request = connectionId
      ? createUpdateLinkToken({ connectionId })
      : createLinkToken();
    request
      .then(setToken)
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Could not start Plaid Link — are the Plaid keys set?");
        setBusy(false);
      });
  }, [connectionId, createLinkToken, createUpdateLinkToken]);

  return { start, busy };
}
