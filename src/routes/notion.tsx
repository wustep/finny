import { createFileRoute } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { ExternalLink, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

function NotionPage() {
  const { error } = Route.useSearch();
  const status = useQuery(api.notion.getStatus);
  const startOAuth = useAction(api.notion.startOAuth);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (error === "oauth_denied") {
      toast.error("Notion connection was cancelled");
    } else if (error === "oauth_failed") {
      toast.error("Notion connection failed — try again");
    }
  }, [error]);

  const handleConnect = () => {
    setConnecting(true);
    startOAuth({ origin: window.location.origin })
      .then((url) => {
        window.location.href = url;
      })
      .catch((err: unknown) => {
        console.error(err);
        toast.error(
          "Could not start the Notion connection — are the Notion OAuth keys set?",
        );
        setConnecting(false);
      });
  };

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
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? "Redirecting…" : "Connect Notion"}
            </Button>
          </CardHeader>
        </Card>
      ) : !status.databases ? (
        <SetupCard modules={status.modules} />
      ) : (
        <DestinationCard status={status} />
      )}
    </div>
  );
}

function SetupCard({
  modules: initialModules,
}: {
  modules: { balances: boolean; spending: boolean; investments: boolean };
}) {
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

  const moduleRows = useMemo(
    () =>
      [
        {
          key: "balances" as const,
          label: "Account balances",
          detail: "Bank Connections, Accounts, Balance History",
        },
        {
          key: "spending" as const,
          label: "Spending",
          detail: "Transactions, Categories",
        },
        {
          key: "investments" as const,
          label: "Investments",
          detail: "Securities, Holdings, Investment Transactions",
        },
      ] satisfies Array<{
        key: keyof typeof modules;
        label: string;
        detail: string;
      }>,
    [],
  );

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
          {moduleRows.map((row) => (
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
}: {
  status: {
    workspaceName?: string;
    startDate?: string;
    databases?: Record<string, string>;
  };
}) {
  const disconnect = useMutation(api.notion.disconnect);
  const databases = status.databases ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle>{status.workspaceName ?? "Notion workspace"}</CardTitle>
        <CardDescription>
          Databases are ready. Syncing engine arrives in the next phase —
          connected banks will start filling these in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2">
          {Object.entries(databases).map(([key, id]) => (
            <li key={key}>
              <a
                href={`https://notion.so/${id.replaceAll("-", "")}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
              >
                {DATABASE_LABELS[key] ?? key}
                <ExternalLink className="size-3.5 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>
        {status.startDate ? (
          <p className="text-sm text-muted-foreground">
            Syncing history from {status.startDate}
          </p>
        ) : null}
        <Button
          variant="outline"
          className="w-fit"
          onClick={() =>
            void disconnect().then(() => toast.success("Notion disconnected"))
          }
        >
          <Unplug /> Disconnect
        </Button>
      </CardContent>
    </Card>
  );
}
