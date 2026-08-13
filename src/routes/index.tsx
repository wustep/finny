import { createFileRoute } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Landmark,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";
import { useState } from "react";
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
            <li
              key={run.id}
              className="flex items-center gap-3 text-sm"
            >
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
                {run.stats &&
                run.stats.added + run.stats.modified + run.stats.removed > 0 ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · +{run.stats.added} / ~{run.stats.modified} / −
                    {run.stats.removed}
                  </span>
                ) : null}
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

type ConnectionData = NonNullable<
  ReturnType<typeof useQuery<typeof api.connections.list>>
>[number];

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
        <ul className="flex flex-col gap-3">
          {connection.accounts.map((account) => (
            <li key={account.id} className="flex items-center gap-3 text-sm">
              <div className="flex-1">
                <div>
                  {account.name}
                  {account.mask ? (
                    <span className="text-muted-foreground"> *{account.mask}</span>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {account.subtype ?? account.type}
                </div>
              </div>
              <Switch
                checked={account.syncEnabled}
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
      </CardContent>

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
