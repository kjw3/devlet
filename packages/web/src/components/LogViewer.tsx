import { useEffect, useRef, useState } from "react";

// Strips ANSI SGR escape sequences (colors, bold, dim, etc.) that container
// logs often contain. Matches ESC [ ... <final-byte> patterns.
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, "");
}

interface LogViewerProps {
  logs: string[];
  className?: string;
  follow?: boolean;
}

export function LogViewer({ logs, className = "", follow = true }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFollowing, setIsFollowing] = useState(follow);
  const previousLogCountRef = useRef(0);

  useEffect(() => {
    setIsFollowing(follow);
  }, [follow]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previousLogCount = previousLogCountRef.current;
    const hasNewLogs = logs.length > previousLogCount;
    previousLogCountRef.current = logs.length;

    if (follow && isFollowing && hasNewLogs) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: previousLogCount === 0 ? "auto" : "smooth",
      });
    }
  }, [logs, follow, isFollowing]);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom <= 12;
    setIsFollowing(atBottom);
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={`bg-surface border border-surface-border rounded-sm p-3 overflow-y-auto font-mono text-[11px] leading-relaxed ${className}`}
    >
      {logs.length === 0 ? (
        <span className="text-gray-600 italic">no logs yet</span>
      ) : (
        logs.map((line, i) => (
          <div key={i} className="text-gray-300 whitespace-pre-wrap break-all">
            {stripAnsi(line)}
          </div>
        ))
      )}
    </div>
  );
}
