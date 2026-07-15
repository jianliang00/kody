# Security policy

## Supported versions

Kody is pre-1.0 and evolves quickly. Security fixes are provided for the latest released version only.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub's private vulnerability reporting form](https://github.com/jianliang00/kody/security/advisories/new) and include:

- the affected version and platform;
- a minimal reproduction or proof of concept;
- the expected and observed security boundary;
- impact and any known mitigations;
- whether the report or exploit details have been shared elsewhere.

Do not include real API keys, bearer tokens, Codex credentials, conversation data, or private repository contents. The maintainers will acknowledge a complete report as soon as practical, investigate it, and coordinate disclosure and a fix based on severity.

## Security scope

High-priority areas include:

- file path traversal or symlink escape outside authorized Workspaces and Projects;
- command execution that bypasses the selected permission mode or approval broker;
- renderer access to provider keys, server tokens, Codex credentials, or privileged RPCs;
- remote access that bypasses loopback, bearer-token, or WebSocket Origin checks;
- managed-process escape, orphaning, output leakage, or cross-Thread access;
- prompt or tool output causing script execution in the Electron renderer;
- updater signature, release provenance, or artifact substitution failures.

Native command execution is not an operating-system sandbox. `Full access` intentionally permits commands without Kody approval, and the user is responsible for the selected Projects and external containment environment. Reports that only demonstrate this documented behavior are not vulnerabilities unless another stated boundary is bypassed.
