import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import { createUpdaterHarness } from '../test-support/update-fakes.js';

const SIX_HOURS_MS = 6 * 60 * 60_000;

const commandsOf = (harness: ReturnType<typeof createUpdaterHarness>): string[] => {
	return harness.calls.map((call) => `${call.command.split('/').pop()} ${call.args[0]}`);
};

type FakeRelease = ReturnType<typeof createUpdaterHarness>['release'];

const checkedAndAvailable = async (release: Partial<FakeRelease> = {}) => {
	const harness = createUpdaterHarness();
	const updater = harness.create();

	Object.assign(harness.release, release);
	harness.dependencies.settingsStore.replace({ ...DEFAULT_SETTINGS, autoUpdate: false });
	await updater.check();

	return { harness, updater };
};

describe('updater: checking', () => {
	it('a newer release → available', async () => {
		const { updater } = await checkedAndAvailable();

		expect(updater.getState()).toMatchObject({
			currentVersion: '0.6.0',
			latestVersion: '0.6.1',
			isUpdateAvailable: true,
			canInstall: true,
			phase: 'idle',
			error: null,
			lastCheckedAt: 1_000_000,
		});
	});

	it('the same release → up to date', async () => {
		const harness = createUpdaterHarness();
		const updater = harness.create();

		harness.release.tag = 'v0.6.0';
		await updater.check();

		expect(updater.getState()).toMatchObject({ latestVersion: '0.6.0', isUpdateAvailable: false });
	});

	it('gh fails → failed with its message, nothing installed', async () => {
		const harness = createUpdaterHarness();
		const updater = harness.create();

		harness.release.isApiFailing = true;
		await updater.check();

		expect(updater.getState()).toMatchObject({
			phase: 'failed',
			error: "Couldn't check for updates: gh: Bad credentials (HTTP 401)",
			isUpdateAvailable: false,
		});
		expect(harness.spawns).toEqual([]);
	});

	it('a release without a checksum → failed, never installed', async () => {
		const harness = createUpdaterHarness();
		const updater = harness.create();

		harness.release.digest = null;
		await updater.tick();
		await updater.waitForIdle();

		expect(updater.getState().error).toBe(
			'Release v0.6.1 has no checksum for ProxyReviewBot_0.6.1_macos_arm64.zip',
		);
		expect(harness.spawns).toEqual([]);
	});

	it('checks at start, then not again until six hours later', async () => {
		const harness = createUpdaterHarness();
		const updater = harness.create();

		harness.release.tag = 'v0.6.0';
		await updater.tick();
		harness.clock.now += SIX_HOURS_MS - 1;
		await updater.tick();

		expect(commandsOf(harness)).toEqual(['gh api']);

		harness.clock.now += 1;
		await updater.tick();

		expect(commandsOf(harness)).toEqual(['gh api', 'gh api']);
	});
});

describe('updater: installing', () => {
	it('verified download → hands off to its own install.sh, detached, with an allowlisted env', async () => {
		const { harness, updater } = await checkedAndAvailable();

		expect(updater.install('manual')).toBe('ok');
		await updater.waitForIdle();

		const directory = join(harness.dataDirectory, 'updates', '0.6.1');

		expect(commandsOf(harness)).toEqual([
			'gh api',
			'gh release',
			'ditto -x',
			'plutil -extract',
			'plutil -extract',
			'codesign --verify',
		]);
		expect(harness.spawns).toEqual([
			{
				scriptPath: join(directory, 'unpacked/ProxyReviewBot.app/Contents/Resources/install.sh'),
				env: {
					HOME: '/Users/me',
					PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
					PRB_LOCAL_ZIP: join(directory, 'ProxyReviewBot_0.6.1_macos_arm64.zip'),
					INSTALL_DIR: '/Users/me/Applications',
					PRB_KEEP_LOGIN_ITEM: '1',
				},
				logPath: join(harness.dataDirectory, 'logs', 'update.log'),
				cwd: '/Users/me',
				onError: expect.any(Function),
			},
		]);
		expect(updater.getState().phase).toBe('installing');
		expect(JSON.parse(harness.flags.get('pending_update') ?? '{}')).toEqual({
			version: '0.6.1',
			at: 1_000_000,
		});
		expect(harness.jobs.heldChanges).toEqual([true]);
	});

	it('the download asks gh for that tag’s app zip only', async () => {
		const { harness, updater } = await checkedAndAvailable();

		updater.install('manual');
		await updater.waitForIdle();

		expect(harness.calls[1]?.args).toEqual([
			'release',
			'download',
			'v0.6.1',
			'--repo',
			'FurlanLuka/proxy-review-bot',
			'--pattern',
			'ProxyReviewBot_0.6.1_macos_arm64.zip',
			'--dir',
			join(harness.dataDirectory, 'updates', '0.6.1'),
			'--clobber',
		]);
	});

	it.each([
		[
			'the download fails',
			{ isDownloadFailing: true },
			"Couldn't download v0.6.1: HTTP 404: Not Found",
		],
		[
			'the checksum differs',
			{ digest: `sha256:${'b'.repeat(64)}` },
			"The download didn't match its checksum",
		],
		['it won’t unpack', { isUnpackFailing: true }, "Couldn't unpack the download"],
		[
			'another app',
			{ bundleIdentifier: 'com.example.other' },
			"The download isn't Proxy Review Bot v0.6.1",
		],
		[
			'another version inside',
			{ bundleVersion: '0.6.0' },
			"The download isn't Proxy Review Bot v0.6.1",
		],
		['no installer inside', { hasInstaller: false }, 'The download has no installer'],
		['a broken seal', { isSealBroken: true }, "The download's code seal is broken"],
	])('%s → failed before the hand-off, jobs resume', async (_case, release, error) => {
		const { harness, updater } = await checkedAndAvailable(release);

		updater.install('manual');
		await updater.waitForIdle();

		expect(updater.getState()).toMatchObject({ phase: 'failed', error });
		expect(harness.spawns).toEqual([]);
		expect(harness.flags.has('pending_update')).toBe(false);
		expect(harness.jobs.heldChanges).toEqual([true, false]);
	});

	it('the installer can’t start → failed, pending cleared, jobs resume', async () => {
		const { harness, updater } = await checkedAndAvailable();

		harness.dependencies.spawnInstaller = () => {
			throw new Error('EAGAIN');
		};

		updater.install('manual');
		await updater.waitForIdle();

		expect(updater.getState()).toMatchObject({
			phase: 'failed',
			error: "Couldn't start the installer: EAGAIN",
		});
		expect(harness.flags.has('pending_update')).toBe(false);
		expect(harness.jobs.heldChanges).toEqual([true, false]);
	});

	it('a review is running → waits with new jobs held, installs once idle', async () => {
		const { harness, updater } = await checkedAndAvailable();

		harness.jobs.isIdle = false;
		updater.install('manual');
		await updater.tick();
		await updater.waitForIdle();

		expect(updater.getState().phase).toBe('waiting_for_reviews');
		expect(harness.jobs.heldChanges).toEqual([true]);
		expect(commandsOf(harness)).toEqual(['gh api']);

		harness.jobs.isIdle = true;
		await updater.tick();
		await updater.waitForIdle();

		expect(updater.getState().phase).toBe('installing');
		expect(harness.spawns).toHaveLength(1);
	});

	it('Update now: no update, a dev run or already updating → refused', async () => {
		const upToDate = createUpdaterHarness();

		expect(upToDate.create().install('manual')).toBe('no_update');

		const devRun = createUpdaterHarness({
			installLocation: { canInstall: false, reason: 'Updates work only in the installed app' },
		});
		const devUpdater = devRun.create();

		await devUpdater.check();

		expect(devUpdater.install('manual')).toBe('cannot_install');
		expect(devUpdater.getState()).toMatchObject({
			canInstall: false,
			cannotInstallReason: 'Updates work only in the installed app',
			isUpdateAvailable: true,
		});

		const { harness, updater } = await checkedAndAvailable();

		harness.jobs.isIdle = false;
		updater.install('manual');

		expect(updater.install('manual')).toBe('busy');
	});

	it('the installer never finishes → failed after two minutes, jobs resume', async () => {
		const { harness, updater } = await checkedAndAvailable();

		updater.install('manual');
		await updater.waitForIdle();
		harness.clock.now += 2 * 60_000;
		await updater.tick();

		expect(updater.getState()).toMatchObject({
			phase: 'failed',
			error: "The installer didn't finish. See update.log",
		});
		expect(harness.flags.has('pending_update')).toBe(false);
		expect(harness.jobs.heldChanges).toEqual([true, false]);
	});
});

describe('updater: failures mid-way', () => {
	it('a check whose command throws → failed, not stuck checking', async () => {
		const harness = createUpdaterHarness();

		harness.onCommand.current = () => {
			throw new Error('spawn gh ENOENT');
		};

		const updater = harness.create();

		await updater.check();

		expect(updater.getState()).toMatchObject({
			phase: 'failed',
			error: "Couldn't check for updates: spawn gh ENOENT",
		});
		expect(harness.jobs.heldChanges).toEqual([]);
	});

	it('a command throws during the install → failed, jobs released, nothing handed off', async () => {
		const { harness, updater } = await checkedAndAvailable();

		harness.onCommand.current = (params) => {
			if (params.command === '/usr/bin/ditto') {
				throw new Error('spawn ditto EACCES');
			}
		};

		updater.install('manual');
		await updater.waitForIdle();

		expect(updater.getState()).toMatchObject({
			phase: 'failed',
			error: 'The update failed: spawn ditto EACCES',
		});
		expect(harness.jobs.heldChanges).toEqual([true, false]);
		expect(harness.spawns).toEqual([]);
		expect(harness.flags.has('pending_update')).toBe(false);
	});

	it('the installer fails after the hand-off → failed, pending cleared, jobs resume', async () => {
		const { harness, updater } = await checkedAndAvailable();

		updater.install('manual');
		await updater.waitForIdle();
		harness.spawns[0]?.onError(new Error('posix_spawn failed'));

		expect(updater.getState()).toMatchObject({
			phase: 'failed',
			error: "Couldn't start the installer: posix_spawn failed",
		});
		expect(harness.flags.has('pending_update')).toBe(false);
		expect(harness.jobs.heldChanges).toEqual([true, false]);
	});

	it('an approval starts during the download → the hand-off waits for it, without downloading again', async () => {
		const { harness, updater } = await checkedAndAvailable();

		harness.onCommand.current = (params) => {
			if (params.args[0] === 'release') {
				harness.jobs.isIdle = false;
			}
		};

		updater.install('manual');
		await updater.waitForIdle();

		expect(updater.getState().phase).toBe('waiting_for_reviews');
		expect(harness.spawns).toEqual([]);

		harness.jobs.isIdle = true;
		await updater.tick();

		expect(updater.getState().phase).toBe('installing');
		expect(harness.spawns).toHaveLength(1);
		expect(commandsOf(harness).filter((command) => command === 'gh release')).toHaveLength(1);
	});
});

describe('updater: a new attempt', () => {
	it('after the watchdog fired, Update now downloads and verifies again', async () => {
		const { harness, updater } = await checkedAndAvailable();

		updater.install('manual');
		await updater.waitForIdle();
		harness.clock.now += 2 * 60_000;
		await updater.tick();

		expect(updater.install('manual')).toBe('ok');

		await updater.waitForIdle();

		expect(commandsOf(harness).filter((command) => command === 'gh release')).toHaveLength(2);
		expect(commandsOf(harness).filter((command) => command === 'codesign --verify')).toHaveLength(
			2,
		);
		expect(harness.spawns).toHaveLength(2);
	});
});

describe('updater: automatic', () => {
	it('on → installs right after a check finds an update', async () => {
		const harness = createUpdaterHarness();
		const updater = harness.create();

		await updater.tick();
		await updater.waitForIdle();

		expect(harness.spawns).toHaveLength(1);
	});

	it('off → only checks', async () => {
		const harness = createUpdaterHarness();
		const updater = harness.create();

		harness.dependencies.settingsStore.replace({ ...DEFAULT_SETTINGS, autoUpdate: false });
		await updater.tick();
		await updater.waitForIdle();

		expect(updater.getState().isUpdateAvailable).toBe(true);
		expect(harness.spawns).toEqual([]);
	});

	it('a dev run → never tries', async () => {
		const harness = createUpdaterHarness({
			installLocation: { canInstall: false, reason: 'Updates work only in the installed app' },
		});
		const updater = harness.create();

		await updater.tick();

		expect(updater.getState().phase).toBe('idle');
		expect(harness.jobs.heldChanges).toEqual([]);
	});

	it('a failed install isn’t retried until the next check', async () => {
		const harness = createUpdaterHarness();
		const updater = harness.create();

		harness.release.isDownloadFailing = true;
		await updater.tick();
		await updater.waitForIdle();
		harness.clock.now += 60_000;
		await updater.tick();
		await updater.waitForIdle();

		expect(commandsOf(harness)).toEqual(['gh api', 'gh release']);

		harness.clock.now += SIX_HOURS_MS;
		await updater.tick();
		await updater.waitForIdle();

		expect(commandsOf(harness)).toEqual(['gh api', 'gh release', 'gh api', 'gh release']);
	});
});

describe('updater: after a restart', () => {
	it('the pending version is running → updated', () => {
		const harness = createUpdaterHarness({ currentVersion: '0.6.1' });

		harness.flags.set('pending_update', JSON.stringify({ version: '0.6.1', at: 1 }));

		const updater = harness.create();

		updater.start();

		expect(updater.getState().lastUpdate).toEqual({ version: '0.6.1', didSucceed: true });
		expect(harness.flags.has('pending_update')).toBe(false);
	});

	it('the old version is still running → the update didn’t finish', () => {
		const harness = createUpdaterHarness({ currentVersion: '0.6.0' });

		harness.flags.set('pending_update', JSON.stringify({ version: '0.6.1', at: 1 }));

		const updater = harness.create();

		updater.start();

		expect(updater.getState().lastUpdate).toEqual({ version: '0.6.1', didSucceed: false });
		expect(harness.flags.has('pending_update')).toBe(false);
	});

	it('an unfinished update isn’t retried on its own for six hours from its start, but Update now works', async () => {
		const harness = createUpdaterHarness({ currentVersion: '0.6.0' });
		const startedAt = harness.clock.now - 60_000;

		harness.flags.set('pending_update', JSON.stringify({ version: '0.6.1', at: startedAt }));

		const updater = harness.create();

		updater.start();
		await updater.tick();
		await updater.waitForIdle();

		expect(updater.getState().isUpdateAvailable).toBe(true);
		expect(harness.spawns).toEqual([]);

		harness.clock.now = startedAt + SIX_HOURS_MS;

		const restarted = harness.create();

		restarted.start();
		await restarted.tick();
		await restarted.waitForIdle();

		expect(harness.spawns).toHaveLength(1);
	});

	it('an unfinished update can still be installed by hand', async () => {
		const harness = createUpdaterHarness({ currentVersion: '0.6.0' });

		harness.flags.set(
			'pending_update',
			JSON.stringify({ version: '0.6.1', at: harness.clock.now }),
		);

		const updater = harness.create();

		updater.start();
		await updater.tick();

		expect(updater.install('manual')).toBe('ok');

		await updater.waitForIdle();

		expect(harness.spawns).toHaveLength(1);
	});

	it('no pending update → nothing to report; leftover downloads are swept', () => {
		const harness = createUpdaterHarness();
		const leftover = join(harness.dataDirectory, 'updates', '0.5.9');

		mkdirSync(leftover, { recursive: true });

		const updater = harness.create();

		updater.start();

		expect(updater.getState().lastUpdate).toBeNull();
		expect(existsSync(leftover)).toBe(false);
	});
});
