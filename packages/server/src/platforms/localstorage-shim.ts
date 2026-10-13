/**
 * Node has no `localStorage`, but `komodo_client` (via its transitive dependency
 * `mogh_auth_client`) reads it at *module-evaluation* time to cache auth tokens.
 *
 * ESM evaluates a module's imports before the importing module's body, in source
 * order. So this file must be imported as the FIRST import of any module that
 * pulls in `komodo_client` (see komodo-client.ts). That guarantees the shim is
 * installed before `mogh_auth_client`'s top-level `localStorage.getItem(...)` runs.
 */
const store = new Map<string, string>();

function install(): void {
  // Use defineProperty (not plain assignment) so we deterministically override
  // Node's experimental built-in `localStorage` accessor on newer runtimes without
  // invoking its getter (which would emit a warning / return undefined). On older
  // Node there is no such property, so this simply installs our shim.
  const existing = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (existing && existing.value) return; // already installed by us
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    } as Storage,
    configurable: true,
    writable: true,
  });
}

install();
