import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SshPublicKey } from "@devlet/shared";

const KEY_STORE_PATH = path.join(os.homedir(), ".devlet", "ssh-keys.json");

interface KeyStore {
  keys: SshPublicKey[];
}

async function loadStore(): Promise<KeyStore> {
  try {
    const raw = await fs.readFile(KEY_STORE_PATH, "utf8");
    return JSON.parse(raw) as KeyStore;
  } catch {
    return { keys: [] };
  }
}

async function saveStore(store: KeyStore): Promise<void> {
  await fs.mkdir(path.dirname(KEY_STORE_PATH), { recursive: true });
  await fs.writeFile(KEY_STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

/**
 * Compute the standard OpenSSH SHA256 fingerprint for a public key line.
 * Format: SHA256:<base64-no-padding of SHA256 of the raw key blob bytes>
 */
export function computeFingerprint(publicKeyLine: string): string {
  const parts = publicKeyLine.trim().split(/\s+/);
  if (parts.length < 2) throw new Error("Invalid public key format");
  const keyBytes = Buffer.from(parts[1]!, "base64");
  const hash = createHash("sha256").update(keyBytes).digest();
  return `SHA256:${hash.toString("base64").replace(/=+$/, "")}`;
}

export async function listSshKeys(): Promise<SshPublicKey[]> {
  const store = await loadStore();
  return store.keys;
}

export async function addSshKey(name: string, publicKey: string): Promise<SshPublicKey> {
  const trimmed = publicKey.trim();
  const fingerprint = computeFingerprint(trimmed);

  const store = await loadStore();
  const existing = store.keys.find((k) => k.fingerprint === fingerprint);
  if (existing) {
    throw new Error(`Key already exists: "${existing.name}"`);
  }

  const key: SshPublicKey = {
    id: randomUUID(),
    name,
    publicKey: trimmed,
    fingerprint,
    addedAt: new Date().toISOString(),
  };
  store.keys.push(key);
  await saveStore(store);
  return key;
}

export async function deleteSshKey(id: string): Promise<void> {
  const store = await loadStore();
  const idx = store.keys.findIndex((k) => k.id === id);
  if (idx === -1) throw new Error("Key not found");
  store.keys.splice(idx, 1);
  await saveStore(store);
}

/**
 * On startup: if DEVLET_SSH_PUBLIC_KEY is set and not already in the store
 * (matched by fingerprint), auto-add it as a bootstrap key.
 */
export async function bootstrapSshKeysFromEnv(): Promise<void> {
  const envKey = process.env["DEVLET_SSH_PUBLIC_KEY"];
  if (!envKey?.trim()) return;

  try {
    const fingerprint = computeFingerprint(envKey);
    const store = await loadStore();
    if (store.keys.some((k) => k.fingerprint === fingerprint)) return;

    const key: SshPublicKey = {
      id: randomUUID(),
      name: "bootstrap (DEVLET_SSH_PUBLIC_KEY)",
      publicKey: envKey.trim(),
      fingerprint,
      addedAt: new Date().toISOString(),
    };
    store.keys.push(key);
    await saveStore(store);
    console.log("[devlet] SSH: added bootstrap key from DEVLET_SSH_PUBLIC_KEY");
  } catch (err) {
    console.warn("[devlet] SSH: failed to bootstrap key from env:", err);
  }
}
