# Tuki backend

Production deployment stack for Tuki, a Muzes communication product.

The public product is Tuki. The current protocol-compatible core is based on
AGPL-licensed Stoat components and is kept current as an upstream dependency.
Tuki's web client, branding, deployment, domains and product extensions are
maintained separately.

## Public services

- `tuki.muzes.xyz` — product website
- `chat.muzes.xyz` — web application
- `core.muzes.xyz` — HTTP API
- `gateway.muzes.xyz` — realtime WebSocket Gateway
- `cdn.muzes.xyz` — avatars and user uploads
- `media.muzes.xyz` — external media, embeds and GIF proxy
- `voice.muzes.xyz` — calls and voice ingress
- `invite.muzes.xyz` — short invite links
- `chat.muzes.xyz/status` — service status page inside the web application
- `developers.muzes.xyz` — future developer portal
- `support.muzes.xyz` — support and safety

## First deployment

```bash
cp .env.example .env
cp secrets.env.example secrets.env
cp Revolt.toml.example Revolt.toml
cp livekit.yml.example livekit.yml
```

Generate new VAPID, file-encryption and LiveKit secrets. Put application
secrets in `secrets.env`; keep public hostnames in `.env`. The LiveKit key and
secret in `livekit.yml` must match the values supplied to the API.

Then:

```bash
docker compose config
docker compose build tuki-core
docker compose pull
docker compose up
```

After confirming that API, Gateway, uploads and voice are healthy:

```bash
docker compose up -d
```

Optional metrics dashboards:

```bash
docker compose --profile observability up -d prometheus grafana
```

Prometheus is bound to `127.0.0.1:9090` and Grafana to
`127.0.0.1:3001`. Access them through an SSH tunnel instead of publishing
administration panels to the internet. Set a strong
`GF_SECURITY_ADMIN_PASSWORD` in `secrets.env` first.

## Updating

Review upstream release and security notices before changing image versions.
The deployed core currently targets `v0.13.8`. Run:

```bash
docker compose pull
docker compose build --pull tuki-core
docker compose up -d
docker compose ps
```

Back up MongoDB, MinIO and `secrets.env` before every major upgrade.

## Enabling Orbit Max uploads

Orbit Max must remain disabled until the CDN asks Tuki Core to authorise every
upload. Use [`nginx-tuki-cdn.example.conf`](./nginx-tuki-cdn.example.conf) when
the public CDN is served by Nginx, or keep the equivalent `forward_auth` block
from the supplied `Caddyfile`.

Enable the feature in this order:

1. Add the upload-authorisation locations to the existing `cdn.muzes.xyz`
   virtual host. Do not replace unrelated TLS or access-log settings.
2. Test the Nginx configuration and reload it.
3. Set `TUKI_STORAGE_ATTACHMENT_LIMIT_BYTES=500000000`. This is the storage
   ceiling, not the free-account limit.
4. Recreate `tuki-core` and `autumn`, then verify that an unauthenticated upload
   is rejected and a free account is still limited to 10 MB.
5. Only after those checks set `TUKI_HOTPAY_ORBIT_MAX_ENABLED=true` and recreate
   `tuki-core`.

```bash
nginx -t && systemctl reload nginx
docker compose config --quiet
docker compose up -d --build --force-recreate tuki-core autumn
docker compose ps tuki-core autumn
```

The defaults deliberately fail closed: free accounts keep a 10 MB attachment
limit, emoji keep a 4 MB limit, and Orbit Max checkout stays unavailable. The
authoriser also applies a 50 GB monthly upload allowance by default. Change
these values only through the documented environment variables.

## Network exposure

Only Caddy (`80/tcp`, `443/tcp`) and LiveKit RTC (`7881/tcp`,
`50000-50100/udp`) are exposed. Database, message broker, cache and object
storage live on an internal Docker network.

The complete DNS, reverse-proxy and container-port contract is documented in
[`PORTS-AND-DNS.md`](./PORTS-AND-DNS.md).

## Product rules

- No advertised endpoint without a working implementation and tests.
- No secrets in tracked examples.
- No AI features in the Tuki product.
- SaaS features such as subscriptions or billing require a dedicated,
  audited service and cannot be enabled with an environment flag alone.
- Keep upstream AGPL notices and publish corresponding modified source as
  required by the licence.
