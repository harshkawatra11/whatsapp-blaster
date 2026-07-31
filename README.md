# RYS WhatsApp Blaster

Bulk WhatsApp invite tool for Rajdhani Yuva Sansad (MUN) participants. Offline Windows
desktop app — local SQLite database, no cloud, no login gate. Drives the real WhatsApp
Desktop app directly (keyboard automation), so it needs WhatsApp Desktop already installed
and signed in.

**Just want to use it?** Download the latest installer from
[Releases](https://github.com/harshkawatra11/rys-whatsapp-blaster/releases) and read the
[user guide](docs/README.md).

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
npm run dist         # build an unsigned Windows installer into dist/, no publish
npm run release      # manual publish path — build and publish a GitHub Release (needs GH_TOKEN)
```

Requires Node ≥ 22 (for the built-in `node:sqlite` module) and, for actually sending, a
Windows machine with WhatsApp Desktop installed and signed in.

**Shipping an update:** normally you don't run `npm run release` yourself — bump `version` in
`package.json`, commit, and push to `main`. GitHub Actions (`.github/workflows/release.yml`)
builds and publishes automatically; every installed copy shows an in-app update banner and
installs on its next close. A push with no version bump ships nothing.
