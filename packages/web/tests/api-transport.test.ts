import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoginResponse, retryQuery } from "../src/lib/api-transport.js";

test("proxy login redirects are recognized before fetch follows them into CORS errors", () => {
  assert.equal(isLoginResponse({ type: "opaqueredirect", status: 0, headers: new Headers() }), true);
  assert.equal(isLoginResponse({ type: "basic", status: 302, headers: new Headers() }), true);
  assert.equal(isLoginResponse(new Response("login", { headers: { "content-type": "text/html" } })), true);
  assert.equal(isLoginResponse(new Response("{}", { headers: { "content-type": "application/json" } })), false);
  assert.equal(isLoginResponse(new Response("unavailable", { status: 503 })), false);
});
test("transient failures retry but authorization and missing agents do not", () => {
  assert.equal(retryQuery(0, new TypeError("NetworkError")), true);
  assert.equal(retryQuery(2, new TypeError("NetworkError")), true);
  assert.equal(retryQuery(3, new TypeError("NetworkError")), false);
  for (const code of ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_REQUEST"]) {
    assert.equal(retryQuery(0, { data: { code } }), false);
  }
});
