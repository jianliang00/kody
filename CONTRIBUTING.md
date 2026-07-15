# Contributing to Kody

Thank you for helping improve Kody. Contributions can include bug reports, design discussions, documentation, tests, provider adapters, runtime changes, and desktop work.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use a GitHub Security Advisory for vulnerabilities; do not disclose them in a public issue.
- Open an issue before a large architectural change so ownership and protocol implications can be discussed early.
- Keep pull requests focused. Unrelated cleanup should be a separate change.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Follow [docs/development.md](docs/development.md) for prerequisites, bootstrap commands, tests, and repository conventions.

## Pull requests

1. Create a branch from the latest `main`.
2. Add or update tests for behavior changes.
3. Update protocol and architecture documentation when public behavior changes.
4. Run the Rust and desktop checks listed in the development guide.
5. Explain the problem, the chosen design, security implications, and validation in the pull request.

Commit messages should be concise and imperative. Conventional prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:` are encouraged but not required.

Maintainers may ask to split a pull request when it combines independent changes. Review feedback should be resolved with new commits during review; maintainers may squash when merging.

## Design expectations

- Preserve the Thread, Project, Workspace, and reference ownership model.
- Keep transport and provider wire formats out of `kody-core`.
- Treat model output as untrusted input at every tool, path, process, and renderer boundary.
- Prefer durable state and explicit lifecycle transitions over UI-only state.
- Do not weaken permission checks or expose credentials for convenience.
- Keep the desktop keyboard accessible and usable in narrow windows.

## Licensing

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in Kody is licensed under both MIT and Apache-2.0, at the user's option, without additional terms or conditions.
