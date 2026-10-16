export const SESSION_EXPIRED_EVENT = "devlet:session-expired";

/** Do not follow proxy login redirects with fetch: cross-origin login pages
 * otherwise surface as an indistinguishable CORS NetworkError. Navigation is
 * offered separately so mutations are never automatically replayed. */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: "same-origin", redirect: "manual" });
  if (isLoginResponse(response)) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new Error("Your login session has expired. Reconnect to sign in again.");
  }
  return response;
}

export function isLoginResponse(response: Pick<Response, "type" | "status" | "headers">): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)
    || (response.status === 200 && (response.headers.get("content-type") ?? "").includes("text/html"));
}

export function retryQuery(failureCount: number, error: unknown): boolean {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  if (code && ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_REQUEST"].includes(code)) return false;
  return failureCount < 3;
}
