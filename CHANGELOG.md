# Changelog

All notable changes to this project will be documented in this file.

## [0.1.8] - 2025-02-15

### Bug Fixes

- view-original header extraction for HTML emails
- recipient paste parsing — "First Last email@addr.com" creates one chip
- search while reading email — close reader and load correct body in classic view
- empty-inbox account switch no longer shows stale messages
- preserve parent-level attachments when extracting nested rfc822 parts

## [0.1.5] - 2025-01-28

### Bug Fixes

- leverage special-use flags from IMAP for folder list order
- extract nested attachments from message/rfc822 MIME parts, filter CSS from preview
- attachment positioning, sent folder display, selection mode, folder sorting, contact sorting, compose from-name
- inline image rendering
- improve attachment detection for nested MIME structures, deduplication, and fallback naming
- update and add to unit and e2e tests
- attachment display — missing onAttachments callback, 0 KB size, inline image preview
- sent folder allow cleared preference when choosing auto-detect
- dynamic system folder protection, specialUse flag detection, sent folder priority

## [0.1.0] - 2025-01-15

### Features

- initial open-source release

### Bug Fixes

- pgp passphrase prompt on setup, pagination flickering
- filter empty state UX issue
- add offline banner
