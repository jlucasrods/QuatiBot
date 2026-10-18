# Bot browser: provenance and notices

QuatiBot supports Linux and uses these third-party browser components:

- **agent-browser 0.37.0**, the official Vercel release executables:
  <https://github.com/vercel-labs/agent-browser/releases/tag/v0.37.0>.
  `server/browser-engine-release.ts` pins the Linux glibc and musl assets by
  size and SHA-256. Its Apache-2.0 license is in `agent-browser-LICENSE.txt`;
  bundled axe-core notices are in `LICENSE-axe-core.txt` and
  `LICENSE-axe-core-THIRD-PARTY.txt`. These notices match the v0.37.0 source
  tag, which has no root-level NOTICE.
- **Chromium Headless Shell 153.0.8010.47**, the optional bundled browser
  prepared by `scripts/prepare-browser.mjs` for Linux x64 and arm64.
  `server/browser-bundle-release.ts` pins the archives and executable digests.
  Source: <https://googlechromelabs.github.io/chrome-for-testing/153.0.8010.47.json>.
  The extracted tree retains `ABOUT` and `LICENSE.headless_shell`, including
  Chromium's BSD notice and target-specific third-party licenses.

The optional bundle is the headless automation build, not the full Google
Chrome distribution, and does not include Widevine. The Chrome-for-Testing
dashboard repository's Apache-2.0 license does not license Chrome binaries.
Upstream's ABOUT notice and Chrome terms reference are retained:
<https://www.google.com/chrome/terms/>.

The default runtime can also use an installed or downloaded full Chrome.
The Docker image installs agent-browser and its browser separately; its
version is pinned in `Dockerfile`. The experimental QuatiBot Chrome driver
does not replace the third-party browser's own license obligations.

Archives and extracted binaries are build output, not git content.
`scripts/prepare-browser.mjs` verifies cached and downloaded archive bytes,
copies these notices into the bundle, and records its file/symlink inventory.
Use `QUATI_BROWSER_ARCHIVE_DIR` for reviewed offline archives. Browser
updates require changing the pins and verifying the resulting bundle.

Google, Chromium and Vercel are their owners' names; inclusion does not imply
endorsement of QuatiBot. This record does not replace the upstream licenses.
