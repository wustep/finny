import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { routeTree } from "./routeTree.gen";

// Matches the pre-paint script in index.html, which sets the same class from
// the same key before React exists.
const THEME_STORAGE_KEY = "finny.theme";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

const queryClient = new QueryClient();

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = createRoot(document.getElementById("root")!);

if (!convexUrl) {
  root.render(
    <div style={{ fontFamily: "system-ui", padding: "4rem", maxWidth: 480 }}>
      <h1>Finny isn&apos;t configured yet</h1>
      <p>
        <code>VITE_CONVEX_URL</code> is missing. Run <code>npx convex dev</code>{" "}
        to provision the backend — see README.md.
      </p>
    </div>,
  );
} else {
  const convex = new ConvexReactClient(convexUrl);
  root.render(
    <StrictMode>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        storageKey={THEME_STORAGE_KEY}
        // Colours are the only thing the class switches, and animating every
        // one of them at once reads as a stutter rather than a transition.
        disableTransitionOnChange
      >
        <ConvexAuthProvider client={convex}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ConvexAuthProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
