import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditLinuxPackage } from '../src/linux-package-audit.mjs'

const desktop = `[Desktop Entry]
Name=GenOffice
Exec=AppRun --no-sandbox %U
Terminal=false
Type=Application
Icon=genoffice
StartupWMClass=genoffice
X-AppImage-Version=0.5.0
Categories=Office;
MimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document;application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;application/vnd.openxmlformats-officedocument.presentationml.presentation;application/vnd.ms-excel;text/csv;application/pdf;
`

function runtimeManifest() {
  return {
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
    executable: 'node/open-genoffice-pi-agent-runtime',
    entry: 'app/main.mjs',
    files: [
      { path: 'node/open-genoffice-pi-agent-runtime', mode: '0755' },
      { path: 'app/main.mjs', mode: '0755' },
    ],
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'linux-package-audit-'))
  const packageRoot = join(root, 'squashfs-root')
  const appImagePath = join(root, 'GenOffice-0.5.0-linux-x64-unsigned.AppImage')
  await mkdir(packageRoot)
  await writeFile(join(packageRoot, 'genoffice.desktop'), desktop)
  await writeFile(join(packageRoot, 'AppRun'), '#!/bin/sh\n')
  await writeFile(appImagePath, 'appimage fixture')
  await chmod(join(packageRoot, 'AppRun'), 0o755)
  await chmod(appImagePath, 0o755)
  return { packageRoot, appImagePath }
}

describe('Linux AppImage package audit', () => {
  it('proves the glibc x64 layout while keeping unsigned builds off update feeds', async () => {
    const paths = await fixture()
    await writeFile(
      join(paths.packageRoot, 'genoffice.desktop'),
      `# generated\n[Ignored]\nName=Ignored\n${desktop}`,
    )
    const result = await auditLinuxPackage({ ...paths, runtimeManifest: runtimeManifest() })

    expect(result).toMatchObject({
      schemaVersion: 1,
      status: 'passed',
      platform: 'linux',
      arch: 'x64',
      libc: 'glibc',
      executableModes: { appImage: '0755', appRun: '0755', runtime: '0755', entry: '0755' },
      desktop: {
        exec: 'AppRun --no-sandbox %U',
        startupWmClass: 'genoffice',
        version: '0.5.0',
        associations: 6,
      },
      feed: {
        embedded: false,
        automaticUpdateClaimed: false,
        stable: 'latest-linux.yml',
        beta: 'beta-linux.yml',
        archive: 'GenOffice-linux-x64-0.5.0.yml',
        versionedArtifact: 'GenOffice-0.5.0-linux-x64.AppImage',
      },
    })
    expect(result.artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['desktop entry', async (paths) => writeFile(join(paths.packageRoot, 'genoffice.desktop'), '')],
    ['AppRun mode', async (paths) => chmod(join(paths.packageRoot, 'AppRun'), 0o644)],
    ['artifact mode', async (paths) => chmod(paths.appImagePath, 0o700)],
  ])('rejects an invalid %s', async (_name, mutate) => {
    const paths = await fixture()
    await mutate(paths)
    await expect(
      auditLinuxPackage({ ...paths, runtimeManifest: runtimeManifest() }),
    ).rejects.toThrow(/linux_package_/)
  })

  it.each([
    ['target', (manifest) => (manifest.arch = 'arm64')],
    [
      'runtime mode',
      (manifest) =>
        (manifest.files.find((file) => file.path === manifest.executable).mode = '0644'),
    ],
    ['missing entry', (manifest) => (manifest.files = manifest.files.slice(0, 1))],
  ])('rejects an invalid Runtime %s', async (_name, mutate) => {
    const paths = await fixture()
    const manifest = runtimeManifest()
    mutate(manifest)
    await expect(auditLinuxPackage({ ...paths, runtimeManifest: manifest })).rejects.toThrow(
      /linux_package_runtime_/,
    )
  })

  it.each([
    ['platform', (manifest) => (manifest.platform = 'darwin')],
    ['libc', (manifest) => (manifest.libc = 'musl')],
    ['executable path', (manifest) => (manifest.executable = 42)],
    ['entry path', (manifest) => (manifest.entry = null)],
    ['file list', (manifest) => (manifest.files = null)],
  ])('rejects an invalid Runtime target %s field', async (_name, mutate) => {
    const paths = await fixture()
    const manifest = runtimeManifest()
    mutate(manifest)
    await expect(auditLinuxPackage({ ...paths, runtimeManifest: manifest })).rejects.toThrow(
      'linux_package_runtime_target_invalid',
    )
  })

  it.each([
    ['malformed line', `${desktop}\nmalformed`],
    ['duplicate key', `${desktop}\nName=Duplicate`],
    ['missing association', desktop.replace('application/pdf;', '')],
    ['wrong association', desktop.replace('application/pdf;', 'application/octet-stream;')],
  ])('rejects a desktop entry with a %s', async (_name, contents) => {
    const paths = await fixture()
    await writeFile(join(paths.packageRoot, 'genoffice.desktop'), contents)
    await expect(
      auditLinuxPackage({ ...paths, runtimeManifest: runtimeManifest() }),
    ).rejects.toThrow(/linux_package_desktop_/)
  })

  it('rejects a non-versioned or non-unsigned AppImage name', async () => {
    const paths = await fixture()
    await expect(
      auditLinuxPackage({
        ...paths,
        appImagePath: join(paths.packageRoot, 'GenOffice.AppImage'),
        runtimeManifest: runtimeManifest(),
      }),
    ).rejects.toThrow('linux_package_artifact_name_invalid')
  })
})
