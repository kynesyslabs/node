# Changelog

All notable changes to the Demos Network Node will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Changed
- `SIGNALING_REGISTER_MODE` selects `transitional` (default) or `strict`.
- Clients request a `register_challenge` by sending `{type:"register_challenge",payload:{}}`; in `strict`, registration requires an ed25519-signed proof over that challenge, and the client ID must be the `0x`-prefixed hex of the signing key.
- A connection may register one client ID.
- Signaling client IDs longer than 256 characters must be the hex of the registering key.
- A registration proof without a challenge must sign exactly the advertised public key bytes.
- Queued offline messages are delivered only to a client ID registered with a challenge-bound proof from its own signing key; clients using the legacy registration proof do not receive them.
- In `transitional` mode, a message to an offline recipient is refused with an error and nothing is stored. In `strict` mode, offline messages are queued only for client IDs in key form (`0x` followed by 64 lowercase hex characters).

## [0.9.8] - 2026-04-11

### Changed
- Repository cleanup: removed tracked secrets, junk files, and AI tool artifacts
- Unified license to CC BY-NC-SA 4.0 across all project files
- Rewrote .gitignore from scratch (deduplication and comprehensive coverage)
- Merged duplicate .env.example files into single organized file

### Security
- Removed expired SSL certificates and private keys from tracking
- Removed hardcoded credentials from tracked configuration files
- Sanitized deployment scripts to remove internal infrastructure details

### Fixed
- QueryFailedError crash fix

## [0.9.7] and earlier

See [git history](../../commits/main) for changes prior to this version.
