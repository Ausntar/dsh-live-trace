#!/usr/bin/env node
/**
 * Wire `dsh-live-trace` into a DSH profile's composition.
 *
 * This is a file-level installer: it edits the profile's `package.json`
 * (dependency + bundle selection) and links the package into the profile's
 * `node_modules`. It deliberately does not run a package manager, so it works
 * offline and never touches the packages pnpm already manages. Use
 * `dsh plugin --profile <name> add <dir>` instead when you would rather have
 * pnpm own the dependency.
 *
 *   node scripts/install-profile.mjs [--profile web] [--home <dsh-home>]
 *                                    [--package <dir>] [--uninstall] [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-live-trace'
const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')

function parseArgs(argv) {
  const options = { profile: 'web', home: undefined, packageDir: PACKAGE_DIR, uninstall: false, dryRun: false, link: true }
  for (let index = 0; index < argv.length; index += 1) {
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${argv[index]}`)
      index += 1
      return next
    }
    switch (argv[index]) {
      case '--profile':
        options.profile = value()
        break
      case '--home':
        options.home = resolve(value())
        break
      case '--package':
        options.packageDir = resolve(value())
        break
      case '--uninstall':
        options.uninstall = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--no-link':
        options.link = false
        break
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`unknown option: ${argv[index]}`)
    }
  }
  return options
}

function resolveHome(explicit) {
  if (explicit !== undefined) return explicit
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

const HELP = `dsh-live-trace profile installer

  --profile <name>   DSH profile to wire up (default: web)
  --home <dir>       DSH home (default: $DSH_HOME or ~/.dsh)
  --package <dir>    package directory to link (default: this package)
  --no-link          edit package.json only; do not create a node_modules link
  --uninstall        remove the dependency, bundle entry, and link
  --dry-run          print what would change and exit
  --help             show this message
`

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    process.stdout.write(HELP)
    return 0
  }

  const home = resolveHome(options.home)
  const profileDir = join(home, 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')
  const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)

  if (!existsSync(manifestPath)) {
    process.stderr.write(
      `dsh-live-trace: no profile manifest at ${manifestPath}\n` +
        `Create the profile first (booting it once with "dsh --profile ${options.profile}" does this),\n` +
        'or pass --home to point at the right DSH home.\n'
    )
    return 1
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dependencySpec = `link:${options.packageDir}`

  if (options.uninstall === true) {
    if (manifest.dependencies?.[PACKAGE_NAME] !== undefined) delete manifest.dependencies[PACKAGE_NAME]
    removeFromBundles(manifest, PACKAGE_NAME)
    if (options.dryRun !== true) {
      writeManifest(manifestPath, manifest)
      rmSync(linkPath, { force: true })
    }
    process.stdout.write(`dsh-live-trace: ${options.dryRun ? 'would remove from' : 'removed from'} ${manifestPath}\n`)
    return 0
  }

  manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE_NAME]: dependencySpec }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    process.stderr.write(
      `dsh-live-trace: ${manifestPath} has no dsh.profile.bundles list, so the plugin cannot be selected.\n` +
        'Add one (see any shipped profile template) and re-run.\n'
    )
    return 1
  }
  const added = !bundles.includes(PACKAGE_NAME)
  if (added) bundles.push(PACKAGE_NAME)

  if (options.dryRun === true) {
    process.stdout.write(`would write ${manifestPath}:\n${JSON.stringify(manifest, null, 2)}\n`)
    if (options.link) process.stdout.write(`would link ${linkPath} -> ${options.packageDir}\n`)
    return 0
  }

  writeManifest(manifestPath, manifest)

  if (options.link === true) {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(options.packageDir, linkPath, 'dir')
  }

  process.stdout.write(
    [
      `dsh-live-trace: installed into profile "${options.profile}"`,
      `  manifest: ${manifestPath}`,
      `  dependency: ${PACKAGE_NAME} -> ${dependencySpec}`,
      options.link ? `  link: ${linkPath} -> ${options.packageDir}` : '  link: skipped (--no-link)',
      '',
      'Next:',
      `  1. restart the Harness (or let it hot-reload): dsh --profile ${options.profile}`,
      '  2. in another terminal, run: dsh-live-trace',
      ''
    ].join('\n')
  )
  return 0
}

function removeFromBundles(manifest, name) {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return
  const index = bundles.indexOf(name)
  if (index !== -1) bundles.splice(index, 1)
}

function writeManifest(path, manifest) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`dsh-live-trace: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
