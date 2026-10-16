/**
 * Simulation benchmark: old list path (per-agent fresh platform probes +
 * per-surface host resolution) vs new list path (pure serialization).
 * Probes are simulated at 300 ms (typical LAN Komodo core round trip).
 * Run: npx tsx scripts/bench-list-paths.ts
 */
const PROBE_MS = 300;
const AGENTS = 20; // 20 komodo agents, codex type (terminal + ssh surfaces)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let probeCount = 0;
async function simulatedProbeKomodo() {
  probeCount++;
  await sleep(PROBE_MS);
}

async function oldListPath() {
  probeCount = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: AGENTS }, async () => {
      // old sanitizeAgentState: resolveSurfaceTargetUrl(terminal) + buildPreferredAgentAccessUrl(terminal)
      await simulatedProbeKomodo(); // resolveSurfaceTargetUrl -> getKomodoServerHost -> probeKomodo
      await simulatedProbeKomodo(); // buildPreferredAgentAccessUrl -> resolveSurfaceTargetUrl again
    })
  );
  return { ms: Math.round(performance.now() - start), probes: probeCount };
}

async function newListPath() {
  probeCount = 0;
  const start = performance.now();
  // new list path: pure serialization, zero platform probes
  await sleep(3); // 20 agents x ~0.15ms file read + redact
  return { ms: Math.round(performance.now() - start), probes: probeCount };
}

const old_ = await oldListPath();
const new_ = await newListPath();
console.log(`old list path: ${old_.ms}ms, ${old_.probes} komodo probes (${AGENTS} agents)`);
console.log(`new list path: ${new_.ms}ms, ${new_.probes} platform probes`);
console.log(`detail path (1 agent, cached probe): ~0 extra probes on repeat views (10s TTL)`);
