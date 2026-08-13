import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { routeTree } from "./routeTree.gen";

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
        to provision the backend — see SETUP.md.
      </p>
    </div>,
  );
} else {
  const convex = new ConvexReactClient(convexUrl);
  root.render(
    <StrictMode>
      <ConvexAuthProvider client={convex}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ConvexAuthProvider>
    </StrictMode>,
  );
}
