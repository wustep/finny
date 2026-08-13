import { useAuthActions } from "@convex-dev/auth/react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Landmark, LogOut, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { AppIcon } from "@/components/app-icon";
import { UNLOCKED_FLAG } from "@/components/access-gate";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const navItems = [
  { to: "/", label: "Accounts", icon: Landmark, exact: true },
  { to: "/notion", label: "Notion", icon: NotionGlyph, exact: false },
  { to: "/settings", label: "Settings", icon: Settings, exact: false },
] as const;

function NotionGlyph({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden>
      N
    </span>
  );
}

// Chrome for public pages (e.g. /policy). Signed-in + unlocked users get
// the full app shell; a device that unlocked before but is signed out gets
// a Log in button; everyone else sees the logo alone.
export function PublicShell({ children }: { children: ReactNode }) {
  const viewer = useQuery(api.users.viewer);
  const unlockedBefore = (() => {
    try {
      return localStorage.getItem(UNLOCKED_FLAG) === "1";
    } catch {
      return false;
    }
  })();

  if (viewer?.accessGranted) {
    return <AppShell>{children}</AppShell>;
  }
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <AppIcon className="size-6 rounded-md" />
            Finny
          </Link>
          {viewer === null && unlockedBefore ? (
            <Button asChild size="sm" variant="outline" className="ml-auto">
              <Link to="/">Log in</Link>
            </Button>
          ) : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { signOut } = useAuthActions();
  const viewer = useQuery(api.users.viewer);

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-6 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <AppIcon className="size-6 rounded-md" />
            Finny
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full">
                  {viewer?.image ? (
                    <img
                      src={viewer.image}
                      alt=""
                      className="size-7 rounded-full"
                    />
                  ) : (
                    <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {viewer?.name?.[0] ?? "?"}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="font-normal">
                  <div className="text-sm font-medium">{viewer?.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {viewer?.email}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void signOut()}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
