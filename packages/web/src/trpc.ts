import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import { QueryClient } from "@tanstack/react-query";
import React from "react";
import type { AppRouter } from "@devlet/shared";

export const trpc = createTRPCReact<AppRouter>();
export const DEVLET_AUTH_STORAGE_KEY = "devlet.auth.token";

function getStoredAuthToken(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(DEVLET_AUTH_STORAGE_KEY) ?? "";
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/trpc",
      headers() {
        const token = getStoredAuthToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});

export function TrpcProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(trpc.Provider, {
    client: trpcClient,
    queryClient,
    children,
  });
}
