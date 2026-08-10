# Changelog

All notable changes to Kody are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning while the project is pre-1.0.

## [Unreleased]

## [0.1.19] - 2026-08-10

### Added

- Added a native-style hierarchical model menu for model, reasoning effort, and per-Turn Fast mode selection.
- Added persistent provider selection in Settings with provider-specific account and configuration details.
- Added a focused Context details dialog for inspecting Thread references and managed processes on demand.

### Changed

- Refined the desktop typography, system colors, form controls, menus, focus states, and light/dark appearance to more closely match native macOS applications.
- Simplified the Inspector to a single collapsible Context section, kept Projects in the Workbench, and made long Workspace paths horizontally scrollable.
- Moved provider selection out of the composer and preserved model, effort, and Fast choices in Thread drafts.
- Passed reasoning effort and Fast service-tier choices through the persisted Turn model and Codex app-server backend.

### Fixed

- Made Codex account information follow the selected provider and restored provider catalog discovery when Codex is available.
- Harmonized composer control sizing, border treatment, menu selection colors, and empty-state typography.

## [0.1.18] - 2026-08-09

### Added

- Added multimodal image input with model-capability checks, secure local image handling, and composer previews.
- Added a macOS-style Workbench with New Progress, Continue Later, In Progress, Processed, All Threads, and Project views.
- Added durable Thread to-do workflow states with list shortcuts, contextual actions, title-bar controls, RPC validation, and legacy-state migration.

### Changed

- Reworked the desktop into a four-column macOS layout with independently collapsible Workbench, Thread list, and Inspector regions.
- Extended the unified title bar across the Inspector and aligned sidebar typography, spacing, controls, and dark-mode contrast with native macOS conventions.
- Made Inspector sections independently collapsible while preserving active context and managed-process visibility.

## [0.1.17] - 2026-07-18

### Changed

- Removed the redundant connected-state label from the title bar and refined the update controls.

## [0.1.16] - 2026-07-18

### Added

- Added provider-neutral image generation with configurable provider and model catalogs, including OpenAI-compatible `/images/generations` support.
- Added a desktop image composer with model, size, quality, format, and image-count controls, plus durable in-conversation previews and downloads.
- Added the approval-aware `generate_image` Agent tool and authenticated, bounded artifact delivery from Thread Workspaces.

### Changed

- Extended versioned Thread state and snapshots with atomic image Artifact metadata while keeping binary image data outside JSON persistence and JSON-RPC.

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

[Unreleased]: https://github.com/jianliang00/kody/compare/v0.1.19...HEAD
[0.1.19]: https://github.com/jianliang00/kody/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/jianliang00/kody/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/jianliang00/kody/compare/v0.1.16...v0.1.17
[0.1.16]: https://github.com/jianliang00/kody/compare/v0.1.15...v0.1.16
[0.1.7]: https://github.com/jianliang00/kody/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/jianliang00/kody/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/jianliang00/kody/releases/tag/v0.1.5
[0.1.4]: https://github.com/jianliang00/kody/releases/tag/v0.1.4
[0.1.3]: https://github.com/jianliang00/kody/releases/tag/v0.1.3
