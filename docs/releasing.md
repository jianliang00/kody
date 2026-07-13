# Releasing Kody for macOS

Kody's macOS release is signed with a Developer ID Application certificate,
submitted to Apple's notary service, stapled, and checked with Gatekeeper before
GitHub publishes it. The release workflow builds native Apple Silicon and Intel
DMGs on separate GitHub-hosted runners.

## Local release

Prerequisites:

- `Developer ID Application: Jianliang Wang (BZP4VMX57B)` in the login keychain.
- An authenticated `asc` profile (`asc auth status`).
- Node.js 24, Rust 1.87 or newer, and Xcode command-line tools.

Run:

```bash
npm run release:mac
```

The script signs `Kody.app`, submits the DMG with `asc notarization submit`,
staples the accepted ticket, mounts the DMG read-only, and asks Gatekeeper to
validate the notarized app inside it.

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

Run the release workflow with `v0.1.0` to build, notarize, staple, create the tag,
and publish both DMGs. Secrets are only exposed to the release jobs and never
passed into the packaged application.
