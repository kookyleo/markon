# Release Process

Markon uses a dual-channel (RC / Stable) release model with automated CI/CD pipelines.

## Overview

```
Cargo.toml version change → push to main
        │
        ▼
   Auto RC workflow
   (auto-rc.yml)
        │
        ▼
   Tag: v0.9.0-rc.1
        │
        ▼
   Release workflow (release.yml)
   Build 3 platforms → Draft release → Sign → Publish as prerelease
   Upload latest-rc.json to "updater" release
        │
        ▼
   7 days, no issues, no newer RC
        │
        ▼
   Auto Promote (auto-promote.yml, daily cron)
        │
        ▼
   Promote workflow (promote.yml)
   Copy RC assets → Create stable release v0.9.0
   Upload latest.json to "updater" release
```

## How to Release

### 1. Bump version

Edit `Cargo.toml` (single source of truth):

```toml
[workspace.package]
version = "0.9.0"
```

Push to `main`. That's it — CI handles the rest.

### 2. What happens automatically

1. **auto-rc.yml** detects the version change, creates tag `v0.9.0-rc.1`
2. **release.yml** builds all 3 platforms (macOS/Linux/Windows), creates a prerelease, uploads `latest-rc.json` to the permanent `updater` release
3. **auto-promote.yml** runs daily — if the RC is ≥7 days old with no open `release-blocker` issues, it triggers promotion
4. **promote.yml** copies all RC assets to a new stable release `v0.9.0` and uploads `latest.json`

### 3. Manual override

Promote an RC immediately without waiting 7 days:

```bash
gh workflow run promote.yml -f rc_tag=v0.9.0-rc.1
```

Push a new RC (e.g. after a hotfix, version unchanged):

```bash
# auto-rc only triggers on version *change*, so for same-version re-RC:
git tag v0.9.0-rc.2
git push origin v0.9.0-rc.2
```

## Update Channels

Clients check for updates from a permanent GitHub release tagged `updater`:

| Channel | Manifest | Audience |
|---------|----------|----------|
| **Stable** (default) | `updater/latest.json` | All users |
| **RC** | `updater/latest-rc.json` | Opt-in testers |

Users switch channels in Settings → Preferences → Update channel.

## Signing

Updater packages are signed with a minisign keypair:

- **Public key**: embedded in `crates/gui/tauri.conf.json` → `plugins.updater.pubkey`
- **Private key**: GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` (no password)

To regenerate:

```bash
cargo tauri signer generate -w ~/.tauri/markon.key -p "" --ci
# Update pubkey in tauri.conf.json
# Update TAURI_SIGNING_PRIVATE_KEY secret
```

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `auto-rc.yml` | Push to main (Cargo.toml changed) | Auto-tag RC |
| `release.yml` | Tag push `v*` | Build + sign + publish |
| `auto-promote.yml` | Daily cron 08:00 UTC | Check and auto-promote |
| `promote.yml` | Manual (`workflow_dispatch`) | Promote RC → Stable |
| `ci.yml` | Push/PR to main | Test + lint |

## Build Optimizations

- **Rust cache**: `Swatinem/rust-cache` caches dependencies across builds (7-day TTL)
- **cargo-binstall**: Downloads pre-built `tauri-cli` binary instead of compiling from source
- **Release profile**: `strip = true`, `lto = true`, `codegen-units = 1`, `opt-level = "s"`
