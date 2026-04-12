import { Routes, Route } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard.js";
import { AgentDetail } from "./pages/AgentDetail.js";
import { HireAgent } from "./pages/HireAgent.js";
import { PlatformSidebar } from "./components/PlatformSidebar.js";

export default function App() {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top nav bar */}
      <nav className="border-b border-surface-border bg-surface-raised px-6 py-2 flex items-center gap-4 flex-shrink-0">
        <span className="text-accent-cyan font-bold text-[13px] tracking-widest uppercase">
          devlet
        </span>
        <span className="text-surface-border">|</span>
        <span className="label text-gray-600">agent orchestration</span>
      </nav>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Content area */}
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents/:id" element={<AgentDetail />} />
          <Route path="/hire" element={<HireAgent />} />
        </Routes>

        {/* Platform sidebar — always visible */}
        <PlatformSidebar />
      </div>
    </div>
  );
}
