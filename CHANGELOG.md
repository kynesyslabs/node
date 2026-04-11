# Changelog

All notable changes to the Demos Network Node will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
