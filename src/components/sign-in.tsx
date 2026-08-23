import { useAuthActions } from "@convex-dev/auth/react";
import { Link } from "@tanstack/react-router";
import { Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/notify";
import { AppIcon } from "@/components/app-icon";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Local-only shortcut past Google. The secret is read from .env.local,
// which is gitignored and never set in Vercel — so this button is absent
// from deployed builds, and the backend rejects the provider without it.
const TEST_LOGIN_SECRET = import.meta.env.VITE_TEST_LOGIN_SECRET as
  | string
  | undefined;

export function SignIn() {
  const { signIn } = useAuthActions();
  // signIn hits a Convex action to mint the OAuth URL before redirecting —
  // on a cold start that's a few seconds of dead air, so show progress.
  // Stays true on success: the page is on its way to Google.
  const [pending, setPending] = useState(false);
  const [testPending, setTestPending] = useState(false);

  const handleSignIn = () => {
    setPending(true);
    signIn("google", { redirectTo: window.location.origin }).catch(() => {
      setPending(false);
      toast.error("Couldn't start sign-in — try again");
    });
  };

  const handleTestSignIn = () => {
    if (!TEST_LOGIN_SECRET) {
      return;
    }
    setTestPending(true);
    signIn("test", { secret: TEST_LOGIN_SECRET })
      .catch(() => {
        toast.error("Test login rejected — is TEST_LOGIN_SECRET set?");
      })
      .finally(() => setTestPending(false));
  };

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <AppIcon className="mx-auto mb-2 size-12 rounded-xl" />
          <CardTitle>Finny</CardTitle>
          <CardDescription>
            Sync your financial data to Notion
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button className="w-full" onClick={handleSignIn} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <GoogleIcon />
            )}
            Continue with Google
          </Button>
          {TEST_LOGIN_SECRET ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={handleTestSignIn}
              disabled={testPending}
            >
              {testPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Wrench className="size-4" aria-hidden />
              )}
              Continue as tester
            </Button>
          ) : null}
          <p className="text-center text-xs text-muted-foreground">
            Invite-only. Sign in to continue.{" "}
            <Link to="/policy" className="underline underline-offset-4">
              Privacy
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="currentColor"
        d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81"
      />
    </svg>
  );
}
