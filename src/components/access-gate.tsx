import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "@/lib/notify";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

// Remembers (per device) that this browser has unlocked the app before, so
// public pages can offer a "Log in" button to returning users only, and a
// signed-out visitor who already entered the password sees sign-in next.
export const UNLOCKED_FLAG = "finny_unlocked";

// Ticket from /access/redeem when the visitor is not signed in yet. Survives
// the Google redirect in the same tab; claimed onto the user afterwards.
const GRANT_KEY = "finny_access_grant";

export function readUnlockedFlag(): boolean {
  try {
    return localStorage.getItem(UNLOCKED_FLAG) === "1";
  } catch {
    return false;
  }
}

function writeUnlockedFlag(): void {
  try {
    localStorage.setItem(UNLOCKED_FLAG, "1");
  } catch {
    // localStorage unavailable (private mode) — nonessential.
  }
}

function readGrant(): string | null {
  try {
    return sessionStorage.getItem(GRANT_KEY);
  } catch {
    return null;
  }
}

function writeGrant(token: string): void {
  try {
    sessionStorage.setItem(GRANT_KEY, token);
  } catch {
    // sessionStorage unavailable — they will see the password screen again
    // after sign-in and redeem against the signed-in user.
  }
}

function clearGrant(): void {
  try {
    sessionStorage.removeItem(GRANT_KEY);
  } catch {
    // nonessential
  }
}

function GateSkeleton() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <Skeleton className="h-8 w-48" />
    </div>
  );
}

// Signed-out visitors: password first, then the children (sign-in). Skipped
// when ACCESS_PASSWORD is unset so local testers can still reach the app.
export function InviteGuard({ children }: { children: ReactNode }) {
  const configured = useQuery(api.access.isConfigured);
  const [unlocked, setUnlocked] = useState(readUnlockedFlag);

  if (configured === undefined) {
    return <GateSkeleton />;
  }
  if (!configured || unlocked) {
    return <>{children}</>;
  }
  return (
    <AccessGate
      onUnlocked={() => {
        writeUnlockedFlag();
        setUnlocked(true);
      }}
    />
  );
}

// Signed-in users: claim a pre-sign-in ticket if we have one, otherwise ask
// for the password (and let them sign out). Plaid/Notion actions still
// enforce the user flag server-side.
export function AccessGuard({ children }: { children: ReactNode }) {
  const viewer = useQuery(api.users.viewer);
  const claimGrant = useMutation(api.access.claimGrant);
  const [claimState, setClaimState] = useState<"idle" | "pending" | "failed">(
    "idle",
  );
  const accessGranted = viewer?.accessGranted === true;
  const grant = readGrant();

  useEffect(() => {
    if (accessGranted) {
      writeUnlockedFlag();
      clearGrant();
    }
  }, [accessGranted]);

  useEffect(() => {
    if (!viewer || viewer.accessGranted || claimState !== "idle") {
      return;
    }
    if (!grant) {
      setClaimState("failed");
      return;
    }
    setClaimState("pending");
    void claimGrant({ token: grant })
      .then((outcome) => {
        clearGrant();
        if (outcome.result !== "ok") {
          setClaimState("failed");
        }
      })
      .catch(() => {
        clearGrant();
        setClaimState("failed");
      });
  }, [viewer, grant, claimState, claimGrant]);

  if (viewer === undefined) {
    return <GateSkeleton />;
  }
  if (accessGranted) {
    return <>{children}</>;
  }
  // Stay on the skeleton through the claim, including after the ticket is
  // cleared from sessionStorage and before users.viewer flips.
  if (claimState === "pending" || (grant && claimState === "idle")) {
    return <GateSkeleton />;
  }
  return <AccessGate showSignOut />;
}

// The redeem call goes over HTTP (not the Convex websocket) so the server
// can see the caller's IP for the 3-strikes ban.
const CONVEX_SITE_URL = (import.meta.env.VITE_CONVEX_URL as string).replace(
  ".convex.cloud",
  ".convex.site",
);

function AccessGate({
  onUnlocked,
  showSignOut = false,
}: {
  onUnlocked?: () => void;
  showSignOut?: boolean;
}) {
  const { signOut } = useAuthActions();
  const token = useAuthToken();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!password) {
      return;
    }
    // Signed-in redeem needs the bearer token so the user flag is set in
    // the same request. Wait for it rather than issuing a leftover ticket.
    if (showSignOut && !token) {
      return;
    }
    setBusy(true);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    fetch(`${CONVEX_SITE_URL}/access/redeem`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password }),
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as {
          result?: string;
          grant?: string;
        } | null;
        if (response.ok) {
          if (typeof data?.grant === "string") {
            writeGrant(data.grant);
          }
          writeUnlockedFlag();
          onUnlocked?.();
          return;
        }
        if (data?.result === "banned") {
          toast.error("Too many wrong attempts — this IP is now blocked.");
        } else if (data?.result === "unconfigured") {
          toast.error("The access password isn't configured yet");
        } else {
          toast.error("Wrong password");
        }
      })
      .catch(() => toast.error("Network error — try again"))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
            <KeyRound className="size-6" />
          </div>
          <CardTitle>Access password</CardTitle>
          <CardDescription>
            Finny is invite-only. Enter the access password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="access-password">Password</Label>
              <Input
                id="access-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              disabled={busy || !password || (showSignOut && !token)}
            >
              {busy ? "Checking…" : "Unlock"}
            </Button>
            {showSignOut ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            ) : (
              <p className="text-center text-xs text-muted-foreground">
                <Link to="/policy" className="underline underline-offset-4">
                  Privacy
                </Link>
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
