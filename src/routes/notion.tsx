import { createFileRoute } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ExternalLink,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Unplug,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
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

type Modules = { balances: boolean; spending: boolean; investments: boolean };

const MODULE_ROWS: Array<{
  key: keyof Modules;
  label: string;
  detail: string;
}> = [
  {
    key: "balances",
    label: "Account balances",
    detail: "Bank Connections, Accounts, Balance History",
  },
  {
    key: "spending",
    label: "Spending",
    detail: "Transactions, Categories",
  },
  {
    key: "investments",
    label: "Investments",
    detail: "Securities, Holdings, Investment Transactions",
  },
];

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

function SetupCard({ modules: initialModules }: { modules: Modules }) {
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
          {MODULE_ROWS.map((row) => (
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
    parentPageId?: string;
    modules: Modules;
    startDate?: string;
    databases?: Record<string, string>;
  };
  health: Health | null;
  onCheckHealth: () => void;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  const connections = useQuery(api.connections.list);
  const triggerSync = useAction(api.sync.triggerManual);
  const databases = status.databases ?? {};
  const [syncing, setSyncing] = useState(false);

  const lastSyncedAt = connections?.reduce<number | undefined>(
    (latest, connection) =>
      connection.lastSyncedAt && (!latest || connection.lastSyncedAt > latest)
        ? connection.lastSyncedAt
        : latest,
    undefined,
  );

  // One run per connection, the same trigger the Accounts page uses.
  const handleSyncAll = () => {
    if (!connections?.length) {
      return;
    }
    setSyncing(true);
    Promise.allSettled(
      connections.map((connection) =>
        triggerSync({ connectionId: connection.id }),
      ),
    )
      .then((results) => {
        const failed = results.filter(
          (result) => result.status === "rejected",
        ).length;
        if (failed === 0) {
          toast.success(
            `Syncing ${results.length} ${
              results.length === 1 ? "bank" : "banks"
            }`,
          );
        } else {
          toast.error(`${failed} of ${results.length} banks failed to start`);
        }
      })
      .finally(() => setSyncing(false));
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{status.workspaceName ?? "Notion workspace"}</CardTitle>
          <CardDescription>
            {Object.keys(databases).length} databases are ready.{" "}
            {connections === undefined
              ? ""
              : connections.length === 0
                ? "No banks are connected yet — add one from Accounts and it will fill these in."
                : lastSyncedAt
                  ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}.`
                  : "Waiting on the first sync to fill them in."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <DatabaseSection
            databases={databases}
            parentPageId={status.parentPageId}
          />

          <ModuleSection modules={status.modules} />
          <StartDateSection startDate={status.startDate} />
          <HealthLine health={health} onCheck={onCheckHealth} />

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleSyncAll}
              disabled={syncing || !connections?.length}
            >
              <RefreshCw /> {syncing ? "Starting…" : "Sync now (all)"}
            </Button>
            <Button
              variant="outline"
              onClick={onReconnect}
              disabled={reconnecting}
            >
              {reconnecting ? "Redirecting…" : "Reconnect Notion"}
            </Button>
            <ResetResyncButton />
            <DisconnectButton />
          </div>
        </CardContent>
      </Card>

      <RecentSyncs />
    </>
  );
}

type DatabaseState = Awaited<
  ReturnType<ReturnType<typeof useAction<typeof api.notion.checkDatabases>>>
>[number];

// What each state means, in the fewest words that still say what to do.
function describe(state: DatabaseState): string | null {
  switch (state.state) {
    case "ok":
      return null;
    case "missing":
      return "deleted, or no longer shared with Finny";
    case "trashed":
      return "in your Notion trash — restore it there to keep its rows";
    case "unknown":
      return "could not be checked";
    case "damaged": {
      const parts: string[] = [];
      if (state.missingProperties.length) {
        parts.push(`missing ${state.missingProperties.join(", ")}`);
      }
      for (const wrong of state.wrongTypeProperties) {
        parts.push(`${wrong.name} is now a ${wrong.actual}`);
      }
      return parts.join(" · ");
    }
  }
}

// The databases, and whether they are still the ones Finny thinks they are.
//
// checkHealth answers "does the token work". This answers the question after
// it: a deleted database or a renamed column fails every write while the
// destination page happily reports healthy.
function DatabaseSection({
  databases,
  parentPageId,
}: {
  databases: Record<string, string>;
  parentPageId?: string;
}) {
  const checkDatabases = useAction(api.notion.checkDatabases);
  const repairDatabases = useAction(api.notion.repairDatabases);
  const [states, setStates] = useState<DatabaseState[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  const byKey = new Map((states ?? []).map((state) => [state.key, state]));
  const rebuildable = (states ?? []).filter(
    (state) => state.state === "missing" || state.state === "trashed",
  );
  const fixableProperties = (states ?? []).filter(
    (state) => state.state === "damaged" && state.missingProperties.length > 0,
  );

  const runCheck = () => {
    setChecking(true);
    checkDatabases()
      .then((result) => {
        setStates(result);
        const broken = result.filter((state) => state.state !== "ok").length;
        toast[broken ? "warning" : "success"](
          broken ? `${broken} need attention` : "All databases look right",
        );
      })
      .catch(() => toast.error("Could not check your databases"))
      .finally(() => setChecking(false));
  };

  const runRepair = () => {
    setRepairing(true);
    repairDatabases()
      .then((result) => {
        toast.success(
          result.rebuilt.length
            ? `Rebuilt ${result.rebuilt.length}, syncing ${result.syncing} ${
                result.syncing === 1 ? "bank" : "banks"
              }`
            : `Added ${result.propertiesAdded} ${
                result.propertiesAdded === 1 ? "column" : "columns"
              }`,
        );
        setConfirmRebuild(false);
        return checkDatabases().then(setStates);
      })
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Repair failed — check the Convex logs");
      })
      .finally(() => setRepairing(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Databases</Label>
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-4 disabled:opacity-50"
          onClick={runCheck}
          disabled={checking}
        >
          {checking ? "Checking…" : "Check"}
        </button>
      </div>
      {parentPageId ? (
        <a
          href={`https://notion.so/${parentPageId.replaceAll("-", "")}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Inside your chosen page
          <ExternalLink className="size-3" />
        </a>
      ) : null}
      <ul className="flex flex-col gap-2">
        {Object.entries(databases).map(([key, id]) => {
          const state = byKey.get(key);
          const detail = state ? describe(state) : null;
          return (
            <li key={key} className="flex flex-wrap items-baseline gap-x-2">
              {state && state.state !== "ok" ? (
                <TriangleAlert className="size-3.5 shrink-0 self-center text-destructive" />
              ) : null}
              <a
                href={`https://notion.so/${id.replaceAll("-", "")}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
              >
                {DATABASE_LABELS[key] ?? key}
                <ExternalLink className="size-3.5 text-muted-foreground" />
              </a>
              {detail ? (
                <span className="text-xs text-muted-foreground">{detail}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {fixableProperties.length > 0 && rebuildable.length === 0 ? (
        <Button
          variant="outline"
          className="mt-1 w-fit"
          disabled={repairing}
          onClick={runRepair}
        >
          <Wrench /> {repairing ? "Adding…" : "Add the missing columns"}
        </Button>
      ) : null}
      {rebuildable.length > 0 ? (
        <Button
          variant="outline"
          className="mt-1 w-fit"
          disabled={repairing}
          onClick={() => setConfirmRebuild(true)}
        >
          <Wrench /> Rebuild {rebuildable.length}…
        </Button>
      ) : null}

      <Dialog open={confirmRebuild} onOpenChange={setConfirmRebuild}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Rebuild {rebuildable.map((state) => DATABASE_LABELS[state.key] ?? state.key).join(", ")}?
            </DialogTitle>
            <DialogDescription>
              Finny makes them again, repoints the relations that referenced
              them, and syncs your banks to fill them in from Plaid. The rows
              that were in them are gone with them — if a database is only in
              your Notion trash, restoring it there keeps its history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRebuild(false)}
              disabled={repairing}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={runRepair} disabled={repairing}>
              {repairing ? "Rebuilding…" : "Rebuild"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Modules are editable after setup: switching one on creates the databases it
// needs that don't exist yet and backfills them, switching one off only stops
// the writes.
function ModuleSection({ modules }: { modules: Modules }) {
  const setModules = useAction(api.notion.setModules);
  const [pending, setPending] = useState<keyof Modules | null>(null);

  const handleToggle = (row: (typeof MODULE_ROWS)[number], on: boolean) => {
    setPending(row.key);
    setModules({ modules: { ...modules, [row.key]: on } })
      .then(() =>
        toast.success(
          on
            ? `${row.label} on — its databases are being filled in now`
            : `${row.label} off — its databases stay in Notion`,
        ),
      )
      .catch((err: unknown) => {
        console.error(err);
        toast.error(`Could not turn ${row.label.toLowerCase()} ${on ? "on" : "off"}`);
      })
      .finally(() => setPending(null));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label>Tracking modules</Label>
        <p className="text-xs text-muted-foreground">
          Turning one on creates the databases it needs and syncs into them.
          Turning one off stops syncing it — nothing is removed from Notion.
        </p>
      </div>
      {MODULE_ROWS.map((row) => (
        <div key={row.key} className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm">{row.label}</div>
            <div className="text-xs text-muted-foreground">
              {pending === row.key ? "Updating…" : row.detail}
            </div>
          </div>
          <Switch
            checked={modules[row.key]}
            disabled={pending !== null}
            onCheckedChange={(checked) => handleToggle(row, checked)}
          />
        </div>
      ))}
    </div>
  );
}

// The start date is a filter on what syncs write, so saving it alone only
// changes what happens next. Reaching further back also needs the Plaid
// cursor rewound, which is the second button.
function StartDateSection({ startDate }: { startDate?: string }) {
  const setStartDate = useMutation(api.notion.setStartDate);
  const [value, setValue] = useState(startDate ?? defaultStartDate);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(startDate ?? defaultStartDate());
  }, [startDate]);

  const dirty = value !== (startDate ?? "");
  const earlier = Boolean(startDate) && value < (startDate ?? "");

  const handleSave = (rebackfill: boolean) => {
    setSaving(true);
    setStartDate({ startDate: value, rebackfill })
      .then((result) =>
        toast.success(
          rebackfill
            ? `Syncing history from ${value} across ${result.connections} ${
                result.connections === 1 ? "bank" : "banks"
              }`
            : `New syncs will cover ${value} onwards`,
        ),
      )
      .catch((err: unknown) => {
        console.error(err);
        toast.error("Could not change the start date");
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="start-date">Sync history from</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="start-date"
          type="date"
          className="w-fit"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {dirty ? (
          <>
            <Button variant="outline" disabled={saving} onClick={() => handleSave(false)}>
              Save
            </Button>
            <Button disabled={saving} onClick={() => handleSave(true)}>
              {saving ? "Starting…" : "Save & re-backfill"}
            </Button>
          </>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {!dirty
          ? "Save alone only changes what future syncs pick up. Re-backfill replays your Plaid history from this date; rows already in Notion are updated, not duplicated."
          : !startDate
            ? "No start date is set yet, so syncs cover everything Plaid returns. Saving one narrows what future syncs write."
            : earlier
              ? `Earlier than ${startDate}, which only reaches further back on a re-backfill: Plaid otherwise sends nothing but what changed since the last sync.`
              : `Later than ${startDate}. Everything already in Notion stays — new syncs just stop adding items dated before ${value}.`}
      </p>
    </div>
  );
}

function RecentSyncs() {
  const runs = useQuery(api.connections.recentRuns);
  if (!runs || runs.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent syncs</CardTitle>
        <CardDescription>
          What Finny has written to these databases lately.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {runs.slice(0, 5).map((run) => (
            <li key={run.id} className="flex items-center gap-3 text-sm">
              <Badge
                variant={
                  run.status === "error"
                    ? "destructive"
                    : run.status === "running"
                      ? "outline"
                      : "secondary"
                }
              >
                {run.status}
              </Badge>
              <span className="flex-1">
                {run.institutionName}
                <span className="text-muted-foreground"> · {run.trigger}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(run.startedAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
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

// A reset used to be half a job: Finny forgot its page ids, and the rows those
// ids pointed at were left for the user to go and delete by hand before
// clicking the button — or else the rebuild wrote a second copy of everything.
// It has the ids, so it can do that itself. Which it does is the one thing
// worth asking, because the answer depends on whether those rows have been
// made into something of the user's own.
type ExistingRows = "archive" | "leave";

const ROW_CHOICES: Array<{
  value: ExistingRows;
  label: string;
  detail: string;
}> = [
  {
    value: "archive",
    label: "Delete the old rows first",
    detail: "Finny sends every row it made to your Notion trash.",
  },
  {
    value: "leave",
    label: "Leave them",
    detail: "The rebuild writes fresh rows alongside the old ones.",
  },
];

function ResetResyncButton() {
  const resetAndResync = useAction(api.sync.resetAndResync);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [existingRows, setExistingRows] = useState<ExistingRows>("archive");

  const handleReset = () => {
    setWorking(true);
    resetAndResync({ existingRows })
      .then((result) => {
        const banks = `${result.connections} ${
          result.connections === 1 ? "bank" : "banks"
        }`;
        toast.success(
          existingRows === "archive"
            ? `Clearing the old rows, then rebuilding across ${banks}`
            : `Rebuilding from scratch across ${banks}`,
        );
        setOpen(false);
      })
      .catch((err: unknown) => {
        console.error(err);
        toast.error("Could not start the rebuild");
      })
      .finally(() => setWorking(false));
  };

  return (
    <>
      <Button variant="outline" className="w-fit" onClick={() => setOpen(true)}>
        <RotateCcw /> Reset mappings & resync
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset mappings and resync?</DialogTitle>
            <DialogDescription>
              Finny forgets which Notion page is which, rewinds its Plaid
              cursors, and syncs every bank again from your start date.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="flex flex-col gap-2 py-1">
            <legend className="sr-only">What to do with the old rows</legend>
            {ROW_CHOICES.map((choice) => (
              <label
                key={choice.value}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-checked:border-primary has-checked:bg-primary/5"
              >
                <input
                  type="radio"
                  name="existing-rows"
                  className="mt-0.5 accent-primary"
                  checked={existingRows === choice.value}
                  onChange={() => setExistingRows(choice.value)}
                  disabled={working}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{choice.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {choice.detail}
                  </span>
                </span>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              Deleting a page in Notion moves it to the trash, where it stays
              for 30 days. Categories are re-adopted by their ID either way.
            </p>
          </fieldset>

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
              onClick={handleReset}
              disabled={working}
            >
              {working ? "Starting…" : "Reset & resync"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
