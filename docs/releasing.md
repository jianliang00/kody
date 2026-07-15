# Releasing Kody for macOS

Kody's macOS release is signed with a Developer ID Application certificate,
submitted to Apple's notary service, stapled, and checked with Gatekeeper before
GitHub publishes it. The release workflow builds native Apple Silicon and Intel
DMGs and updater ZIPs on separate GitHub-hosted runners.

The source repository is public. Signed artifacts are also mirrored to the
artifact-only [`jianliang00/kody-releases`](https://github.com/jianliang00/kody-releases)
repository so installed clients can update from a minimal public feed without
embedding a GitHub token.

## Local release

Prerequisites:

- `Developer ID Application: Jianliang Wang (BZP4VMX57B)` in the login keychain.
- An authenticated `asc` profile (`asc auth status`).
- Node.js 24, Rust 1.87 or newer, and Xcode command-line tools.

Run:

```bash
npm run release:mac
```

The script signs `Kody.app`, submits both the updater ZIP and DMG with
`asc notarization submit`, staples the DMG ticket, and asks Gatekeeper to
validate the app from both archives. It also creates `latest-mac.yml` and the
ZIP blockmap consumed by `electron-updater`.

## GitHub Actions secrets

Configure these repository Actions secrets before manually running the release
workflow:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_B64` | Base64-encoded PKCS#12 containing the Developer ID identity |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting that PKCS#12 |
| `KEYCHAIN_PASSWORD` | Random password for the workflow's temporary keychain |
| `ASC_KEY_ID` | App Store Connect API key ID |
| `ASC_ISSUER_ID` | App Store Connect issuer ID |
| `ASC_PRIVATE_KEY_B64` | Base64-encoded App Store Connect `.p8` private key |
| `KODY_RELEASES_TOKEN` | GitHub token with Contents write access to `jianliang00/kody-releases` |

Run the release workflow with a version tag to build, notarize, staple, create
the source release, and publish DMGs, architecture-specific ZIPs, blockmaps, and
merged `latest-mac.yml` metadata to the public update repository. Secrets are
only exposed to the release jobs and never passed into the packaged application.

## Client update flow

Packaged macOS builds check for updates shortly after launch and every four
hours. Automatic checks stay quiet when the network is unavailable. A user can
also choose **Kody → Check for Updates…**. Downloads start only after the user
accepts the available version; the title bar reports progress and offers
**Restart to update** when verification finishes. A downloaded update also
installs on a normal app quit.

The first updater-capable version must be installed normally. Every subsequent
release can update that version in place.
