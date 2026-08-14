import { useAuthActions } from "@convex-dev/auth/react";
import { createFileRoute } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { Trash2, Unplug } from "lucide-react";
import { useState } from "react";
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
  const banks = count ?? 0;

  const handleDisconnect = () => {
    setBusy(true);
    disconnectAll()
      .then((result) => {
        if (result.revokeFailures.length > 0) {
          // The tokens are gone from Finny regardless; what failed is the
          // request asking Plaid to stop, which the user may want to chase.
          toast.warning(
            `Removed ${result.removed} ${result.removed === 1 ? "bank" : "banks"}, but Plaid rejected the revocation for ${result.revokeFailures.join(", ")} — check your Plaid dashboard.`,
          );
        } else {
          toast.success(
            `Disconnected ${result.removed} ${result.removed === 1 ? "bank" : "banks"}`,
          );
        }
        setOpen(false);
      })
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Could not disconnect your banks — try again");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium">Disconnect all banks</div>
        <p className="text-sm text-muted-foreground">
          {count === undefined
            ? "Loading…"
            : banks === 0
              ? "No banks are connected."
              : `Revokes ${banks} bank ${banks === 1 ? "connection" : "connections"} at Plaid and deletes their tokens.`}
        </p>
      </div>
      <Button
        variant="outline"
        disabled={banks === 0}
        onClick={() => setOpen(true)}
      >
        <Unplug /> Disconnect all
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Disconnect ${banks === 1 ? "your bank" : `all ${banks} banks`}?`}
        confirmLabel="Disconnect all"
        busyLabel="Disconnecting…"
        busy={busy}
        onConfirm={handleDisconnect}
      >
        <p>
          Finny asks Plaid to remove each Item, which ends Plaid's access to
          those accounts, and then deletes the access tokens and account
          metadata it was holding. Syncing stops immediately.
        </p>
        <p>
          Rows already in your Notion databases stay exactly as they are —
          Finny never deletes from your workspace, it just stops updating
          them. Linking a bank again later starts a fresh connection.
        </p>
        <p>
          Plaid does not refund production Item slots when an Item is deleted,
          so this frees no capacity on the Plaid plan; a later relink consumes
          a new Item.
        </p>
        <p>
          If Plaid rejects one of the removals, Finny still deletes its own
          copy of that token and names the bank so you can check it in the
          Plaid dashboard.
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
          Your pages, databases, and every row already synced stay in Notion.
          Finny drops the stored token and its map of which databases it
          created, so connecting again builds a fresh set of databases even in
          the same workspace — the old ones are left where they are.
        </p>
        <p>
          Notion's API has no endpoint for revoking a token, so dropping our
          copy is all Finny can do from here. To cut the integration off from
          Notion's side as well, remove Finny under Settings → My connections
          in your Notion workspace.
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
          "Account deleted, but Finny could not reach Plaid to revoke your banks — remove them from your Plaid dashboard.",
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
          Finny asks Plaid to revoke every bank connection, then deletes
          everything it holds about you: your profile, Plaid and Notion access
          tokens, account and destination configuration, the map of provider
          IDs to Notion pages, sync run logs, and your sign-in sessions. There
          is no undo and no grace period.
        </p>
        <p className="text-foreground">
          Everything already synced to Notion stays in Notion — it is your
          data in your workspace, and Finny never deletes from it. The page map
          goes with your account, so if you ever sign up again and sync to the
          same page, every row will be created a second time: you will have
          duplicates unless you clear the old databases yourself first.
        </p>
        <p>
          Two things survive: access-password attempt records, which are keyed
          by IP address rather than by account and are kept to limit abuse, and
          encrypted infrastructure backups, which expire on the hosting
          provider's own rotation schedule.
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
