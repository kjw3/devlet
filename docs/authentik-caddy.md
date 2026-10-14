# Authentik + Caddy (forward auth)

Devlet itself only knows one credential, `DEVLET_AUTH_TOKEN`. To put single sign-on
(for example Google through [authentik](https://goauthentik.io)) in front of the web UI, let
Caddy authenticate the user and add the bearer token for them.

```
browser ──► Caddy ──forward_auth──► authentik outpost
              │ (authenticated only: adds Authorization: Bearer <token> on /trpc/*)
              ▼
         devlet-web (nginx) ──► devlet-server
```

The web UI probes `/trpc/agents.list` on load. If that succeeds without a locally stored
token, the proxy is supplying it and the token prompt is skipped. Without a proxy the prompt
works exactly as before.

## Authentik

1. Create a **Proxy provider** in *forward auth (single application)* mode with the external
   host `https://devlet.example.com`.
2. Create an **Application** using that provider and attach it to the outpost Caddy talks to.
3. Restrict access with an authentik policy (group or email). Add Google as a source if you
   want Google sign-in.

## Caddy

```caddy
devlet.example.com {
    encode gzip zstd
    route {
        reverse_proxy /outpost.goauthentik.io/* authentik-outpost:9000
        forward_auth authentik-outpost:9000 {
            uri /outpost.goauthentik.io/auth/caddy
            copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Uid
        }
        # Only authenticated requests reach this point.
        request_header /trpc/* Authorization "Bearer {env.DEVLET_AUTH_TOKEN}"
        reverse_proxy devlet-host:3000
    }
}
```

Give Caddy the token through its environment (`DEVLET_AUTH_TOKEN`), or paste it into the
Caddyfile if you prefer.

## Notes

- The token stays the real gate: reaching Devlet's web or server port directly, bypassing
  Caddy, still returns 401. Keep those ports on a trusted network.
- `/agent-access/...` links (web terminal, gateway UIs) carry their own per-URL proxy token and
  pass through the same Caddy route; WebSockets work with `reverse_proxy` as-is.
- The CLI keeps using `DEVLET_AUTH_TOKEN` directly and must reach the server without going
  through forward auth.
- Devlet does not learn who the user is; everyone authentik admits has full control.
