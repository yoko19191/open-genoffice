#!/usr/bin/env node
/**
 * scripts/update-feed-utils.cjs — shared helpers for the electron-updater
 * feed files (latest*.yml / beta*.yml): version parsing and the
 * forward-only promote/upload guard. Used by mac-release-upload.cjs and
 * promote-stable.cjs; kept dependency-free so vitest can require it directly.
 */

function ymlVersion(text) {
  const m = /^version:\s*(\S+)/m.exec(text)
  return m ? m[1] : null
}

function semverNewer(a, b) {
  // returns true when a > b (plain x.y.z comparison)
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

function assertPromotable(candidate, currentStable, force) {
  if (force || !currentStable || semverNewer(candidate, currentStable)) return { ok: true }
  return {
    ok: false,
    reason: `${candidate} is not newer than the published stable ${currentStable}; pass --force to roll back`,
  }
}

const RELEASE_PLATFORMS = Object.freeze(
  [
    {
      flag: '--mac',
      archive: (version) => `GenOffice-mac-arm64-${version}.yml`,
      feed: 'latest-mac.yml',
      betaFeed: 'beta-mac.yml',
      installer: (version) => `GenOffice-${version}-arm64.dmg`,
      alias: 'GenOffice.dmg',
    },
    {
      flag: '--win',
      archive: (version) => `GenOffice-win-${version}.yml`,
      feed: 'latest.yml',
      betaFeed: 'beta.yml',
      installer: (version) => `GenOfficeSetup-v${version}.exe`,
      alias: 'GenOfficeSetup.exe',
    },
    {
      flag: '--linux',
      archive: (version) => `GenOffice-linux-x64-${version}.yml`,
      feed: 'latest-linux.yml',
      betaFeed: 'beta-linux.yml',
      installer: (version) => `GenOffice-${version}-linux-x64.AppImage`,
      alias: 'GenOffice.AppImage',
    },
  ].map(Object.freeze),
)

module.exports = { ymlVersion, semverNewer, assertPromotable, RELEASE_PLATFORMS }
