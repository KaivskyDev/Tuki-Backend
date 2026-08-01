# Tuki service contract

This deployment exposes only routes implemented by the running services.
Feature flags are not treated as implementations.

## Payments

- `GET /v1/payments/plans` — public plan metadata.
- `GET /v1/payments/me` — current membership and recent orders.
- `GET /v1/memberships/:userId/badge` — public-facing active Orbit badge metadata for an authenticated viewer.
- `POST /v1/payments/hotpay/checkout` — authenticated server-side HotPay initialisation.
- `POST /v1/payments/hotpay/notification` — signed HotPay notification receiver.
- `GET /v1/uploads/authorize` — internal reverse-proxy upload authorisation;
  applies free and Orbit Max size/quota limits before Autumn receives a body.

`orbit_30d` is the profile membership. `orbit_max_30d` is published in plan
metadata but checkout remains disabled by default until the 500 MB upload and
cross-community media entitlements are enforced by the storage/API layer. Do
not enable `TUKI_HOTPAY_ORBIT_MAX_ENABLED` before that enforcement is deployed.

`GET /v1/uploads/authorize` is an internal reverse-proxy subrequest, not a
browser upload endpoint. Nginx/Caddy passes the original upload path, method,
content length and account authorisation to it before proxying the request body
to Autumn. Read requests do not use this check. The 500 MB Autumn ceiling is
safe only while every public upload path is protected by this authoriser.

HotPay panel: set the notification URL to
`https://core.muzes.xyz/v1/payments/hotpay/notification`, use the exact
`TUKI_HOTPAY_NOTIFICATION_PASSWORD`, and select a mailbox monitored by the
operator. Pay by Link grants 30 days after a verified `SUCCESS`; it does not
create an automatic recurring charge.

| Public service | URL | Internal service |
| --- | --- | --- |
| Web application | `https://chat.muzes.xyz` | separately deployed frontend |
| Service status page | `https://chat.muzes.xyz/status` | frontend reachability view |
| Core API (compatible routes) | `https://core.muzes.xyz` | `api:14702` |
| Tuki Core API v1 | `https://core.muzes.xyz/v1` | `tuki-core:14800` |
| Tuki health and OpenAPI | `https://core.muzes.xyz/health/*`, `/openapi.json` | `tuki-core:14800` |
| Realtime Gateway | `wss://gateway.muzes.xyz` | `events:14703` |
| User content CDN | `https://cdn.muzes.xyz` | `autumn:14704` |
| Embed/image proxy | `https://media.muzes.xyz` | `january:14705` |
| GIF proxy | `https://media.muzes.xyz/gifbox` | `gifbox:14706` |
| Voice signalling | `wss://voice.muzes.xyz/livekit` | `livekit:7880` |
| Voice ingress | `https://voice.muzes.xyz/ingress` | `voice-ingress:8500` |
| Invite links | `https://invite.muzes.xyz/:code` | web redirect |
| Developer API definition | `https://developers.muzes.xyz` | `tuki-core:14800` |
| Search | `https://search.muzes.xyz/v1/search` | `tuki-core:14800` |

The compatible HTTP and Gateway payloads follow the upstream protocol used by
Tuki's web client. Product-specific endpoints live in the separately built
Tuki Core service and are versioned under `/v1`.

Implemented Tuki Core areas: extended profiles, bookmarks, private inbox,
polls, events and RSVP, community discovery with live presence and cached
seven-day message activity, managed invite links with expiry and usage limits,
forums, Tuki-owned search,
reports, moderation history, appeals, raid mode, AutoMod configuration,
notification preferences, registered-browser history, security history,
session listing and revocation, developer applications, plans and entitlements, health checks, metrics and
OpenAPI. Account deletion uses a 30-day cancellable queue and an atomic
background purge claim so multiple Core replicas cannot process the same
account concurrently. Recovery codes, passkeys and TOTP are reported as
identity-service integrations instead of being simulated by the sidecar.
Message-content search still requires a permission-aware index fed by the
compatible messaging API.

## Privacy and community safety

| Method | Route | Access |
| --- | --- | --- |
| `GET` / `PUT` / `PATCH` | `/v1/account/privacy` | signed-in account |
| `GET` / `POST` | `/v1/servers/:serverId/automod/rules` | community owner |
| `PATCH` / `DELETE` | `/v1/servers/:serverId/automod/rules/:ruleId` | community owner |
| `GET` | `/v1/servers/:serverId/audit-log` | community owner |

AutoMod endpoints persist validated rules and their configuration audit events.
Enforcement against live messages must be connected to the compatible message
pipeline before these rules can block content in real time.
