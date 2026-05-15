import * as path from 'node:path';
import * as os from 'node:os';
import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import {
  install,
  resolveBuildId,
  detectBrowserPlatform,
  Browser,
} from '@puppeteer/browsers';

type Driver = 'browser' | 'terminal';

function parseDriver(raw: string): Driver {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'browser') return 'browser';
  if (value === 'terminal') return 'terminal';
  throw new Error(`Invalid driver "${raw}". Expected "browser" or "terminal".`);
}

function parseBool(raw: string, name: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'false' || value === '0' || value === 'no') return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  throw new Error(`Invalid boolean for "${name}": "${raw}". Expected true/false.`);
}

function pushFlag(args: string[], flag: string, value: string) {
  const trimmed = value.trim();
  if (trimmed === '') return;
  args.push(flag, trimmed);
}

function pushBoolFlag(args: string[], flag: string, raw: string, name: string) {
  if (parseBool(raw, name)) args.push(flag);
}

function pushHeaders(args: string[], raw: string) {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) {
      throw new Error(`Invalid header "${trimmed}". Expected "Key: Value".`);
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key === '') {
      throw new Error(`Invalid header "${trimmed}". Empty key.`);
    }
    args.push('--header', `${key}=${value}`);
  }
}

async function ensureChrome(version: string, useCache: boolean): Promise<string> {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error(`Unsupported platform for Chrome installation: ${process.platform}/${process.arch}.`);
  }
  const cacheDir = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'bombadil-chrome');
  const buildId = await resolveBuildId(Browser.CHROME, platform, version);
  const cacheKey = `bombadil-chrome-${platform}-${buildId}`;

  const cacheEnabled = useCache && cache.isFeatureAvailable();
  let restored = false;
  if (cacheEnabled) {
    try {
      const hit = await cache.restoreCache([cacheDir], cacheKey);
      if (hit) {
        restored = true;
        core.info(`Restored Chrome from cache (${cacheKey}).`);
      }
    } catch (err) {
      core.warning(`Cache restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  core.info(`Resolving Chrome for Testing (${platform}, build ${buildId}) in ${cacheDir}`);
  const installed = await install({ browser: Browser.CHROME, buildId, cacheDir });

  if (cacheEnabled && !restored) {
    try {
      await cache.saveCache([cacheDir], cacheKey);
      core.info(`Saved Chrome to cache (${cacheKey}).`);
    } catch (err) {
      core.warning(`Cache save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return installed.executablePath;
}

function splitCommand(raw: string): string[] {
  // The CLI accepts the command as space-separated tokens trailing the
  // subcommand. We honor a single level of double-quoting for tokens that
  // contain spaces, since that's the most common need.
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

async function run(): Promise<void> {
  const driver = parseDriver(core.getInput('driver'));
  const origin = core.getInput('origin');
  const spec = core.getInput('spec');
  const version = core.getInput('version') || 'latest';

  const flags: string[] = [];

  if (driver === 'browser') {
    pushFlag(flags, '--output-path', core.getInput('output-path'));
    pushFlag(flags, '--time-limit', core.getInput('time-limit'));
    pushFlag(flags, '--reproduce', core.getInput('reproduce'));
    pushBoolFlag(flags, '--exit-on-violation', core.getInput('exit-on-violation'), 'exit-on-violation');
    pushFlag(flags, '--width', core.getInput('width'));
    pushFlag(flags, '--height', core.getInput('height'));
    pushFlag(flags, '--device-scale-factor', core.getInput('device-scale-factor'));
    pushFlag(flags, '--instrument-javascript', core.getInput('instrument-javascript'));
    pushFlag(flags, '--chrome-grant-permissions', core.getInput('chrome-grant-permissions'));
    pushHeaders(flags, core.getInput('headers'));
    pushBoolFlag(flags, '--headless', core.getInput('headless'), 'headless');
    pushBoolFlag(flags, '--no-sandbox', core.getInput('no-sandbox'), 'no-sandbox');
  } else {
    pushFlag(flags, '--test-count', core.getInput('test-count'));
    pushFlag(flags, '--seed', core.getInput('seed'));
    pushBoolFlag(flags, '--render-append', core.getInput('render-append'), 'render-append');
  }

  // Subcommand routing. Bombadil currently exposes `bombadil test` for the
  // browser driver and `bombadil terminal test` for the terminal driver.
  // Once the CLI unifies under `bombadil <driver> test`, this is the only
  // place that needs to change.
  const subcommand = driver === 'browser' ? ['test'] : ['terminal', 'test'];

  const positionals: string[] = [];
  if (driver === 'browser') {
    if (origin.trim() === '') {
      throw new Error('The `origin` input is required when driver is "browser".');
    }
    positionals.push(origin.trim());
    if (spec.trim() !== '') positionals.push(spec.trim());
  } else {
    const command = core.getInput('command');
    if (command.trim() === '') {
      throw new Error('The `command` input is required when driver is "terminal".');
    }
    positionals.push(...splitCommand(command));
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (driver === 'browser' && !env.CHROME) {
    const chromeVersion = core.getInput('chrome-version') || 'stable';
    const useCache = parseBool(core.getInput('cache'), 'cache');
    env.CHROME = await ensureChrome(chromeVersion, useCache);
    core.info(`CHROME=${env.CHROME}`);
  }

  const pkg = `@antithesishq/bombadil@${version}`;
  const args = ['--yes', pkg, ...subcommand, ...flags, ...positionals];

  core.info(`Running: npx ${args.join(' ')}`);
  const exitCode = await exec.exec('npx', args, { ignoreReturnCode: true, env });
  core.setOutput('exit-code', String(exitCode));

  if (exitCode === 0) return;
  if (exitCode === 2) {
    core.setFailed('Bombadil detected one or more property violations.');
    return;
  }
  core.setFailed(`Bombadil exited with code ${exitCode}.`);
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
