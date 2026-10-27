/** Allowlist the portable Docker runtime fields; no container config is exposed. */
export function exitDetails(state: { Status?: unknown; ExitCode?: unknown; OOMKilled?: unknown; StartedAt?: unknown; FinishedAt?: unknown; Error?: unknown } | undefined) {
  if (!state) return { note: "Runtime state unavailable" };
  return { status: state.Status, exitCode: state.ExitCode, oomKilled: state.OOMKilled,
    startedAt: state.StartedAt, finishedAt: state.FinishedAt, error: state.Error };
}
