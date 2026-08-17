import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ArrowRight,
  CircleCheck,
  Landmark,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "@/lib/notify";
import { formatDuration, triggerLabels } from "@/lib/sync-labels";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { usePlaidConnect } from "@/components/plaid-link";
import { SyncRunRow } from "@/components/sync-run-row";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/")({
  component: AccountsPage,
});

const statusLabels = {
  active: "Active",
  error: "Needs attention",
  pending_expiration: "Expiring soon",
} as const;

// Plaid's error codes in the words of someone who just wants their bank to
// work again. Anything not listed falls back to naming the code.
const errorExplanations: Record<string, string> = {
  ITEM_LOGIN_REQUIRED: "Your bank needs you to sign in again.",
  INVALID_CREDENTIALS: "The sign-in details your bank has on file no longer work.",
  INVALID_MFA: "The security code your bank asked for didn't go through.",
  INVALID_UPDATED_USERNAME: "Your username at the bank changed.",
  ITEM_LOCKED: "Your bank has locked the account. Sign in at your bank to unlock it, then reconnect here.",
  USER_PERMISSION_REVOKED: "Access to this bank was revoked, so it stopped sharing data.",
  ACCESS_NOT_GRANTED: "You didn't grant Finny access to this bank.",
  USER_INPUT_TIMEOUT: "The last reconnect timed out before it finished.",
  ITEM_NOT_SUPPORTED: "Your bank no longer supports this kind of connection.",
  INSUFFICIENT_CREDENTIALS: "Your bank is asking for more than the saved credentials.",
  INSTITUTION_DOWN: "Your bank is down. This usually clears on its own.",
  INSTITUTION_NOT_RESPONDING: "Your bank isn't responding. This usually clears on its own.",
  INSTITUTION_NO_LONGER_SUPPORTED: "This bank is no longer supported.",
};

function connectionAlert(connection: ConnectionData) {
  if (connection.status === "pending_expiration") {
    return {
      title: "This connection expires soon",
      detail:
        "Your bank shares data for a fixed stretch and this one is nearly up.",
    };
  }
  return {
    title: "This connection stopped working",
    detail: connection.errorCode
      ? (errorExplanations[connection.errorCode] ??
        `Your bank reported ${connection.errorCode}.`)
      : "Your bank stopped sharing data with Finny.",
  };
}

function AccountsPage() {
  const connections = useQuery(api.connections.list);
  const notion = useQuery(api.notion.getStatus);
  const running = useQuery(api.connections.activeRuns);
  // One shared Plaid Link instance for the whole page: adding a bank and
  // every card's Reconnect all go through it (multiple usePlaidLink hooks
  // would embed the Plaid script once each).
  const { start: startLink, busy, busyFor } = usePlaidConnect();

  const hasBank = (connections?.length ?? 0) > 0;
  const hasDestination = Boolean(notion?.connected && notion.databases);
  // A connection only gets a lastSyncedAt from a run that finished
  // successfully, which is the same thing as "the first sync worked".
  const hasSynced = connections?.some((c) => c.lastSyncedAt) ?? false;
  const loaded = connections !== undefined && notion !== undefined;
  const showChecklist = loaded && !(hasBank && hasDestination && hasSynced);

  const runByConnection = new Map(
    (running ?? [])
      .filter((run) => run.connectionId)
      .map((run) => [run.connectionId, run]),
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Bank connections synced to Notion
          </p>
        </div>
        <Button
          onClick={() => startLink()}
          disabled={busy}
          className="w-fit"
        >
          <Plus /> Add connection
        </Button>
      </div>

      {loaded && hasBank && !hasDestination ? <NoDestinationBanner /> : null}

      {showChecklist ? (
        <GettingStarted
          hasBank={hasBank}
          hasDestination={hasDestination}
          hasSynced={hasSynced}
          onAddBank={() => startLink()}
          addingBank={busy}
        />
      ) : null}

      {connections === undefined ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : connections.length === 0 ? (
        // The checklist already asks for a bank, with the same button.
        showChecklist ? null : (
          <Card>
            <CardHeader className="justify-items-center text-center">
              <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
                <Landmark className="size-6 text-muted-foreground" />
              </div>
              <CardTitle>No bank connections yet</CardTitle>
              <CardDescription>
                Connect a bank, card, or brokerage through Plaid to start
                syncing accounts, transactions, and investments to Notion.
              </CardDescription>
            </CardHeader>
          </Card>
        )
      ) : (
        connections.map((connection) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            run={runByConnection.get(connection.id)}
            reconnecting={busyFor === connection.id}
            onReconnect={() => startLink(connection.id)}
          />
        ))
      )}

      <SyncHistory />
    </div>
  );
}

// Banks but nowhere to put them is the one dead end the app can land in
// without saying anything: syncs are scheduled, every one of them returns
// early, and the Accounts page looks perfectly healthy.
function NoDestinationBanner() {
  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="flex flex-wrap items-center gap-4 py-4">
        <div className="min-w-64 flex-1">
          <p className="text-sm font-medium">
            Everything is connected but nothing is syncing yet
          </p>
          <p className="text-sm text-muted-foreground">
            Pick a Notion page and the first sync starts straight after.
          </p>
        </div>
        <Button asChild>
          <Link
            to="/notion"
            search={{ connected: undefined, error: undefined }}
          >
            Pick a Notion page <ArrowRight />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// Setup spans two pages and a wait, so each of the three steps reads its own
// state rather than being ticked off by anything the user clicked. Nothing
// is stored: the card is gone once all three are true.
function GettingStarted({
  hasBank,
  hasDestination,
  hasSynced,
  onAddBank,
  addingBank,
}: {
  hasBank: boolean;
  hasDestination: boolean;
  hasSynced: boolean;
  onAddBank: () => void;
  addingBank: boolean;
}) {
  const steps = [
    {
      title: "Connect a bank or brokerage",
      detail: "Plaid handles the sign-in; Finny only ever reads.",
      done: hasBank,
      action: (
        <Button size="sm" onClick={onAddBank} disabled={addingBank}>
          <Plus /> Add connection
        </Button>
      ),
    },
    {
      title: "Connect Notion and create the databases",
      detail: "Pick the page to build the databases in, and what to track.",
      done: hasDestination,
      action: (
        <Button size="sm" asChild>
          <Link
            to="/notion"
            search={{ connected: undefined, error: undefined }}
          >
            Set up Notion
          </Link>
        </Button>
      ),
    },
    {
      title: "First sync",
      detail:
        hasBank && hasDestination
          ? "Running now — the card above shows how far it has got."
          : "Starts on its own once the first two are done.",
      done: hasSynced,
      action: null,
    },
  ];
  const done = steps.filter((step) => step.done).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Finish setting up</CardTitle>
        <CardDescription>
          {done} of {steps.length} done
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-4">
          {steps.map((step, index) => (
            <li key={step.title} className="flex items-start gap-3">
              {step.done ? (
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-primary" />
              ) : (
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground">
                  {index + 1}
                </span>
              )}
              <div className="flex flex-1 flex-col items-start gap-2">
                <div>
                  <p
                    className={
                      step.done
                        ? "text-sm text-muted-foreground"
                        : "text-sm font-medium"
                    }
                  >
                    {step.title}
                  </p>
                  {step.done ? null : (
                    <p className="text-sm text-muted-foreground">
                      {step.detail}
                    </p>
                  )}
                </div>
                {step.done ? null : step.action}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function SyncHistory() {
  const runs = useQuery(api.connections.recentRuns);
  if (!runs || runs.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent syncs</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {runs.map((run) => (
            <SyncRunRow key={run.id} run={run} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type ConnectionData = NonNullable<
  ReturnType<typeof useQuery<typeof api.connections.list>>
>[number];

type AccountData = ConnectionData["accounts"][number];

function RenameAccountDialog({
  account,
  onClose,
}: {
  account: AccountData | null;
  onClose: () => void;
}) {
  const renameAccount = useAction(api.connections.renameAccount);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // Seed the input each time a different account is opened.
  useEffect(() => {
    setName(account?.customName ?? account?.originalName ?? "");
  }, [account]);

  const handleSave = (event: FormEvent) => {
    event.preventDefault();
    if (!account) {
      return;
    }
    setSaving(true);
    renameAccount({ accountId: account.id as Id<"accounts">, name })
      .then(() => {
        toast.success("Account renamed");
        onClose();
      })
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Failed to rename account");
      })
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open={account !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={handleSave}>
          <DialogHeader>
            <DialogTitle>Rename account</DialogTitle>
            <DialogDescription>
              Used in the Notion Accounts database. Empty goes back to your
              bank's name.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              autoFocus
              value={name}
              placeholder={account?.originalName}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ActiveRun = NonNullable<
  ReturnType<typeof useQuery<typeof api.connections.activeRuns>>
>[number];

// Only for the elapsed clock. Everything else on this card comes from
// reactive queries, which update themselves as the sync writes.
function useTicker() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function LiveSyncProgress({
  run,
  firstSync,
}: {
  run: ActiveRun;
  firstSync: boolean;
}) {
  const now = useTicker();
  const stats = run.stats ?? { added: 0, modified: 0, removed: 0 };

  return (
    <div className="mb-5 flex gap-3 rounded-lg border bg-muted/40 p-4">
      <RefreshCw className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">
          {triggerLabels[run.trigger]} in progress ·{" "}
          {formatDuration(Math.max(0, now - run.startedAt))}
        </p>
        <p className="text-sm text-muted-foreground">
          {stats.added} added · {stats.modified} updated · {stats.removed}{" "}
          removed so far
        </p>
        {firstSync ? (
          <p className="text-xs text-muted-foreground">
            A first sync walks up to two years of history — this takes a while,
            and keeps going whether or not this page is open.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ConnectionCard({
  connection,
  run,
  reconnecting,
  onReconnect,
}: {
  connection: ConnectionData;
  run?: ActiveRun;
  reconnecting: boolean;
  onReconnect: () => void;
}) {
  const toggleAccountSync = useMutation(api.connections.toggleAccountSync);
  const removeConnection = useAction(api.plaid.removeConnection);
  const triggerSync = useAction(api.sync.triggerManual);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [renaming, setRenaming] = useState<AccountData | null>(null);
  const problem = connectionAlert(connection);

  const handleSync = () => {
    setSyncing(true);
    triggerSync({ connectionId: connection.id })
      .then(() => toast.success("Sync started"))
      .catch((err: unknown) => {
        console.error(err);
        toast.error(
          err instanceof Error && err.message.includes("destination")
            ? "Set up the Notion destination first"
            : "Failed to start sync",
        );
      })
      .finally(() => setSyncing(false));
  };

  const handleRemove = () => {
    setRemoving(true);
    removeConnection({ connectionId: connection.id })
      .then(() => toast.success(`${connection.institutionName} removed`))
      .catch(() => toast.error("Failed to remove connection"))
      .finally(() => {
        setRemoving(false);
        setConfirmRemove(false);
      });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3 sm:items-center">
          {connection.institutionLogo ? (
            <img
              src={connection.institutionLogo}
              alt=""
              className="size-8 shrink-0 rounded"
            />
          ) : (
            <div className="flex size-8 shrink-0 items-center justify-center rounded bg-muted">
              <Landmark className="size-4 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate">
              {connection.institutionName}
            </CardTitle>
            {connection.lastSyncedAt ? (
              <CardDescription>
                Last synced{" "}
                {new Date(connection.lastSyncedAt).toLocaleString()}
              </CardDescription>
            ) : (
              <CardDescription>Not synced yet</CardDescription>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Badge
              variant={
                connection.status === "active" ? "secondary" : "destructive"
              }
            >
              {statusLabels[connection.status]}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`More for ${connection.institutionName}`}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={syncing} onClick={handleSync}>
                  <RefreshCw /> Sync now
                </DropdownMenuItem>
                <DropdownMenuItem disabled={reconnecting} onClick={onReconnect}>
                  <Wrench /> Reconnect
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setConfirmRemove(true)}
                >
                  <Trash2 /> Remove…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {connection.status !== "active" ? (
          <div className="mb-5 flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="flex flex-1 flex-col items-start gap-3">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">{problem.title}</p>
                <p className="text-sm text-muted-foreground">
                  {problem.detail}
                </p>
                <p className="text-xs text-muted-foreground">
                  Nothing reaches Notion until it's reconnected.
                  {connection.errorCode ? (
                    <>
                      {" "}
                      <span className="font-mono">{connection.errorCode}</span>
                    </>
                  ) : null}
                </p>
              </div>
              <Button size="sm" disabled={reconnecting} onClick={onReconnect}>
                <Wrench /> {reconnecting ? "Opening…" : "Reconnect"}
              </Button>
            </div>
          </div>
        ) : null}
        {run ? (
          <LiveSyncProgress
            run={run}
            firstSync={connection.lastSyncedAt === undefined}
          />
        ) : null}
        <ul className="flex flex-col gap-3">
          {connection.accounts.map((account) => (
            <li key={account.id} className="flex items-center gap-3 text-sm">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span>
                    {account.name}
                    {account.mask ? (
                      <span className="text-muted-foreground">
                        {" "}
                        *{account.mask}
                      </span>
                    ) : null}
                  </span>
                  {account.isNew ? (
                    <Badge variant="outline" className="text-xs font-normal">
                      New
                    </Badge>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {account.subtype ?? account.type}
                  {account.isNew
                    ? " · found after linking, turn on to sync it"
                    : null}
                  {account.catchingUp
                    ? " · catching up on missed history"
                    : null}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={`Rename ${account.name}`}
                onClick={() => setRenaming(account)}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Switch
                checked={account.syncEnabled}
                aria-label={`Sync ${account.name} to Notion`}
                onCheckedChange={(enabled) =>
                  void toggleAccountSync({
                    accountId: account.id as Id<"accounts">,
                    enabled,
                  })
                    // Said here rather than in a footnote nobody reads: it is
                    // only news at the moment the switch moves.
                    .then(() =>
                      toast.success(
                        enabled
                          ? "Syncing — the next run fills in the history it missed"
                          : "Paused — rows already in Notion stay put",
                      ),
                    )
                    .catch(() => toast.error("Failed to update account"))
                }
              />
            </li>
          ))}
        </ul>
      </CardContent>

      <RenameAccountDialog
        account={renaming}
        onClose={() => setRenaming(null)}
      />

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Remove {connection.institutionName}?
            </DialogTitle>
            <DialogDescription>
              Syncing stops and the token is deleted. Rows already in Notion
              stay.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRemove(false)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing ? "Removing…" : "Remove connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
