# Tuki ports and DNS

## Public firewall ports

Only these ports should be open on the VPS:

| Port | Protocol | Purpose |
| --- | --- | --- |
| `80` | TCP | HTTP to HTTPS redirect and ACME |
| `443` | TCP/UDP | HTTPS, WebSocket and HTTP/3 through Caddy |
| `7881` | TCP | LiveKit RTC over TCP |
| `50000-50100` | UDP | LiveKit WebRTC media |
| `22` | TCP | SSH, preferably restricted to administrator IPs |

Do not publish MongoDB, Valkey, RabbitMQ or MinIO to the internet.

## DNS and reverse proxy map

Create `A` records pointing every active hostname below to the VPS public IPv4.
Create matching `AAAA` records only when IPv6 is correctly routed and allowed
through the firewall.

| Hostname | Caddy destination | Function |
| --- | --- | --- |
| `chat.muzes.xyz` | separate frontend container/host | Tuki web client; not served by this backend stack |
| `core.muzes.xyz/v1/*` | `tuki-core:14800` | Tuki product API |
| `core.muzes.xyz/health/*` | `tuki-core:14800` | health checks |
| `core.muzes.xyz/openapi.json` | `tuki-core:14800` | OpenAPI contract |
| other `core.muzes.xyz/*` | `api:14702` | compatible messaging API |
| `gateway.muzes.xyz` | `events:14703` | realtime WebSocket Gateway |
| `cdn.muzes.xyz` | `autumn:14704` | uploads, avatars and attachments |
| `media.muzes.xyz` | `january:14705` | image and embed proxy |
| `media.muzes.xyz/gifbox/*` | `gifbox:14706` | GIF proxy |
| `voice.muzes.xyz/livekit/*` | `livekit:7880` | LiveKit signalling |
| `voice.muzes.xyz/ingress/*` | `voice-ingress:8500` | voice ingress |
| `invite.muzes.xyz/:code` | redirect to `chat.muzes.xyz/invite/:code` | short invitations |
| `developers.muzes.xyz` | `tuki-core:14800` | API definition and future developer portal |
| `search.muzes.xyz/v1/search` | `tuki-core:14800` | Tuki community, forum and event search |

`tuki.muzes.xyz` and `support.muzes.xyz` should receive DNS records only after
their separate website/services are deployed. They are not silently routed to
the chat backend. Service status is served inside the frontend at
`https://chat.muzes.xyz/status`; `status.muzes.xyz` is not required.

## Internal Docker ports

| Container | Port |
| --- | --- |
| `api` | `14702/tcp` |
| `events` | `14703/tcp` |
| `autumn` | `14704/tcp` |
| `january` | `14705/tcp` |
| `gifbox` | `14706/tcp` |
| `tuki-core` | `14800/tcp` |
| `voice-ingress` | `8500/tcp` |
| `livekit` signalling | `7880/tcp` |
| MongoDB | `27017/tcp` |
| Valkey | `6379/tcp` |
| RabbitMQ | `5672/tcp` |
| MinIO S3 | `9000/tcp` |
| Prometheus (optional profile) | `9090/tcp`, bound to VPS localhost |
| Grafana (optional profile) | host `3001/tcp`, bound to VPS localhost |

Do not add host-side mappings for internal ports. Caddy reaches them through
Docker networks by service name. The Tuki Core `/metrics` endpoint is intended
for an internal Prometheus collector and is deliberately not exposed by Caddy.
