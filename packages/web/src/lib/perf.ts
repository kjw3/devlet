/**
 * Content-free performance marks for the loading baseline.
 *
 * Records when the shell renders, when auth resolves, and when fleet data
 * first arrives, plus per-request durations for /trpc calls. No credentials,
 * agent names, or mission content are recorded — paths only. Results are
 * exposed on `window.__devletPerf` so a baseline can be captured from the
 * browser console, and logged to the console in dev builds.
 */

interface RequestTiming {
  path: string;
  ms: number;
  ok: boolean;
}

interface PerfState {
  marks: Record<string, number>;
  requests: RequestTiming[];
}

const MAX_REQUEST_TIMINGS = 50;
const marks: Record<string, number> = {};
const requestTimings: RequestTiming[] = [];
let reported = false;

function perfState(): PerfState {
  return { marks, requests: requestTimings };
}

/** Read the collected marks/timings (also mirrored to `window.__devletPerf`). */
export function getPerf(): PerfState {
  return { marks: { ...marks }, requests: [...requestTimings] };
}

function publish(): void {
  if (typeof window !== "undefined") {
    (window as unknown as { __devletPerf?: PerfState }).__devletPerf = perfState();
  }
}

function reportOnce(): void {
  if (reported) return;
  reported = true;
  if (typeof console !== "undefined") {
    console.info("[devlet] perf marks (ms since app start):", { ...marks });
  }
}

/** Record the first occurrence of a named milestone. */
export function markPerf(name: string): void {
  if (marks[name] !== undefined) return;
  marks[name] = Math.round(performance.now());
  try {
    performance.mark(`devlet:${name}`);
  } catch {
    // performance.mark unavailable — timing still recorded above
  }
  publish();
  reportOnce();
}

/** Record one /trpc request duration. Keeps only the most recent entries. */
export function recordRequest(path: string, ms: number, ok: boolean): void {
  // Strip query strings — inputs must never end up in telemetry.
  const cleanPath = path.split("?")[0] ?? path;
  requestTimings.push({ path: cleanPath, ms: Math.round(ms), ok });
  if (requestTimings.length > MAX_REQUEST_TIMINGS) {
    requestTimings.splice(0, requestTimings.length - MAX_REQUEST_TIMINGS);
  }
  publish();
}

/** Test/dev helper: reset all timings. */
export function resetPerf(): void {
  for (const key of Object.keys(marks)) delete marks[key];
  requestTimings.length = 0;
  reported = false;
  publish();
}
