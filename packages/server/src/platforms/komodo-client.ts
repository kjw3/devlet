import "./localstorage-shim.js"; // MUST be first — installs localStorage before komodo_client is evaluated
import { KomodoClient } from "komodo_client";
import type { InitOptions } from "komodo_client";
import { config as appConfig } from "../config.js";

/** The client object returned by the `KomodoClient` factory. */
export type Komodo = ReturnType<typeof KomodoClient>;

let client: Komodo | null = null;

export function isKomodoConfigured(): boolean {
  const { url, apiKey, apiSecret } = appConfig.komodo;
  return Boolean(url && apiKey && apiSecret);
}

/**
 * Lazily create and cache the Komodo client. Returns null when Komodo is not
 * configured — callers should treat that as "platform unavailable".
 */
export function getKomodoClient(): Komodo | null {
  if (!isKomodoConfigured()) return null;
  if (client) return client;

  const { url, apiKey, apiSecret } = appConfig.komodo;
  const auth: InitOptions = { type: "api-key", params: { key: apiKey, secret: apiSecret } };
  client = KomodoClient(url, auth);
  return client;
}
