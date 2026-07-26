# Tuki implementation status

This file prevents planned features from being presented as production-ready.

## Implemented

- Tuki Core `/v1` with session validation, rate limiting and OpenAPI
- extended profiles and per-field privacy preferences
- bookmarks and inbox actions
- polls, events and RSVP
- community discovery
- forum threads, posts, pinning and locking
- search across Tuki communities, forums and events
- reports, immutable report submission, review queue and moderation history
- appeals, AutoMod configuration and raid-mode configuration
- devices, security event history and hashed recovery codes
- notification preferences and quiet hours
- developer apps, scoped credentials, secret rotation and usage contract
- Free and Plus product limits with entitlement storage
- Prometheus and Grafana optional deployment profile

## Integration required before production use

- extend the current fail-closed server-membership checks with channel-level
  permission evaluation from the messaging API
- execute timeout, kick, ban and global-block actions in the identity/messaging
  services; Tuki Core currently records their audited decision
- connect billing to a selected payment provider and signed webhooks
- connect Web Push delivery to VAPID and the existing push service
- connect file scanning, EXIF stripping, thumbnails and quota checks to Autumn
- configure coturn/TURN-TLS and regional LiveKit nodes
- move passkeys, TOTP, login throttling and upstream session revocation into the
  identity service; a sidecar cannot safely replace login semantics
- build a permission-aware message index before enabling message-content search
- add Loki/Alloy or another log backend after retention and storage sizing are
  selected

## Deliberately not claimed

The application does not claim that payment collection, passkey login,
antivirus scanning, TURN failover or message search is complete merely because
an API shape or UI label exists.
