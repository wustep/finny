import { createFileRoute } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import {
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
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { usePlaidConnect } from "@/components/plaid-link";
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
  const { start: startLink, busy } = usePlaidConnect();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Bank connections synced to Notion
          </p>
        </div>
        <Button onClick={startLink} disabled={busy}>
          <Plus /> Add connection
        </Button>
      </div>

      {connections === undefined ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : connections.length === 0 ? (
        <Card>
          <CardHeader className="items-center text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
              <Landmark className="size-6 text-muted-foreground" />
            </div>
            <CardTitle>No bank connections yet</CardTitle>
            <CardDescription>
              Connect a bank through Plaid to start syncing accounts,
              transactions, and investments to Notion.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        connections.map((connection) => (
          <ConnectionCard key={connection.id} connection={connection} />
        ))
      )}

      <SyncHistory />
    </div>
  );
}

type RunData = NonNullable<
  ReturnType<typeof useQuery<typeof api.connections.recentRuns>>
>[number];

function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

// "+3 / ~1 / −0", plus what a run gave up on. Skipped rows are the ones
// Notion refused often enough that the sync moved past them, so they are
// worth naming rather than folding into the other counts.
function statsSummary(stats: RunData["stats"]) {
  if (!stats) {
    return null;
  }
  const { added, modified, removed, skipped } = stats;
  if (added + modified + removed + (skipped ?? 0) === 0) {
    return null;
  }
  return `+${added} / ~${modified} / −${removed}${
    skipped ? ` · ${skipped} skipped` : ""
  }`;
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

function SyncRunRow({ run }: { run: RunData }) {
  const [expanded, setExpanded] = useState(false);
  const failed = run.status === "error";
  const summary = statsSummary(run.stats);
  const duration = run.finishedAt
    ? formatDuration(run.finishedAt - run.startedAt)
    : null;

  return (
    <li
      className={
        failed
          ? "flex flex-col gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
          : "flex flex-col gap-1.5 px-3 py-2 text-sm"
      }
    >
      <div className="flex items-center gap-3">
        <Badge
          variant={
            failed ? "destructive" : run.status === "running" ? "outline" : "secondary"
          }
        >
          {run.status}
        </Badge>
        <span className="flex-1">
          {run.institutionName}
          <span className="text-muted-foreground"> · {run.trigger}</span>
          {summary ? (
            <span className="text-muted-foreground"> · {summary}</span>
          ) : null}
          {duration ? (
            <span className="text-muted-foreground"> · {duration}</span>
          ) : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {new Date(run.startedAt).toLocaleString()}
        </span>
      </div>
      {run.error ? (
        <button
          type="button"
          title={run.error}
          onClick={() => setExpanded((open) => !open)}
          className={`text-left text-xs text-destructive ${
            expanded ? "" : "line-clamp-2"
          }`}
        >
          {run.error}
        </button>
      ) : null}
    </li>
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
              This name is used in the Notion Accounts database. Leave it
              empty to go back to the name from your bank.
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

function ConnectionCard({ connection }: { connection: ConnectionData }) {
  const toggleAccountSync = useMutation(api.connections.toggleAccountSync);
  const removeConnection = useAction(api.plaid.removeConnection);
  const triggerSync = useAction(api.sync.triggerManual);
  const { start: startReconnect, busy: reconnecting } = usePlaidConnect({
    connectionId: connection.id,
  });
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
        <div className="flex items-center gap-3">
          {connection.institutionLogo ? (
            <img
              src={connection.institutionLogo}
              alt=""
              className="size-8 rounded"
            />
          ) : (
            <div className="flex size-8 items-center justify-center rounded bg-muted">
              <Landmark className="size-4 text-muted-foreground" />
            </div>
          )}
          <div className="flex-1">
            <CardTitle>{connection.institutionName}</CardTitle>
            {connection.lastSyncedAt ? (
              <CardDescription>
                Last synced{" "}
                {new Date(connection.lastSyncedAt).toLocaleString()}
              </CardDescription>
            ) : (
              <CardDescription>Not synced yet</CardDescription>
            )}
          </div>
          <Badge
            variant={
              connection.status === "active" ? "secondary" : "destructive"
            }
          >
            {statusLabels[connection.status]}
          </Badge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={syncing} onClick={handleSync}>
                <RefreshCw /> Sync now
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={reconnecting}
                onClick={startReconnect}
              >
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
                  Nothing from this bank reaches Notion until it's
                  reconnected. Banks that sign you in through their own site
                  expire every few months, so this is routine.
                  {connection.errorCode ? (
                    <>
                      {" "}
                      <span className="font-mono">{connection.errorCode}</span>
                    </>
                  ) : null}
                </p>
              </div>
              <Button
                size="sm"
                disabled={reconnecting}
                onClick={startReconnect}
              >
                <Wrench /> {reconnecting ? "Opening…" : "Reconnect"}
              </Button>
            </div>
          </div>
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
                  }).catch(() => toast.error("Failed to update account"))
                }
              />
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Switching an account off pauses its sync — rows already in Notion
          stay put, but nothing new is added while it's off. Switch it back on
          and the next sync fills in the history it missed.
        </p>
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
              Finny will disconnect from Plaid and stop syncing these accounts.
              Data already synced to Notion stays in Notion.
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
