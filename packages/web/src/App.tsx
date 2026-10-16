import { useEffect, useState } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard.js";
import { AgentDetail } from "./pages/AgentDetail.js";
import { HireAgent } from "./pages/HireAgent.js";
import { ModelConfig } from "./pages/ModelConfig.js";
import { AgentConfig } from "./pages/AgentConfig.js";
import { Settings } from "./pages/Settings.js";
import { PlatformSidebar } from "./components/PlatformSidebar.js";
import { trpc, DEVLET_AUTH_STORAGE_KEY } from "./trpc.js";
import { SESSION_EXPIRED_EVENT } from "./lib/api-transport.js";
import { markPerf } from "./lib/perf.js";

/** Branded loading shell shown instead of a blank page while auth/data resolve. */
function LoadingShell({ label }: { label: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-surface px-6" role="status">
      <div className="mono-header text-lg text-accent-cyan tracking-widest uppercase">devlet</div>
      <div className="text-[12px] text-gray-500 mt-2 animate-pulse">{label}</div>
    </div>
  );
}

function SessionErrorShell({ label, detail, actions, alert }: {
  label: string;
  detail?: string;
  actions: React.ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-6">
      <div className="card max-w-md p-6 space-y-4" role={alert ? "alert" : undefined}>
        <div className="mono-header text-base text-gray-100">{label}</div>
        {detail && <p className="text-[12px] text-gray-400 break-words">{detail}</p>}
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(() =>
    typeof window === "undefined"
      ? ""
      : window.localStorage.getItem(DEVLET_AUTH_STORAGE_KEY) ?? ""
  );
  const [draft, setDraft] = useState(token);
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    const expired = () => setSessionExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, []);
  const utils = trpc.useUtils();

  // Lightweight authenticated-session probe: middleware only, no agent list,
  // no platform probes. Replaces the old raw `/trpc/agents.list` auth fetch.
  const sessionQuery = trpc.auth.session.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: "always",
  });

  useEffect(() => {
    if (sessionQuery.isSuccess) markPerf("session-resolved");
  }, [sessionQuery.isSuccess]);
  useEffect(() => {
    markPerf("app-shell");
  }, []);

  const errorCode = sessionQuery.error?.data?.code;
  const isUnauthorized = errorCode === "UNAUTHORIZED" || errorCode === "FORBIDDEN";
  // Anything without a tRPC error code is a transport/server problem, not an auth verdict.
  const isConnectivityProblem = sessionQuery.isError && !isUnauthorized;

  if (sessionExpired) {
    return <SessionErrorShell
      alert
      label="Your login session has expired"
      detail="Reconnect to sign in again and return to this page. Your agents continue running."
      actions={<button className="btn-primary" onClick={() => window.location.reload()}>reconnect / sign in</button>}
    />;
  }

  if (sessionQuery.isSuccess) {
    return <>{children}</>;
  }

  if (sessionQuery.isPending) {
    return <LoadingShell label="Checking your session…" />;
  }

  if (isUnauthorized && token) {
    // A stored bearer token was rejected — same protection as before, but with
    // a clear message instead of a silent full-page failure.
    return <SessionErrorShell
      alert
      label="Your login session has expired"
      detail="Reconnect to sign in again and return to this page. Your agents continue running."
      actions={
        <button
          className="btn-primary"
          onClick={() => {
            window.localStorage.removeItem(DEVLET_AUTH_STORAGE_KEY);
            window.location.reload();
          }}
        >
          reconnect / sign in
        </button>
      }
    />;
  }

  if (isConnectivityProblem) {
    return <SessionErrorShell
      label="Can't reach the devlet server"
      detail={sessionQuery.error?.message}
      actions={
        <>
          <button className="btn-primary" disabled={sessionQuery.isFetching} onClick={() => void sessionQuery.refetch()}>
            {sessionQuery.isFetching ? "checking…" : "retry"}
          </button>
          <button className="btn-ghost" onClick={() => window.location.reload()}>reload page</button>
        </>
      }
    />;
  }

  // Unauthorized with no stored token: offer the bearer-token form. If the
  // deployment relies on reverse-proxy SSO, this form only appears when the
  // server itself rejected the request — a network outage never lands here.
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-6">
      <form
        className="card w-full max-w-md p-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          if (!trimmed) return;
          window.localStorage.setItem(DEVLET_AUTH_STORAGE_KEY, trimmed);
          setToken(trimmed);
          setDraft(trimmed);
          void utils.auth.session.invalidate();
        }}
      >
        <div>
          <div className="mono-header text-base text-gray-100">authenticate</div>
          <p className="text-[12px] text-gray-500 mt-2">
            Enter the `DEVLET_AUTH_TOKEN` configured on the server to access the control plane.
          </p>
        </div>
        <input
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="w-full bg-surface-raised border border-surface-border rounded-sm px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent-cyan"
          placeholder="DEVLET_AUTH_TOKEN"
          aria-label="DEVLET_AUTH_TOKEN"
          autoFocus
        />
        <button className="btn-primary w-full" type="submit">
          unlock
        </button>
      </form>
    </div>
  );
}

export default function App() {
  return (
    <AuthGate>
      <div className="h-screen flex flex-col overflow-hidden">
        <nav className="border-b border-surface-border bg-surface-raised px-6 py-2 flex items-center gap-4 flex-shrink-0" aria-label="Primary">
          <NavLink to="/" className="text-accent-cyan font-bold text-[13px] tracking-widest uppercase hover:text-accent-cyan/80 transition-colors">
            devlet
          </NavLink>
          <span className="text-surface-border">|</span>
          <span className="label text-gray-600">agent orchestration</span>
          <div className="ml-auto flex items-center gap-4">
            <NavLink
              to="/agent-config"
              className={({ isActive }) =>
                `label text-[12px] transition-colors ${isActive ? "text-accent-cyan" : "text-gray-500 hover:text-gray-300"}`
              }
            >
              agents
            </NavLink>
            <NavLink
              to="/providers"
              className={({ isActive }) =>
                `label text-[12px] transition-colors ${isActive ? "text-accent-cyan" : "text-gray-500 hover:text-gray-300"}`
              }
            >
              providers
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `label text-[12px] transition-colors ${isActive ? "text-accent-cyan" : "text-gray-500 hover:text-gray-300"}`
              }
            >
              settings
            </NavLink>
            <button
              className="label text-[12px] text-gray-500 hover:text-gray-300 transition-colors"
              onClick={() => {
                window.localStorage.removeItem(DEVLET_AUTH_STORAGE_KEY);
                window.location.reload();
              }}
              type="button"
            >
              lock
            </button>
          </div>
        </nav>

        <div className="flex flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/hire" element={<HireAgent />} />
            <Route path="/providers" element={<ModelConfig />} />
            <Route path="/agent-config" element={<AgentConfig />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>

          <PlatformSidebar />
        </div>
      </div>
    </AuthGate>
  );
}
