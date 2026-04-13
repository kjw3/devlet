import { useState } from "react";
import type { SshPublicKey } from "@devlet/shared";
import { trpc } from "../trpc.js";
import { ConfirmModal } from "../components/ConfirmModal.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function shortFingerprint(fp: string): string {
  // "SHA256:abcdefghij..." → "SHA256:abcdefgh…wxyz"
  const [algo, hash] = fp.split(":");
  if (!hash || hash.length <= 16) return fp;
  return `${algo}:${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

// ─── Add key form ─────────────────────────────────────────────────────────────

function AddKeyForm({ onDone }: { onDone: () => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addKey = trpc.settings.ssh.addKey.useMutation({
    onSuccess: () => {
      void utils.settings.ssh.listKeys.invalidate();
      onDone();
    },
    onError: (err) => setError(err.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !publicKey.trim()) return;
    addKey.mutate({ name: name.trim(), publicKey: publicKey.trim() });
  }

  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="label">add ssh key</div>

      {error && (
        <div className="text-[11px] text-accent-red bg-accent-red/5 border border-accent-red/30 rounded-sm px-3 py-2">
          {error}
        </div>
      )}

      <div className="space-y-1">
        <label className="label text-[10px]">title</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My laptop"
          className="w-full bg-surface-base border border-surface-border rounded-sm px-3 py-1.5 text-[12px] text-gray-100 outline-none focus:border-accent-cyan"
          autoFocus
        />
      </div>

      <div className="space-y-1">
        <label className="label text-[10px]">public key</label>
        <textarea
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          placeholder="ssh-ed25519 AAAA..."
          rows={3}
          className="w-full bg-surface-base border border-surface-border rounded-sm px-3 py-1.5 text-[11px] font-mono text-gray-100 outline-none focus:border-accent-cyan resize-none"
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          className="btn-primary"
          disabled={addKey.isPending || !name.trim() || !publicKey.trim()}
        >
          {addKey.isPending ? "adding…" : "add key"}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          cancel
        </button>
      </div>
    </form>
  );
}

// ─── Key row ──────────────────────────────────────────────────────────────────

function KeyRow({ sshKey }: { sshKey: SshPublicKey }) {
  const utils = trpc.useUtils();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteKey = trpc.settings.ssh.deleteKey.useMutation({
    onSuccess: () => void utils.settings.ssh.listKeys.invalidate(),
  });

  return (
    <>
      <div className="flex items-center gap-4 py-3 border-b border-surface-border last:border-0">
        {/* Key icon */}
        <svg
          className="w-4 h-4 text-gray-600 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="7.5" cy="15.5" r="5.5" />
          <path d="M21 2l-9.6 9.6" />
          <path d="M15.5 7.5l3 3L22 7l-3-3" />
        </svg>

        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-gray-200 font-medium truncate">{sshKey.name}</div>
          <div className="text-[10px] font-mono text-gray-500 mt-0.5">
            {shortFingerprint(sshKey.fingerprint)}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="label text-[10px] text-gray-600">
            added {formatDate(sshKey.addedAt)}
          </span>
          <button
            className="text-[11px] text-gray-600 hover:text-accent-red transition-colors"
            onClick={() => setConfirmDelete(true)}
            disabled={deleteKey.isPending}
          >
            {deleteKey.isPending ? "removing…" : "delete"}
          </button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete SSH key?"
          message={`"${sshKey.name}" will be removed. Existing agents that already have this key injected will not be affected — only newly hired agents will lose access.`}
          confirmLabel="delete"
          danger
          onConfirm={() => {
            deleteKey.mutate(sshKey.id);
            setConfirmDelete(false);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function Settings() {
  const [showAddForm, setShowAddForm] = useState(false);
  const { data: keys, isLoading } = trpc.settings.ssh.listKeys.useQuery();

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">

        {/* Page header */}
        <div>
          <h1 className="text-lg font-bold text-text-primary">Settings</h1>
          <p className="text-xs text-gray-500 mt-1">
            Manage SSH keys and other global configuration for your devlet instance.
          </p>
        </div>

        {/* SSH Keys section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-200">SSH Keys</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Public keys injected into agent containers to enable direct SSH access.
              </p>
            </div>
            {!showAddForm && (
              <button className="btn-ghost" onClick={() => setShowAddForm(true)}>
                add key
              </button>
            )}
          </div>

          {showAddForm && (
            <AddKeyForm onDone={() => setShowAddForm(false)} />
          )}

          <div className="card p-4">
            {isLoading ? (
              <div className="text-[11px] text-gray-600 animate-pulse py-2">loading…</div>
            ) : !keys || keys.length === 0 ? (
              <div className="text-[12px] text-gray-600 italic py-2">
                no ssh keys configured — add one to enable direct SSH access to agents
              </div>
            ) : (
              <div>
                {keys.map((k) => (
                  <KeyRow key={k.id} sshKey={k} />
                ))}
              </div>
            )}
          </div>

          <div className="text-[11px] text-gray-600 space-y-1">
            <p>
              Keys are bundled into each new agent's <code className="font-mono text-gray-500">authorized_keys</code> at hire time.
              Restart or re-hire an agent to apply key changes to existing deployments.
            </p>
            <p>
              Set <code className="font-mono text-gray-500">DEVLET_SSH_PUBLIC_KEY</code> in your <code className="font-mono text-gray-500">.env</code> to auto-add a bootstrap key on server startup.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
}
