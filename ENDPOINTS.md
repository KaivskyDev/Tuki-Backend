# Tuki service contract

This deployment exposes only routes implemented by the running services.
Feature flags are not treated as implementations.

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
polls, events and RSVP, community discovery, forums, Tuki-owned search,
reports, moderation history, appeals, raid mode, AutoMod configuration,
notification preferences, registered-browser history, security history,
developer applications, plans and entitlements, health checks, metrics and
OpenAPI. Account deletion uses a 30-day cancellable queue and an atomic
background purge claim so multiple Core replicas cannot process the same
account concurrently. Recovery codes, passkeys, TOTP and remote session revocation are
reported as identity-service integrations instead of being simulated by the
sidecar. Message-content search still requires a permission-aware index fed by
the compatible messaging API.
