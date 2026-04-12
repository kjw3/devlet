import { useEffect, useRef } from "react";

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
            {line}
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
