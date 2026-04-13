import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@devlet/shared";

const DEVLET_SERVER = process.env["DEVLET_SERVER"] ?? "http://localhost:3001";
const DEVLET_AUTH_TOKEN = process.env["DEVLET_AUTH_TOKEN"] ?? "";

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${DEVLET_SERVER}/trpc`,
      headers() {
        return DEVLET_AUTH_TOKEN
          ? { authorization: `Bearer ${DEVLET_AUTH_TOKEN}` }
          : {};
      },
    }),
  ],
});
