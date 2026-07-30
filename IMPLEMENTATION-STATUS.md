# Tuki implementation status

This file prevents planned features from being presented as production-ready.

## Implemented

- Tuki Core `/v1` with session validation, rate limiting and OpenAPI
- extended profiles and per-field privacy preferences
- bookmarks and inbox actions
- polls, events and RSVP
- community discovery with live presence, server emoji, new-server metadata and
  cached seven-day message activity
- Tuki-managed invite links with atomic usage limits and expiry
- forum threads, posts, pinning and locking
- search across Tuki communities, forums and events
- reports, immutable report submission, review queue and moderation history
- appeals, AutoMod configuration and raid-mode configuration
- registered-browser and security event history
- session inventory, single-session revocation and revoking all other sessions
- OAuth state protected with PKCE, an allowlisted callback and keyed HMAC
- notification preferences, weekly quiet-hour schedule and digest preference
- developer apps, scoped credentials, secret rotation and usage contract
- Free and Plus product limits with entitlement storage
- cancellable 30-day account deletion queue and scheduled Core/identity data purge
- Prometheus and Grafana optional deployment profile

## Integration required before production use

- extend the current fail-closed server-membership checks with channel-level
  permission evaluation from the messaging API
- execute timeout, kick, ban and global-block actions in the identity/messaging
  services; Tuki Core currently records their audited decision
- connect billing to a selected payment provider and signed webhooks
- connect Web Push delivery to VAPID and the existing push service
- connect file scanning, EXIF stripping, thumbnails and quota checks to Autumn
- connect account-deletion jobs to Autumn/MinIO object erasure and immutable
  legal-retention policy before claiming that every binary object is purged
- configure coturn/TURN-TLS and regional LiveKit nodes
- move passkeys, TOTP and login throttling into the identity service; a sidecar
  cannot safely replace login semantics
- issue and verify recovery codes in the identity service; Tuki Core deliberately
  returns `501 identity_integration_required` instead of creating unusable codes
- add per-person, per-server and per-channel notification overrides to the
  delivery pipeline before exposing those controls in the web client
- build the native Tuki Bot Gateway, interactions API, installation grants and
  SDK before claiming runtime compatibility with Discord bots
- add an explicit post-registration onboarding hook in the identity service
  before automatically joining the support community; Tuki does not silently
  create friendships on behalf of a new user
- build a permission-aware message index before enabling message-content search
- add Loki/Alloy or another log backend after retention and storage sizing are
  selected

## Deliberately not claimed

The application does not claim that payment collection, passkey login,
recovery-code login, antivirus scanning, TURN failover, Discord bot execution
or message search is complete merely because an API shape or UI label exists.
