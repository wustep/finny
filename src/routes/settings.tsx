import { useAuthActions } from "@convex-dev/auth/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { connectionCount } from "@/lib/plural";
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
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { signOut } = useAuthActions();
  const viewer = useQuery(api.users.viewer);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>{viewer?.email}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-4">
          <Separator />
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </CardContent>
      </Card>

      <ConnectionsCard />
      <DangerZoneCard />
    </div>
  );
}

// One confirm dialog shape for all three actions: the copy is the point, so
// it gets the room, and every one of them can fail halfway.
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  confirmDisabled,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-3 text-left">{children}</div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionsCard() {
  const connections = useQuery(api.connections.list);
  const notion = useQuery(api.notion.getStatus);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connections</CardTitle>
        <CardDescription>
          Hand back the access Finny holds. Whatever has already been synced
          stays in your Notion workspace either way.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <DisconnectBanksRow count={connections?.length} />
        <Separator />
        <DisconnectNotionRow
          connected={notion?.connected === true}
          workspaceName={notion?.connected ? notion.workspaceName : undefined}
        />
      </CardContent>
    </Card>
  );
}

function DisconnectBanksRow({ count }: { count?: number }) {
  const disconnectAll = useAction(api.plaid.disconnectAllBanks);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const linked = count ?? 0;

  const handleDisconnect = () => {
    setBusy(true);
    disconnectAll()
      .then((result) => {
        if (result.revokeFailures.length > 0) {
          // The tokens are gone from Finny regardless; what failed is the
          // request asking Plaid to stop, which the user may want to chase.
          toast.warning(
            `Removed ${connectionCount(result.removed)}, but Plaid rejected the revocation for ${result.revokeFailures.join(", ")} — check your Plaid dashboard.`,
          );
        } else {
          toast.success(
            `Disconnected ${connectionCount(result.removed)}`,
          );
        }
        setOpen(false);
      })
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Could not disconnect — try again");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium">Disconnect everything</div>
        <p className="text-sm text-muted-foreground">
          {count === undefined
            ? "Loading…"
            : linked === 0
              ? "Nothing is connected."
              : `Revokes ${connectionCount(linked)} at Plaid and deletes their tokens.`}
        </p>
      </div>
      <Button
        variant="outline"
        disabled={linked === 0}
        onClick={() => setOpen(true)}
      >
        <Unplug /> Disconnect all
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Disconnect ${
          linked === 1 ? "your connection" : `all ${linked} connections`
        }?`}
        confirmLabel="Disconnect all"
        busyLabel="Disconnecting…"
        busy={busy}
        onConfirm={handleDisconnect}
      >
        <p>
          Ends Plaid's access to these accounts and deletes their tokens; syncing
          stops now. Everything already in Notion stays. Relinking later uses
          a new Plaid Item — production slots are not refunded.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function DisconnectNotionRow({
  connected,
  workspaceName,
}: {
  connected: boolean;
  workspaceName?: string;
}) {
  const disconnect = useMutation(api.notion.disconnect);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleDisconnect = () => {
    setBusy(true);
    disconnect()
      .then(() => {
        toast.success("Notion disconnected");
        setOpen(false);
      })
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Failed to disconnect Notion");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium">Disconnect Notion</div>
        <p className="text-sm text-muted-foreground">
          {connected
            ? `Forgets the token for ${workspaceName ?? "your workspace"} and the databases Finny made.`
            : "Notion is not connected."}
        </p>
      </div>
      <Button
        variant="outline"
        disabled={!connected}
        onClick={() => setOpen(true)}
      >
        <Unplug /> Disconnect
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Disconnect Notion?"
        confirmLabel="Disconnect"
        busyLabel="Disconnecting…"
        busy={busy}
        onConfirm={handleDisconnect}
      >
        <p>
          Everything already synced stays in Notion. Finny drops the token and
          forgets which databases it made, so connecting again builds a second
          set — use Reconnect on the Notion page if you only need a fresh
          token. To cut the integration off from Notion's side too, remove
          Finny under Settings → My connections there.
        </p>
      </ConfirmDialog>
    </div>
  );
}

// Deleting the account is the only irreversible thing in the app, and its
// worst consequence lands somewhere the app cannot reach: the page map goes,
// so a future account syncing to the same page duplicates every row.
function DangerZoneCard() {
  const disconnectAll = useAction(api.plaid.disconnectAllBanks);
  const deleteAccount = useMutation(api.users.deleteAccount);
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  const handleDelete = async () => {
    setBusy(true);
    try {
      // Revoke at Plaid first, while the tokens still exist. A failure here
      // is reported but does not hold up the deletion — the alternative is an
      // account the user asked to delete surviving a Plaid outage.
      const revoked = await disconnectAll().catch((error: unknown) => {
        console.error(error);
        return null;
      });
      // A long history takes more than one transaction to erase; the rest is
      // already scheduled by the time this returns.
      const { done } = await deleteAccount();
      if (revoked === null) {
        toast.warning(
          "Account deleted, but Finny could not reach Plaid to revoke your connections — remove them from your Plaid dashboard.",
        );
      } else if (revoked.revokeFailures.length > 0) {
        toast.warning(
          `Account deleted. Plaid rejected the revocation for ${revoked.revokeFailures.join(", ")} — check your Plaid dashboard.`,
        );
      } else {
        toast.success(
          done
            ? "Account deleted"
            : "Account deleted — the last of your sync bookkeeping is being erased now",
        );
      }
      await signOut();
    } catch (error) {
      console.error(error);
      toast.error("Could not delete your account — try again");
      setBusy(false);
    }
  };

  return (
    <Card className="border-destructive">
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Revokes every connection and erases everything Finny stores about
          you. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <Trash2 /> Delete my account
        </Button>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setTyped("");
        }}
        title="Delete your account?"
        confirmLabel="Delete my account"
        busyLabel="Deleting…"
        busy={busy}
        confirmDisabled={typed.trim().toUpperCase() !== "DELETE"}
        onConfirm={() => void handleDelete()}
      >
        <p>
          This revokes every connection at Plaid and deletes everything Finny
          stores
          about you — tokens, configuration, and the map that keeps Notion rows
          in sync. There is no undo.
        </p>
        <p className="text-foreground">
          Rows already in Notion are yours and stay. The page map goes with
          your account, so syncing to the same page from a new account would
          create every row a second time.
        </p>
        <p>
          <Link to="/policy" className="underline underline-offset-4">
            What survives and why
          </Link>
        </p>
        <div className="flex flex-col gap-2 pt-1">
          <Label htmlFor="confirm-delete" className="text-foreground">
            Type DELETE to confirm
          </Label>
          <Input
            id="confirm-delete"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="DELETE"
            disabled={busy}
          />
        </div>
      </ConfirmDialog>
    </Card>
  );
}
