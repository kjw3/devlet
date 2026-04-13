import { useEffect, useRef } from "react";

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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, follow]);

  return (
    <div
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
      <div ref={bottomRef} />
    </div>
  );
}
