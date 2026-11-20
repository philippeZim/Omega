# Releasing

1. Bump the version in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`.
2. Commit, tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. GitHub Actions builds Windows, macOS and Linux and creates a **draft** release. Write the notes (they appear in the in-app update dialog) and publish it. Installed copies offer the update on their next start.

## Signing

Update bundles are signed. The workflow reads the private key from the repository secret `TAURI_SIGNING_PRIVATE_KEY`; the public key is in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. If the private key is lost, existing installs can no longer be updated, so keep a backup.

A local `pnpm tauri build` also signs and therefore needs `TAURI_SIGNING_PRIVATE_KEY` set (path or contents of the key). Without it, use `pnpm tauri build --no-bundle`.

## Notes

- Drafts and pre-releases are invisible to the updater; only the latest published release counts.
- On Linux only the AppImage updates itself. `.deb` / `.rpm` installs must be updated manually.
- macOS: if Gatekeeper says the app is damaged, `xattr -cr /Applications/Omega.app` fixes it.
