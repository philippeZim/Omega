# Releasing

1. Bump the version in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`.
2. Add the version's entry to `CHANGELOG.md`, written for users, with the release date in its heading (`## [0.2.0] - 2026-11-22`). A tag build fails right away if the entry is missing or still says `Unreleased`.
3. Commit, tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
4. GitHub Actions builds Windows, macOS and Linux and creates a **draft** release. Check it and publish it. Installed copies offer the update on their next start.

## Release notes

`CHANGELOG.md` is the source of the release notes. `dev/changelog-notes.mjs <version>` prints a version's entry, and the release workflow uses it in two places:

- **In-app update dialog:** the entry as plain text (`--plain`) goes through `tauri-action`'s `releaseBody` into the `notes` field of `latest.json`. The dialog shows that field and doesn't render Markdown.
- **GitHub release page:** the `release-notes` job runs once after all builds succeeded and sets the page to the Markdown entry plus the download table. If a build failed, the page keeps the plain notes until a rerun succeeds.

Editing the draft on GitHub does **not** change `latest.json`, so the update dialog would keep the old text. To change the notes, edit `CHANGELOG.md` and rebuild. A rebuild also overwrites manual edits to the release page.

## Signing

Update bundles are signed. The workflow reads the private key from the repository secret `TAURI_SIGNING_PRIVATE_KEY`; the public key is in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. If the private key is lost, existing installs can no longer be updated, so keep a backup.

A local `pnpm tauri build` also signs and therefore needs `TAURI_SIGNING_PRIVATE_KEY` set (path or contents of the key). Without it, use `pnpm tauri build --no-bundle`.

## Notes

- Drafts and pre-releases are invisible to the updater; only the latest published release counts.
- On Linux only the AppImage updates itself. `.deb` / `.rpm` installs must be updated manually.
- macOS: if Gatekeeper says the app is damaged, `xattr -cr /Applications/Omega.app` fixes it.
