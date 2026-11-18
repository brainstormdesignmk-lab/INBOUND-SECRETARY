# The image tunnel on the T60 — state, and how to finish it in one sitting

**Status: POSTPONED (2026-11-17), nothing half-built.** The image service keeps
running exactly as before; the tunnel has never been started, so there is
nothing to migrate, unwind or re-plan. This document is the checklist to run
the day a Cloudflare zone exists.

---

## 1. What exists today (verified on the box, 2026-11-17)

| piece | where | state |
| --- | --- | --- |
| image server | `python -u …/SCRAPERS_FINAL_IMPROVED/serve_images.py --host 127.0.0.1 --port 8088 --root /home/metropolis4/metropolis-images` | running, HTTP 200, **loopback only** |
| status hub | `python3` on `0.0.0.0:8090` | running (LAN-facing by design) |
| `cloudflared` binary | `~/t60/bin/cloudflared` (40 MB) | present and executable |
| tunnel token | `~/.t60/cf-tunnel-token` | **absent** |
| `~/.cloudflared/` (cert.pem, config.yml, credentials json) | — | **absent** — `cloudflared tunnel login` was never run here |
| tunnel process / log | `~/t60/logs/cloudflared.out.log` | none — it has never run |
| supervisor block | `~/t60/bin/supervise.sh` lines ~127-148 | present, **token-gated**: `if [ -s "$CFD_TOKEN" ] && [ -x "$CFD_BIN" ]` |

The supervisor runs every 5 minutes from cron and at `@reboot`. With no token
file it does nothing — which is why the standby has been shipping without a
tunnel.

## 2. The one and only blocker

**A DNS zone on Cloudflare that we control.** A public hostname (`img.<domain>`)
must live in a zone whose nameservers point at Cloudflare. `pages.dev` is a
shared zone and cannot host it, so today there is nowhere to put a stable
hostname.

- If a commercial domain is bought (≈ €10–15/year): point its nameservers at
  Cloudflare, and this becomes a five-minute job.
- If eu.org approves: the zone appears, and the same five minutes apply.
- **Until then: do nothing to the T60.** A quick tunnel (`cloudflared tunnel
  --url`) is NOT a substitute — its random `*.trycloudflare.com` host changes on
  every restart, so every URL handed to a client dies, and the supervisor does
  not manage it.

## 3. The decision already made

**A named tunnel, dashboard-managed by token.** No `cert.pem`, no `config.yml`,
no inbound port, no root needed on the T60 (it has no sudo anyway). The token
carries the tunnel id, the account and the ingress rules. It is additive: it
dials out, and the image server keeps binding `127.0.0.1:8088` untouched.

## 4. Finish it — dashboard route (recommended, needs no API access)

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
   → *Cloudflared* → name it `t60-images`.
2. **Public hostname**: `img.<your-domain>` → Service **HTTP** →
   `127.0.0.1:8088`. (Cloudflare creates the DNS record itself. Choose the same
   hostname you will put in LINA's config so nothing has to change twice.)
3. Copy the connector token (the long `eyJ…` string) and, on the T60:

   ```bash
   umask 077
   printf '%s' '<PASTE-TOKEN>' > ~/.t60/cf-tunnel-token
   chmod 600 ~/.t60/cf-tunnel-token
   wc -c ~/.t60/cf-tunnel-token        # a real token is ~150-200 bytes
   ```

4. Start it now instead of waiting for the 5-minute cron pass:

   ```bash
   bash ~/t60/bin/supervise.sh
   sleep 5; tail -20 ~/t60/logs/cloudflared.out.log
   ```

   Expect `Registered tunnel connection` (×4) and no `Unauthorized`.

5. Verify from **outside** the LAN (phone on mobile data):

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://img.<your-domain>/<a real file name>
   ```

   **Acceptance:** `200` and the image bytes. `502/1033` means the connector is
   up but the origin refused — check the image server is still on `8088`.

6. Confirm it survives a reboot: the supervisor block is already `@reboot` +
   `*/5`, and the pid file lives in `~/.t60/state/`. After a reboot,
   `pgrep -af 'cloudflared [t]unnel run'` must show one process.

## 5. Alternative — API route (if you prefer I create it)

Token scopes: **Account · Cloudflare Tunnel · Edit** and **Zone · DNS · Edit**
for that zone, plus the Account ID and the zone name. Then the tunnel, the
public hostname and the DNS record can be created in one command sequence and
the token written to `~/.t60/cf-tunnel-token`; steps 4–6 above are the same.

## 6. Rollback (30 seconds, no residue)

```bash
rm -f ~/.t60/cf-tunnel-token
pkill -f 'cloudflared [t]unnel run'
```

The supervisor goes silent on its next pass, the DNS record can be deleted in
the dashboard, and the image server keeps serving on `127.0.0.1:8088` exactly as
it does today. Nothing in LINA changes.

## 7. Wiring it into LINA — not part of this job

`grep -rn '8088\|imageHost\|IMAGE_HOST' src/` returns nothing: the bot does not
send property photos yet. When it does, the rules are:

- **One** config value (e.g. `PUBLIC_IMAGE_BASE=https://img.<domain>`) in
  `~/.lina/lina.env`; never a hostname in code, so a future domain swap is an
  env change plus a restart.
- Viber fetches pictures from **its own servers on the public internet**, so a
  LAN bind can never serve the bot — the tunnel is the only path that works.
  Binding `8088` to `0.0.0.0` would expose the catalog to the LAN and still not
  answer Viber; do not do it.

## 8. Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| no tunnel process, no log | token file missing or empty | `wc -c ~/.t60/cf-tunnel-token` |
| `Unauthorized` in the log | token trimmed/quoted when pasted | rewrite the file with `printf '%s'`, no newline |
| `1033 / 502` from the public URL | connector up, origin refused | `curl -I 127.0.0.1:8088` on the T60 |
| works, then dies every restart | quick tunnel used instead of a named one | use `tunnel run --token`, never `--url` |
| DNS record missing | hostname added to the tunnel but not to DNS | dashboard → Public hostnames → re-add |

## 9. Do not

- Do not bind the image server to `0.0.0.0` — nothing needs LAN access to it.
- Do not expose `8090` (the status hub) through the tunnel.
- Do not put the image directory in git or in a deploy rsync; the images stay on
  the T60 where they are.

## 10. Paste this back when it is done

```
tunnel: <hostname>  → 200 https from mobile data
process: pgrep -af 'cloudflared [t]unnel run'  → 1
log: tail -3 ~/t60/logs/cloudflared.out.log   → Registered tunnel connection
reboot: survived (pid present, URL 200)
rollback tested: token removed → block silent, images still 200 locally
```
