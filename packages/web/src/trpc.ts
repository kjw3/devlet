import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import { QueryClient } from "@tanstack/react-query";
import React from "react";
import { apiFetch, retryQuery } from "./lib/api-transport.js";
import type { AppRouter } from "@devlet/shared";

/**
 * Two transport lanes over the same router:
 *
 * - `trpc` — latency-sensitive queries (session, agent list/detail/health) and
 *   all mutations. These must never wait behind slow platform inventory.
 * - `trpcInventory` — slow platform inventory and log queries (platform status,
 *   images, disk capacity, tailscale, agent logs). Batching these separately
 *   means a 45 s Komodo probe cannot hold an agent list response hostage in a
 *   shared batch barrier.
 *
 * Both lanes share auth headers and the session-expiry handling in apiFetch.
 */
export const trpc = createTRPCReact<AppRouter>();
export const trpcInventory = createTRPCReact<AppRouter>();
export const DEVLET_AUTH_STORAGE_KEY = "devlet.auth.token";

function getStoredAuthToken(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(DEVLET_AUTH_STORAGE_KEY) ?? "";
}

function createLaneClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: "/trpc",
        fetch: (input, init) => apiFetch(input, init as RequestInit | undefined),
        headers() {
          const token = getStoredAuthToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
      }),
    ],
  });
}

const trpcClient = createLaneClient();
const trpcInventoryClient = createLaneClient();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: retryQuery,
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
      // Polling pauses while the tab is hidden; reconnect/focus refetches.
      refetchIntervalInBackground: false,
    },
  },
});

export function TrpcProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(trpc.Provider, {
      client: trpcClient,
      queryClient,
      children,
    }),
    React.createElement(trpcInventory.Provider, {
      client: trpcInventoryClient,
      queryClient,
      children,
    })
  );
}
