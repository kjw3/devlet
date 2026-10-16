import { useEffect, useState } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard.js";
import { AgentDetail } from "./pages/AgentDetail.js";
import { HireAgent } from "./pages/HireAgent.js";
import { ModelConfig } from "./pages/ModelConfig.js";
import { AgentConfig } from "./pages/AgentConfig.js";
import { Settings } from "./pages/Settings.js";
import { PlatformSidebar } from "./components/PlatformSidebar.js";
import { DEVLET_AUTH_STORAGE_KEY } from "./trpc.js";
import { apiFetch, SESSION_EXPIRED_EVENT } from "./lib/api-transport.js";

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
  // "unknown" while probing; "open" when a reverse proxy (e.g. Caddy + authentik) injects the bearer token.
  const [proxyAuth, setProxyAuth] = useState<"unknown" | "open" | "closed">(token ? "closed" : "unknown");

  useEffect(() => {
    if (token) return;
    let cancelled = false;
    apiFetch("/trpc/agents.list")
      .then((response) => {
        if (!cancelled) setProxyAuth(response.ok ? "open" : "closed");
      })
      .catch(() => {
        if (!cancelled) setProxyAuth("closed");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (sessionExpired) {
    return <div className="min-h-screen flex items-center justify-center bg-surface-base px-6">
      <div className="card max-w-md p-6 space-y-4" role="alert">
        <div className="text-gray-100">Your login session has expired</div>
        <p className="text-[12px] text-gray-400">Reconnect to sign in again and return to this page. Your agents continue running.</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>reconnect / sign in</button>
      </div>
    </div>;
  }

  if (token || proxyAuth === "open") {
    return <>{children}</>;
  }

  if (proxyAuth === "unknown") {
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base px-6">
      <form
        className="card w-full max-w-md p-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          if (!trimmed) return;
          window.localStorage.setItem(DEVLET_AUTH_STORAGE_KEY, trimmed);
          setToken(trimmed);
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
        <nav className="border-b border-surface-border bg-surface-raised px-6 py-2 flex items-center gap-4 flex-shrink-0">
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
