# WhatsApp Blaster

Bulk WhatsApp invite tool for internal team use. Offline desktop app — local SQLite
database, no cloud, no login gate. Drives the real WhatsApp desktop app directly (keyboard
automation), so it needs WhatsApp already installed and signed in.

Windows is the primary, fully-tested platform. **A macOS build also ships (`.dmg`/`.zip`)
but is currently BETA / UNVERIFIED** — it was written without access to a Mac; see
[decisions.md](docs/decisions.md) before relying on it for a real campaign.

**Just want to use it?** Download the latest installer from
[Releases](https://github.com/harshkawatra11/whatsapp-blaster/releases) and read the
[user guide](docs/README.md) — it covers both platforms, including the Gatekeeper and
Accessibility-permission steps macOS needs that Windows doesn't.

## Documentation

Full docs live in [`docs/`](docs/README.md):

- [User guide](docs/user-guide.md) — installing and using the app
- [Operations](docs/operations.md) — sending safely, anti-ban pacing
- [Architecture](docs/architecture.md) — stack, data model, HTTP API
- [Decisions](docs/decisions.md) — why it's built this way

## Development

```
npm install
npm start          # plain Node, http://127.0.0.1:3000
npm run electron    # run through the Electron shell
npm run dist         # build an unsigned installer for the current OS into dist/, no publish
npm run release      # manual publish path — build and publish a GitHub Release (needs GH_TOKEN)
npm run mac:doctor   # macOS only — interactive verification harness for wa/desktop.mac.js
```

Requires Node ≥ 22 (for the built-in `node:sqlite` module) and, for actually sending, either
a Windows machine with WhatsApp Desktop installed and signed in, or a Mac with WhatsApp for
Mac installed, signed in, and Accessibility permission granted to the app (the in-app banner
walks you through this on first launch).

`npm run dist` builds only for the OS it runs on — there's no macOS build from Windows or
vice versa. CI (`.github/workflows/release.yml`) builds both on every real release, using a
free `macos-latest` GitHub Actions runner for the Mac build.

**Shipping an update:** normally you don't run `npm run release` yourself — bump `version` in
`package.json`, commit, and push to `main`. GitHub Actions builds and publishes both
platforms automatically. A push with no version bump ships nothing. Windows installs show an
in-app update banner and install automatically on next close; **macOS has no auto-update**
(no paid Apple signing certificate — see [decisions.md](docs/decisions.md)), so Mac users see
a "Download" link to the new release instead.
