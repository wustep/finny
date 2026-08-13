import { useAuthToken } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

// Signed-in users must also present the shared access password once before
// the app (and its Plaid/Notion actions, which enforce this server-side)
// unlocks for them.
// Remembers (per device) that this browser has unlocked the app before, so
// public pages can offer a "Log in" button to returning users only.
export const UNLOCKED_FLAG = "finny_unlocked";

export function AccessGuard({ children }: { children: ReactNode }) {
  const viewer = useQuery(api.users.viewer);
  const accessGranted = viewer?.accessGranted === true;
  useEffect(() => {
    if (accessGranted) {
      try {
        localStorage.setItem(UNLOCKED_FLAG, "1");
      } catch {
        // localStorage unavailable (private mode) — nonessential.
      }
    }
  }, [accessGranted]);
  if (viewer === undefined) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  if (viewer && !viewer.accessGranted) {
    return <AccessGate />;
  }
  return <>{children}</>;
}

// The redeem call goes over HTTP (not the Convex websocket) so the server
// can see the caller's IP for the 3-strikes ban.
const CONVEX_SITE_URL = (import.meta.env.VITE_CONVEX_URL as string).replace(
  ".convex.cloud",
  ".convex.site",
);

function AccessGate() {
  const token = useAuthToken();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!password || !token) {
      return;
    }
    setBusy(true);
    fetch(`${CONVEX_SITE_URL}/access/redeem`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as {
          result?: string;
        } | null;
        if (response.ok) {
          // users.viewer re-runs reactively and unlocks the app.
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
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
            />
            <Button type="submit" disabled={busy || !password}>
              {busy ? "Checking…" : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
