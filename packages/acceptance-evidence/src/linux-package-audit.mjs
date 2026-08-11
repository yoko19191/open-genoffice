import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const EXPECTED_ASSOCIATIONS = Object.freeze([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'text/csv',
  'application/pdf',
])

function fail(code) {
  throw new Error(code)
}

function mode(metadata) {
  return `0${(metadata.mode & 0o777).toString(8)}`
}

function parseDesktopEntry(text) {
  const values = new Map()
  let section
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1)
      continue
    }
    if (section !== 'Desktop Entry') continue
    const separator = line.indexOf('=')
    if (separator <= 0) fail('linux_package_desktop_invalid')
    const key = line.slice(0, separator)
    if (values.has(key)) fail('linux_package_desktop_invalid')
    values.set(key, line.slice(separator + 1))
  }
  return values
}

function validateRuntimeManifest(manifest) {
  if (
    manifest?.platform !== 'linux' ||
    manifest.arch !== 'x64' ||
    manifest.libc !== 'glibc' ||
    typeof manifest.executable !== 'string' ||
    typeof manifest.entry !== 'string' ||
    !Array.isArray(manifest.files)
  ) {
    fail('linux_package_runtime_target_invalid')
  }
  const byPath = new Map(manifest.files.map((file) => [file?.path, file]))
  const runtime = byPath.get(manifest.executable)
  const entry = byPath.get(manifest.entry)
  if (!runtime || !entry) fail('linux_package_runtime_file_missing')
  if (runtime.mode !== '0755' || entry.mode !== '0755') {
    fail('linux_package_runtime_mode_invalid')
  }
  return { runtime: runtime.mode, entry: entry.mode }
}

export async function auditLinuxPackage({ packageRoot, appImagePath, runtimeManifest }) {
  const artifactName = basename(appImagePath)
  const match = /^GenOffice-(\d+\.\d+\.\d+)-linux-x64-unsigned\.AppImage$/.exec(artifactName)
  if (!match) fail('linux_package_artifact_name_invalid')
  const version = match[1]
  const [desktopText, appRunMetadata, artifactMetadata, artifactBytes] = await Promise.all([
    readFile(join(packageRoot, 'genoffice.desktop'), 'utf8'),
    lstat(join(packageRoot, 'AppRun')),
    lstat(appImagePath),
    readFile(appImagePath),
  ])
  if (mode(appRunMetadata) !== '0755') fail('linux_package_apprun_mode_invalid')
  if (mode(artifactMetadata) !== '0755') fail('linux_package_artifact_mode_invalid')

  const desktop = parseDesktopEntry(desktopText)
  const expected = {
    Name: 'GenOffice',
    Exec: 'AppRun --no-sandbox %U',
    Terminal: 'false',
    Type: 'Application',
    Icon: 'genoffice',
    StartupWMClass: 'genoffice',
    'X-AppImage-Version': version,
    Categories: 'Office;',
  }
  if (Object.entries(expected).some(([key, value]) => desktop.get(key) !== value)) {
    fail('linux_package_desktop_invalid')
  }
  const associations = (desktop.get('MimeType') ?? '').split(';').filter(Boolean)
  if (
    associations.length !== EXPECTED_ASSOCIATIONS.length ||
    EXPECTED_ASSOCIATIONS.some((association) => !associations.includes(association))
  ) {
    fail('linux_package_desktop_associations_invalid')
  }
  const runtimeModes = validateRuntimeManifest(runtimeManifest)

  return Object.freeze({
    schemaVersion: 1,
    status: 'passed',
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
    executableModes: {
      appImage: mode(artifactMetadata),
      appRun: mode(appRunMetadata),
      ...runtimeModes,
    },
    desktop: {
      exec: desktop.get('Exec'),
      startupWmClass: desktop.get('StartupWMClass'),
      version: desktop.get('X-AppImage-Version'),
      associations: associations.length,
    },
    artifact: {
      name: artifactName,
      size: artifactMetadata.size,
      sha256: createHash('sha256').update(artifactBytes).digest('hex'),
    },
    feed: {
      embedded: false,
      automaticUpdateClaimed: false,
      stable: 'latest-linux.yml',
      beta: 'beta-linux.yml',
      archive: `GenOffice-linux-x64-${version}.yml`,
      versionedArtifact: `GenOffice-${version}-linux-x64.AppImage`,
    },
  })
}
