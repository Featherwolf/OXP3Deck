# Third-party source

- `decky-api-1.1.3/`: the source of `@decky/api` 1.1.3 by the SteamDeckHomebrew Team
  (https://github.com/SteamDeckHomebrew/loader-api), unchanged from its npm package (`src/`, `package.json`,
  `README.md`, `LICENSE`; the package's integrity is in `../pnpm-lock.yaml`). It is under the GNU Lesser General
  Public License 2.1, in `decky-api-1.1.3/LICENSE`. The plugin's `dist/index.js` includes part of this library, and
  the licence asks that its source can be had from the same place as the plugin, so it is kept here. The build does
  not use this copy (it uses `node_modules/@decky/api`). How to build the plugin with a changed copy is in
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
