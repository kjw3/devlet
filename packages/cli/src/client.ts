import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@devlet/shared";

const DEVLET_SERVER = process.env["DEVLET_SERVER"] ?? "http://localhost:3001";

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${DEVLET_SERVER}/trpc`,
    }),
  ],
});
