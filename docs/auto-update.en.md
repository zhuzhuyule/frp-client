# Auto-update explained

Two halves: **users only need the first one**; read the second half if you cut releases.

## 1. As a user: nothing to configure

Install it and it just works — updates included:

1. On launch the app silently reads `latest.json` from GitHub Releases;
2. when a newer version exists, an "Update now" action appears in the sidebar;
3. one click → download → minisign verification → replace → relaunch.

Running frpc tunnels are untouched, and you never fill in a URL, a key, or a command. Packages used per platform: macOS `.app.tar.gz`, Windows NSIS `.exe`, Linux AppImage.

### The two cases where you do have to act once

- **You installed v0.2.x or earlier**: those binaries contain no updater code at all, so they will never auto-jump to v0.3.0 — reinstall once by hand (from v0.3.0 on it's automatic forever).
- **Gatekeeper blocks the first macOS install**: packages carry a minisign update signature only — no Apple developer certificate, no notarization — so you may see "is damaged" or "cannot be verified". Prefer dragging the app from the `.dmg` into Applications; if it does block you, run this once (built-in automatic updates never need it, since the updater's own download carries no quarantine flag):

  ```bash
  xattr -dr com.apple.quarantine /Applications/FRP\ Client.app
  ```

## 2. As a maintainer: releasing is just a tag

The signing setup is one-time. Afterwards every release is a single command:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

CI (`.github/workflows/build.yml`) builds all three platforms, signs, publishes the Release and generates `latest.json`.

### One-time setup: the minisign key

The public half already lives in `plugins.updater.pubkey` inside `tauri.conf.json`; generate a key only when you need a new one:

```bash
# -p '' means no passphrase — see the next section
cargo tauri signer generate -w ~/.tauri/frp-client.key -p ''
```

Configure **exactly one** repository Secret: `TAURI_SIGNING_PRIVATE_KEY` (the full contents of the private key file).

**Do not set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.** The private key has no passphrase, yet as long as this Secret exists with a value, CI tries to unlock the key with it and fails:

```
failed to decode secret key: incorrect updater private key password
```

Empty or absent both sign fine; any placeholder value breaks all three platforms (this is exactly what killed the first v0.3.0 CI run).

One more thing: **a local `cargo tauri build` without `TAURI_SIGNING_PRIVATE_KEY` set fails at the bundling step because it cannot sign.** Everyday `cargo tauri dev` and `cargo build --release` are unaffected; to produce an updatable package locally, run `export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/frp-client.key)"`.

### Two facts about the signing

- **Lose the private key and every installed client stops receiving updates forever.** Leak it and anyone can push arbitrary code to all users. It is not in git history — it lives only on the maintainer machine and in the repository Secret.
- **This signature chain is not Apple notarization.** minisign proves the update came from this project; Gatekeeper's "cannot be verified by Apple" warning remains. Curing it requires a $99/year Apple developer account plus notarytool.

### Three `latest.json` gotchas (all handled in the workflow)

1. `tauri-action` uploads `latest.json` **only when a `.sig` exists** — with a missing private key the Release still publishes, silently without update metadata.
2. `latest.json` points Windows at `.msi` by default, but the updater cannot install msi; `updaterJsonPreferNsis: true` is required.
3. macOS `--target universal-apple-darwin` produces a single `.app.tar.gz` that the action splits into the `darwin-aarch64` and `darwin-x86_64` keys; clients look up `{os}-{arch}`, so universal needs no special handling.

### Worth checking after a release

```bash
gh release view vX.Y.Z --json isDraft,publishedAt
gh release download vX.Y.Z -p latest.json --clobber   # inspect version and platforms keys
```

To really verify a signature, download the archive plus its `.sig` and check them with `minisign-verify`, the same crate the client uses. Note that both the `.sig` file and the `pubkey` in the config are base64-wrapped minisign text blocks and must be decoded first; the algorithm marker is `ED` (prehashed), so hand-rolled Ed25519 verification will not match.
