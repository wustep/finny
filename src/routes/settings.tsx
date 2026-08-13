import { useAuthActions } from "@convex-dev/auth/react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    </div>
  );
}
