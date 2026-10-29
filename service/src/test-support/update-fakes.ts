import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, RunCommandParams } from '../commands/run-command.js';
import { createSilentLogger } from '../logging/logger.js';
import { createSettingsStore } from '../settings/settings.js';
import type { SpawnInstallerParams } from '../updates/installer-process.js';
import { assetNameFor, BUNDLE_IDENTIFIER, BUNDLE_NAME } from '../updates/update-rules.js';
import type { InstallLocation } from '../updates/update-rules.js';
import { createUpdater } from '../updates/updater.js';
import type { UpdaterDependencies } from '../updates/update-types.js';

const ZIP_BYTES = 'fake app zip';
const GH_PATH = '/opt/homebrew/bin/gh';

export const ZIP_SHA256 = createHash('sha256').update(ZIP_BYTES).digest('hex');

interface FakeRelease {
	tag: string;
	digest: string | null;
	isApiFailing: boolean;
	isDownloadFailing: boolean;
	isUnpackFailing: boolean;
	bundleIdentifier: string;
	bundleVersion: string | null;
	hasInstaller: boolean;
	isSealBroken: boolean;
}

export interface UpdaterHarness {
	release: FakeRelease;
	calls: RunCommandParams[];
	spawns: SpawnInstallerParams[];
	flags: Map<string, string>;
	jobs: { isIdle: boolean; heldChanges: boolean[] };
	/** Runs before each fake command answers, so a test can change the world mid-install */
	onCommand: { current: (params: RunCommandParams) => void };
	clock: { now: number };
	dataDirectory: string;
	dependencies: UpdaterDependencies;
	create(): ReturnType<typeof createUpdater>;
}

const ok = (stdout = ''): CommandResult => {
	return { exitCode: 0, stdout, stderr: '', isTimedOut: false, durationMs: 1 };
};

const failed = (stderr: string): CommandResult => {
	return { exitCode: 1, stdout: '', stderr, isTimedOut: false, durationMs: 1 };
};

const INSTALLED: InstallLocation = { canInstall: true, installDirectory: '/Users/me/Applications' };

interface CreateUpdaterHarnessParams {
	currentVersion?: string;
	installLocation?: InstallLocation;
}

export const createUpdaterHarness = ({
	currentVersion = '0.6.0',
	installLocation = INSTALLED,
}: CreateUpdaterHarnessParams = {}): UpdaterHarness => {
	const dataDirectory = mkdtempSync(join(tmpdir(), 'proxy-review-bot-updates-'));
	const release: FakeRelease = {
		tag: 'v0.6.1',
		digest: `sha256:${ZIP_SHA256}`,
		isApiFailing: false,
		isDownloadFailing: false,
		isUnpackFailing: false,
		bundleIdentifier: BUNDLE_IDENTIFIER,
		bundleVersion: null,
		hasInstaller: true,
		isSealBroken: false,
	};
	const calls: RunCommandParams[] = [];
	const spawns: SpawnInstallerParams[] = [];
	const flags = new Map<string, string>();
	const jobs = { isIdle: true, heldChanges: [] as boolean[] };
	const clock = { now: 1_000_000 };
	const onCommand = { current: (_params: RunCommandParams): void => undefined };
	const versionOfTag = (): string => release.tag.replace(/^v/, '');

	const respond = (params: RunCommandParams): CommandResult => {
		const [subcommand] = params.args;

		if (params.command === GH_PATH && subcommand === 'api') {
			return release.isApiFailing
				? failed('gh: Bad credentials (HTTP 401)')
				: ok(
						JSON.stringify({
							tag_name: release.tag,
							assets: [{ name: assetNameFor(versionOfTag()), digest: release.digest }],
						}),
					);
		}

		if (params.command === GH_PATH && subcommand === 'release') {
			const directory = params.args[params.args.indexOf('--dir') + 1] ?? '';

			if (release.isDownloadFailing) {
				return failed('HTTP 404: Not Found');
			}

			writeFileSync(join(directory, assetNameFor(versionOfTag())), ZIP_BYTES);

			return ok();
		}

		if (params.command === '/usr/bin/ditto') {
			const contents = join(params.args[3] ?? '', BUNDLE_NAME, 'Contents');

			if (release.isUnpackFailing) {
				return failed('ditto: bad zip');
			}

			mkdirSync(join(contents, 'Resources'), { recursive: true });

			if (release.hasInstaller) {
				writeFileSync(join(contents, 'Resources', 'install.sh'), '#!/bin/sh\n');
			}

			return ok();
		}

		if (params.command === '/usr/bin/plutil') {
			return params.args[1] === 'CFBundleIdentifier'
				? ok(`${release.bundleIdentifier}\n`)
				: ok(`${release.bundleVersion ?? versionOfTag()}\n`);
		}

		if (params.command === '/usr/bin/codesign') {
			return release.isSealBroken ? failed('a sealed resource is missing or invalid') : ok();
		}

		return failed(`unexpected command ${params.command}`);
	};

	const dependencies: UpdaterDependencies = {
		runCommand: async (params) => {
			calls.push(params);
			onCommand.current(params);

			return respond(params);
		},
		spawnInstaller: (params) => {
			spawns.push(params);
		},
		flags: {
			getFlag: (name) => flags.get(name) ?? null,
			setFlag: (name, value) => {
				if (value === null) {
					flags.delete(name);
				} else {
					flags.set(name, value);
				}
			},
		},
		settingsStore: createSettingsStore(join(dataDirectory, 'settings.json')),
		jobs: {
			isIdle: () => jobs.isIdle,
			setHeld: (isHeld) => {
				jobs.heldChanges.push(isHeld);
			},
		},
		logger: createSilentLogger(),
		now: () => clock.now,
		currentVersion,
		installLocation,
		ghPath: GH_PATH,
		gitPath: '/usr/bin/git',
		updatesDirectory: join(dataDirectory, 'updates'),
		updateLogPath: join(dataDirectory, 'logs', 'update.log'),
		baseEnv: { HOME: '/Users/me', PATH: '/opt/homebrew/bin', GITHUB_TOKEN: 'secret' },
	};

	return {
		release,
		calls,
		spawns,
		flags,
		jobs,
		onCommand,
		clock,
		dataDirectory,
		dependencies,
		create: () => createUpdater(dependencies),
	};
};
