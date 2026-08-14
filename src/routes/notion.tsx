import { createFileRoute } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { ExternalLink, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/notion")({
  validateSearch: (search: Record<string, unknown>) => ({
    connected: search.connected as string | undefined,
    error: search.error as string | undefined,
  }),
  component: NotionPage,
});

const DATABASE_LABELS: Record<string, string> = {
  bankConnections: "Bank Connections",
  accounts: "Accounts",
  balanceHistory: "Balance History",
  categories: "Categories",
  transactions: "Transactions",
  securities: "Securities",
  holdings: "Holdings",
  investmentTransactions: "Investment Transactions",
};

function defaultStartDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 2);
  return date.toISOString().slice(0, 10);
}

// Which workspace the row pointed at when a reconnect was started. Survives
// the round trip through Notion, which a React state variable would not, and
// is the only way to notice afterwards that the user came back with a
// different workspace — and so an emptied database map.
const RECONNECT_KEY = "finny.notion.reconnect";

type PreviousWorkspace = { workspaceId: string; workspaceName?: string };

// A first connect and a reconnect are the same OAuth flow. The difference is
// that a reconnect leaves the existing row alone, so the workspace the user
// picks is what decides whether the database map survives.
function useNotionOAuth() {
  const startOAuth = useAction(api.notion.startOAuth);
  const [busy, setBusy] = useState(false);

  const start = (previous?: PreviousWorkspace) => {
    setBusy(true);
    if (previous) {
      sessionStorage.setItem(RECONNECT_KEY, JSON.stringify(previous));
    }
    startOAuth({ origin: window.location.origin })
      .then((url) => {
        window.location.href = url;
      })
      .catch((err: unknown) => {
        console.error(err);
        sessionStorage.removeItem(RECONNECT_KEY);
        toast.error(
          "Could not start the Notion connection — are the Notion OAuth keys set?",
        );
        setBusy(false);
      });
  };

  return { start, busy };
}

type Health = Awaited<
  ReturnType<ReturnType<typeof useAction<typeof api.notion.checkHealth>>>
>;

function NotionPage() {
  const { error } = Route.useSearch();
  const status = useQuery(api.notion.getStatus);
  const checkHealth = useAction(api.notion.checkHealth);
  const { start: startOAuth, busy: connecting } = useNotionOAuth();
  const [health, setHealth] = useState<Health | null>(null);
  const [changedFrom, setChangedFrom] = useState<PreviousWorkspace | null>(null);
  const healthChecked = useRef(false);

  useEffect(() => {
    if (error === "oauth_denied") {
      toast.error("Notion connection was cancelled");
    } else if (error === "oauth_failed") {
      toast.error("Notion connection failed — try again");
    }
  }, [error]);

  // Every call is a request to Notion, so this runs once per page load and
  // whenever the user asks for it again.
  const runHealthCheck = useCallback(
    () =>
      checkHealth()
        .then(setHealth)
        .catch((err: unknown) => console.error(err)),
    [checkHealth],
  );

  useEffect(() => {
    if (!status?.connected || healthChecked.current) {
      return;
    }
    healthChecked.current = true;
    void runHealthCheck();
  }, [status, runHealthCheck]);

  // Coming back from a reconnect: same workspace keeps the databases, a
  // different one has just emptied the map.
  useEffect(() => {
    if (!status?.connected) {
      return;
    }
    const stored = sessionStorage.getItem(RECONNECT_KEY);
    if (!stored) {
      return;
    }
    sessionStorage.removeItem(RECONNECT_KEY);
    let previous: PreviousWorkspace;
    try {
      previous = JSON.parse(stored) as PreviousWorkspace;
    } catch {
      return;
    }
    if (previous.workspaceId === status.workspaceId) {
      toast.success("Notion reconnected — your databases were kept");
    } else {
      setChangedFrom(previous);
    }
  }, [status]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Notion</h1>
        <p className="text-sm text-muted-foreground">
          Where your financial data gets synced
        </p>
      </div>

      {status === undefined || status === null ? (
        <Skeleton className="h-48 w-full" />
      ) : !status.connected ? (
        <Card>
          <CardHeader className="items-center text-center">
            <CardTitle>Not connected</CardTitle>
            <CardDescription>
              Connect your Notion workspace and grant access to the page where
              Finny should create its databases.
            </CardDescription>
            <Button
              className="mx-auto mt-2 w-fit"
              onClick={() => startOAuth()}
              disabled={connecting}
            >
              {connecting ? "Redirecting…" : "Connect Notion"}
            </Button>
          </CardHeader>
        </Card>
      ) : (
        <>
          {changedFrom ? (
            <WorkspaceChangedCard
              previous={changedFrom}
              current={status.workspaceName}
              onRetry={() => startOAuth(changedFrom)}
              onDismiss={() => setChangedFrom(null)}
              busy={connecting}
            />
          ) : null}
          {health?.state === "unauthorized" ? (
            <UnhealthyCard
              message={health.message}
              onReconnect={() =>
                startOAuth({
                  workspaceId: status.workspaceId,
                  workspaceName: status.workspaceName,
                })
              }
              busy={connecting}
            />
          ) : null}
          {!status.databases ? (
            <SetupCard modules={status.modules} />
          ) : (
            <DestinationCard
              status={status}
              health={health}
              onCheckHealth={runHealthCheck}
              onReconnect={() =>
                startOAuth({
                  workspaceId: status.workspaceId,
                  workspaceName: status.workspaceName,
                })
              }
              reconnecting={connecting}
            />
          )}
        </>
      )}
    </div>
  );
}

// Reauthorising into another workspace is not a small mistake: the databases
// Finny built are unreachable with the new token, so the map was dropped and
// the next setup builds a second set somewhere else.
function WorkspaceChangedCard({
  previous,
  current,
  onRetry,
  onDismiss,
  busy,
}: {
  previous: PreviousWorkspace;
  current?: string;
  onRetry: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const from = previous.workspaceName ?? "your previous workspace";
  return (
    <Card className="border-destructive">
      <CardHeader>
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1.5">
            <CardTitle>You reconnected to a different workspace</CardTitle>
            <CardDescription>
              Finny was pointed at {from} and is now pointed at{" "}
              {current ?? "this workspace"}. The databases it built in {from}{" "}
              cannot be reached with the new token, so Finny has forgotten
              them: setting up here creates a fresh set of databases and starts
              syncing from scratch. Everything already in {from} stays where it
              is.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button onClick={onRetry} disabled={busy}>
          {busy ? "Redirecting…" : `Reconnect to ${from}`}
        </Button>
        <Button variant="outline" onClick={onDismiss}>
          Start fresh here
        </Button>
      </CardContent>
    </Card>
  );
}

function UnhealthyCard({
  message,
  onReconnect,
  busy,
}: {
  message: string;
  onReconnect: () => void;
  busy: boolean;
}) {
  return (
    <Card className="border-destructive">
      <CardHeader>
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1.5">
            <CardTitle>Notion connection unhealthy — reconnect</CardTitle>
            <CardDescription>
              Notion rejected the stored token, so syncs cannot write anything.
              Reconnect the same workspace to hand Finny a new token; your
              databases and their rows are kept. ({message})
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Button onClick={onReconnect} disabled={busy}>
          {busy ? "Redirecting…" : "Reconnect Notion"}
        </Button>
      </CardContent>
    </Card>
  );
}

function SetupCard({
  modules: initialModules,
}: {
  modules: { balances: boolean; spending: boolean; investments: boolean };
}) {
  const listPages = useAction(api.notion.listPages);
  const createDatabases = useAction(api.notion.createDatabases);

  const [pages, setPages] = useState<
    Array<{ id: string; title: string; icon: string | null }> | undefined
  >();
  const [pageId, setPageId] = useState("");
  const [modules, setModules] = useState(initialModules);
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listPages()
      .then(setPages)
      .catch(() => toast.error("Could not load your Notion pages"));
  }, [listPages]);

  useEffect(() => {
    if (pages?.length && !pageId) {
      setPageId(pages[0].id);
    }
  }, [pages, pageId]);

  const moduleRows = useMemo(
    () =>
      [
        {
          key: "balances" as const,
          label: "Account balances",
          detail: "Bank Connections, Accounts, Balance History",
        },
        {
          key: "spending" as const,
          label: "Spending",
          detail: "Transactions, Categories",
        },
        {
          key: "investments" as const,
          label: "Investments",
          detail: "Securities, Holdings, Investment Transactions",
        },
      ] satisfies Array<{
        key: keyof typeof modules;
        label: string;
        detail: string;
      }>,
    [],
  );

  const handleCreate = () => {
    if (!pageId) {
      toast.error("Pick a page first");
      return;
    }
    setCreating(true);
    createDatabases({ parentPageId: pageId, modules, startDate })
      .then(() => toast.success("Notion databases created"))
      .catch((err: unknown) => {
        console.error(err);
        toast.error("Failed to create databases — check the Convex logs");
      })
      .finally(() => setCreating(false));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up your destination</CardTitle>
        <CardDescription>
          Finny creates its databases inside a page you choose. Only pages you
          shared during the Notion grant are listed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="parent-page">Page</Label>
          {pages === undefined ? (
            <Skeleton className="h-9 w-full" />
          ) : pages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No pages were shared. Reconnect Notion and select at least one
              page.
            </p>
          ) : (
            <select
              id="parent-page"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
              value={pageId}
              onChange={(event) => setPageId(event.target.value)}
            >
              {pages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.icon ? `${page.icon} ` : ""}
                  {page.title}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <Label>Tracking modules</Label>
          {moduleRows.map((row) => (
            <div key={row.key} className="flex items-center gap-3">
              <div className="flex-1">
                <div className="text-sm">{row.label}</div>
                <div className="text-xs text-muted-foreground">
                  {row.detail}
                </div>
              </div>
              <Switch
                checked={modules[row.key]}
                onCheckedChange={(checked) =>
                  setModules((current) => ({ ...current, [row.key]: checked }))
                }
              />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="start-date">Sync history from</Label>
          <Input
            id="start-date"
            type="date"
            className="w-fit"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </div>

        <Button onClick={handleCreate} disabled={creating} className="w-fit">
          {creating ? "Creating databases…" : "Create databases"}
        </Button>
      </CardContent>
    </Card>
  );
}

function DestinationCard({
  status,
  health,
  onCheckHealth,
  onReconnect,
  reconnecting,
}: {
  status: {
    workspaceName?: string;
    startDate?: string;
    databases?: Record<string, string>;
  };
  health: Health | null;
  onCheckHealth: () => void;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  const databases = status.databases ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle>{status.workspaceName ?? "Notion workspace"}</CardTitle>
        <CardDescription>
          Databases are ready. Syncing engine arrives in the next phase —
          connected banks will start filling these in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2">
          {Object.entries(databases).map(([key, id]) => (
            <li key={key}>
              <a
                href={`https://notion.so/${id.replaceAll("-", "")}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
              >
                {DATABASE_LABELS[key] ?? key}
                <ExternalLink className="size-3.5 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>
        {status.startDate ? (
          <p className="text-sm text-muted-foreground">
            Syncing history from {status.startDate}
          </p>
        ) : null}
        <HealthLine health={health} onCheck={onCheckHealth} />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="w-fit"
            onClick={onReconnect}
            disabled={reconnecting}
          >
            <RefreshCw /> {reconnecting ? "Redirecting…" : "Reconnect Notion"}
          </Button>
          <DisconnectButton />
        </div>
      </CardContent>
    </Card>
  );
}

function HealthLine({
  health,
  onCheck,
}: {
  health: Health | null;
  onCheck: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const handleCheck = () => {
    setChecking(true);
    Promise.resolve(onCheck()).finally(() => setChecking(false));
  };
  const label =
    health === null
      ? "Checking the Notion connection…"
      : health.state === "ok"
        ? "Notion connection is healthy."
        : health.state === "unauthorized"
          ? "Notion rejected the stored token — reconnect above."
          : health.state === "disconnected"
            ? "Notion is not connected."
            : `Could not reach Notion to check the connection (${health.message}).`;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      {label}
      <button
        type="button"
        className="underline underline-offset-4 disabled:opacity-50"
        onClick={handleCheck}
        disabled={checking}
      >
        {checking ? "Checking…" : "Check again"}
      </button>
    </p>
  );
}

// Disconnecting forgets which databases Finny made, which is what makes the
// next connect build a second set — so say that before doing it, and point at
// Reconnect for the case the user actually wants.
function DisconnectButton() {
  const disconnect = useMutation(api.notion.disconnect);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);

  const handleDisconnect = () => {
    setWorking(true);
    disconnect()
      .then(() => {
        toast.success("Notion disconnected");
        setOpen(false);
      })
      .catch(() => toast.error("Failed to disconnect Notion"))
      .finally(() => setWorking(false));
  };

  return (
    <>
      <Button variant="outline" className="w-fit" onClick={() => setOpen(true)}>
        <Unplug /> Disconnect
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Notion?</DialogTitle>
            <DialogDescription>
              Your pages, databases, and every row already synced stay in
              Notion — Finny just stops writing to them. It also forgets the
              token and which databases it created, so connecting again builds
              a fresh set of databases even in the same workspace. If you only
              need to refresh an expired token, use Reconnect Notion instead:
              that keeps these databases.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={working}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={working}
            >
              {working ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
