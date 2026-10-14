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

1. Create a **Proxy provider** in *forward auth (domain level)* mode. Set the authentication
   URL (external host) to `https://devlet.example.com` and the **cookie domain to
   `devlet.example.com`** (no scheme, no leading dot). Domain level is needed so the same login
   covers the agent proxy subdomains (see below). Set the cookie domain when you first create the
   provider; see the troubleshooting note.
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

# Agent proxy URLs (web terminal, gateway UIs): <surface>--<agent>--<token>.devlet.example.com
# The Devlet server resolves these by Host header itself, so send them straight to it (port 3001).
*.devlet.example.com {
    route {
        reverse_proxy /outpost.goauthentik.io/* authentik-outpost:9000
        forward_auth authentik-outpost:9000 {
            uri /outpost.goauthentik.io/auth/caddy
            copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Uid
        }
        reverse_proxy devlet-host:3001
    }
}
```

The wildcard site needs a wildcard DNS record (`*.devlet.example.com`) and a wildcard certificate,
which means a DNS-01 ACME challenge (for example Caddy's DNS provider plugin). `DEVLET_PUBLIC_BASE_URL`
must be `https://devlet.example.com` so Devlet generates URLs under that domain.

Give Caddy the token through its environment (`DEVLET_AUTH_TOKEN`), or paste it into the
Caddyfile if you prefer.

## Notes

- The token stays the real gate: reaching Devlet's web or server port directly, bypassing
  Caddy, still returns 401. Keep those ports on a trusted network.
- `/agent-access/...` links (web terminal, gateway UIs) carry their own per-URL proxy token and
  pass through the same Caddy route; WebSockets work with `reverse_proxy` as-is.
- Restrict Devlet's published ports (3000 and 3001) to the Caddy host with a firewall rule.
  Docker bypasses `ufw`, so use the `DOCKER-USER` chain and match the original direction only
  (`-m conntrack --ctdir ORIGINAL --ctorigdstport 3000:3001 ! -s <caddy-ip> -j DROP`); without
  `--ctdir ORIGINAL` the rule also drops the containers' replies.
- If Caddy mounts its Caddyfile as a single file, editors and `mv` replace the file with a new
  inode and the container keeps reading the old one. Write into the existing file (`cat new >
  Caddyfile`) and reload.
- The CLI keeps using `DEVLET_AUTH_TOKEN` directly and must reach the server without going
  through forward auth.
- Devlet does not learn who the user is; everyone authentik admits has full control.

## Troubleshooting

**Login loops or a 400 on `/outpost.goauthentik.io/callback`, log says `mismatched session ID` /
`invalid state`.** The session cookie is not shared between `devlet.example.com` and the agent
subdomains. Check the `Set-Cookie` header on both hosts: it must contain
`Domain=devlet.example.com`. If it does not:

1. Confirm the provider is in *forward auth (domain level)* mode with the cookie domain set.
2. Changing the cookie domain on an existing provider is **not enough**. The embedded outpost keeps
   the session store (including the cookie options) from the first time it loaded the application
   ("reusing existing session store" in the outpost debug log). Remove the provider from the outpost
   and add it back (or restart the outpost) so the application is recreated.
3. Clear the site's cookies afterwards. Old host-only cookies have the same name as the new domain
   cookie and clash with it.
4. Sign in on `https://devlet.example.com/` first, then open the agent URL. Reloading the callback
   URL always fails, because the authorization `code` is single use.

**Agent URL does not resolve right after creating the wildcard record.** A resolver that looked up
the exact name before the record existed caches the negative answer until the zone's SOA minimum
expires (often ~30 minutes). Flush the resolver's cache or wait.
