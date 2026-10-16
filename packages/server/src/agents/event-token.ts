/**
 * Scoped HMAC tokens for agent-reported mission lifecycle events.
 *
 * Deliberately dependency-free: this module is imported by env.ts (which every
 * platform deploy path uses), so it must not pull in platform clients or any
 * module that requires the localStorage shim at import time.
 */
import { createHmac, timingSafeEqual } from "crypto";

function getSecret(): string {
  const secret = process.env["DEVLET_AUTH_TOKEN"];
  if (!secret) {
    throw new Error("DEVLET_AUTH_TOKEN must be set");
  }
  return secret;
}

/**
 * Scoped token for agent-reported mission lifecycle events. Unlike the full
 * DEVLET_AUTH_TOKEN (which controls the whole API), this only authorizes
 * posting activity events for one agent id.
 */
export function buildAgentEventToken(agentId: string): string {
  return createHmac("sha256", getSecret()).update(`v1:agent-event:${agentId}`).digest("hex");
}

export function validateAgentEventToken(agentId: string, provided: string | null | undefined): boolean {
  if (!provided) return false;

  const expected = Buffer.from(buildAgentEventToken(agentId));
  const received = Buffer.from(provided);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
