# Changelog

All notable changes to Kody are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning while the project is pre-1.0.

## [Unreleased]

## [0.1.7] - 2026-07-15

### Changed

- Moved settings and update status into the left sidebar and placed the Kody title below the macOS window controls.
- Separated the controls for collapsing the entire right sidebar and expanding its Content & activity details.
- Unified the context card typography with the rest of the desktop interface.

### Fixed

- Keep the application shell fixed while long conversations scroll only inside the message timeline.
- Recompute updater hashes and sizes from final notarized/stapled artifacts and use the Intel ZIP as the legacy macOS update path.

## [0.1.6] - 2026-07-15

### Added

- Added an English project entry point, Simplified Chinese overview, documentation index, development guide, dual MIT/Apache-2.0 licenses, contribution guide, security policy, code of conduct, and GitHub collaboration templates.
- Added public package metadata and bundled license texts to desktop distributions.

### Changed

- Standardized the public repository structure and project documentation.
- Consolidated desktop typography onto a shared token scale, reduced font weights, and reduced the composer from three initial rows to two.

## [0.1.5] - 2026-07-14

### Added

- Per-Turn Read only, Ask for commands, and Full access permission modes across the native runtime, Codex backend, App Server, persistence, and desktop composer.

### Changed

- Applied current Codex approval and sandbox policies for each Kody permission mode.

## [0.1.4] - 2026-07-14

### Fixed

- Isolated Codex approval ownership so another Codex client cannot cause stale approvals in Kody.
- Kept command approval cards above the composer.

## [0.1.3] - 2026-07-14

### Added

- Signed in-app updates backed by public GitHub Release artifacts.

[Unreleased]: https://github.com/jianliang00/kody/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/jianliang00/kody/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/jianliang00/kody/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/jianliang00/kody/releases/tag/v0.1.5
[0.1.4]: https://github.com/jianliang00/kody/releases/tag/v0.1.4
[0.1.3]: https://github.com/jianliang00/kody/releases/tag/v0.1.3
