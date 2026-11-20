# Tab Volume Normalizer — Firefox extension

Evens out loud and quiet audio in a tab. Click the toolbar button to turn
volume normalization on or off for the current tab.

## Features

- **One click, per tab** — the toolbar button toggles normalization for the tab
  you are on. The setting follows the tab across navigation and applies to
  iframes; it is forgotten when the tab closes or Firefox restarts.
- **Tab indicator** — while audio in a tab is actually being normalized, the
  tab's favicon gets the extension's icon badged onto its corner.
- **No data collected** — everything happens locally in the browser.

## Requirements

Firefox 128 or newer.

## Install

1. Go to the [**Releases**](../../releases) page and download the latest
   `tab-volume-normalizer-<version>.xpi`.
2. Open that `.xpi` in Firefox (or `about:addons` → gear → *Install Add-on From
   File…*) and confirm the prompt.
3. The build is signed, so it stays installed across restarts and updates
   itself when a new release ships.

## How it works

Audio from `<audio>` and `<video>` elements is routed through a Web Audio
`DynamicsCompressorNode`, which squashes loud passages and lifts quiet ones.
The tuning values are at the top of `content.js`.

## Limitations

- Media served from another domain without CORS headers is left alone, because
  routing it through Web Audio would silence it. Blob-based streaming players
  are not affected.
- Sound a page plays without a media element in the document (a detached
  `new Audio()`, or the page's own Web Audio graph) is not normalized.

## Development

```
npm install
npm run lint     # web-ext lint
npm start        # run in a temporary Firefox profile
npm run build    # unsigned .zip in web-ext-artifacts/
```

Releases: bump `version` in `manifest.json` and `package.json`, then publish a
GitHub Release tagged `vX.Y.Z`. The release workflow signs the build with
addons.mozilla.org (unlisted) when the `WEB_EXT_API_KEY` and
`WEB_EXT_API_SECRET` repository secrets are set, and attaches the `.xpi` and
`updates.json`. A version number can only be signed once.

## License

[MIT](./LICENSE)
