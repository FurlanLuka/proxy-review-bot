import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
	detailOf,
	downloadRelease,
	installScriptPathOf,
	messageOf,
	verifyDownload,
} from './update-download.js';
import {
	buildInstallerEnv,
	isNewerVersion,
	parseLatestRelease,
	RELEASE_REPOSITORY,
} from './update-rules.js';
import type { LatestRelease } from './update-rules.js';
import type {
	InstallRequestResult,
	LastUpdate,
	UpdatePhase,
	UpdaterDependencies,
	UpdateState,
} from './update-types.js';

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const HANDOFF_TIMEOUT_MS = 2 * 60_000;
const PENDING_UPDATE_FLAG = 'pending_update';
const BLOCKED_UPDATE_FLAG = 'blocked_update';

export interface Updater {
	/** Clears leftovers and reports how the last hand-off ended; run once at startup. */
	start(): void;
	tick(): Promise<void>;
	check(): Promise<void>;
	install(trigger: 'manual' | 'auto'): InstallRequestResult;
	waitForIdle(): Promise<void>;
	getState(): UpdateState;
}

/** Both update flags: `pending_update` is when the hand-off started, `blocked_update` when its hold ends */
interface VersionAt {
	version: string;
	at: number;
}

interface UpdaterRuntime {
	phase: UpdatePhase;
	latest: LatestRelease | null;
	lastCheckedAt: number | null;
	lastCheckAttemptAt: number | null;
	error: string | null;
	lastUpdate: LastUpdate | null;
	handedOffAt: number | null;
	isHoldingJobs: boolean;
	verifiedDirectory: { version: string; directory: string } | null;
	job: Promise<void> | null;
}

const BUSY_PHASES: UpdatePhase[] = ['checking', 'waiting_for_reviews', 'downloading', 'installing'];

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

const parseVersionAt = (value: string | null): VersionAt | null => {
	const parsed = value === null ? null : parseJson(value);

	return typeof parsed === 'object' &&
		parsed !== null &&
		'version' in parsed &&
		'at' in parsed &&
		typeof parsed.version === 'string' &&
		typeof parsed.at === 'number'
		? { version: parsed.version, at: parsed.at }
		: null;
};

const toFlag = (version: string, at: number): string => {
	return JSON.stringify({ version, at });
};

export const createUpdater = (dependencies: UpdaterDependencies): Updater => {
	const { runCommand, flags, jobs, logger, now, currentVersion, installLocation } = dependencies;
	const runtime: UpdaterRuntime = {
		phase: 'idle',
		latest: null,
		lastCheckedAt: null,
		lastCheckAttemptAt: null,
		error: null,
		lastUpdate: null,
		handedOffAt: null,
		isHoldingJobs: false,
		verifiedDirectory: null,
		job: null,
	};
	const ghPath = dependencies.ghPath ?? 'gh';

	const isUpdateAvailable = (): boolean => {
		return runtime.latest !== null && isNewerVersion(runtime.latest.version, currentVersion);
	};

	const holdJobs = (isHeld: boolean): void => {
		if (runtime.isHoldingJobs !== isHeld) {
			runtime.isHoldingJobs = isHeld;
			jobs.setHeld(isHeld);
		}
	};

	const fail = (stage: string, message: string): void => {
		runtime.phase = 'failed';
		runtime.error = message;
		runtime.handedOffAt = null;
		runtime.verifiedDirectory = null;
		holdJobs(false);
		logger.warn('update_failed', { stage, message, version: runtime.latest?.version ?? null });
	};

	// A version whose install didn't finish waits a full check interval before installing on its own.
	const isAutoInstallHeld = (): boolean => {
		const blocked = parseVersionAt(flags.getFlag(BLOCKED_UPDATE_FLAG));

		return blocked !== null && blocked.at > now() && blocked.version === runtime.latest?.version;
	};

	const checkLatestRelease = async (): Promise<void> => {
		const result = await runCommand({
			command: ghPath,
			args: ['api', `repos/${RELEASE_REPOSITORY}/releases/latest`],
			env: dependencies.baseEnv,
		});

		if (result.exitCode !== 0) {
			fail('check', `Couldn't check for updates: ${detailOf(result.stderr || result.stdout)}`);

			return;
		}

		const parsed = parseLatestRelease(parseJson(result.stdout));

		if (parsed.kind === 'invalid') {
			fail('check', parsed.reason);

			return;
		}

		runtime.latest = parsed.release;
		runtime.lastCheckedAt = now();
		runtime.phase = 'idle';
		runtime.error = null;
		logger.info('update_check_finished', {
			currentVersion,
			latestVersion: parsed.release.version,
			isUpdateAvailable: isUpdateAvailable(),
		});
	};

	const check = async (): Promise<void> => {
		if (BUSY_PHASES.includes(runtime.phase)) {
			return;
		}

		runtime.phase = 'checking';
		runtime.lastCheckAttemptAt = now();

		try {
			await checkLatestRelease();
		} catch (error) {
			fail('check', `Couldn't check for updates: ${messageOf(error)}`);
		}
	};

	const handOff = (release: LatestRelease, directory: string, installDirectory: string): void => {
		runtime.verifiedDirectory = null;
		flags.setFlag(PENDING_UPDATE_FLAG, toFlag(release.version, now()));
		dependencies.spawnInstaller({
			scriptPath: installScriptPathOf(directory),
			env: buildInstallerEnv({
				baseEnv: dependencies.baseEnv,
				zipPath: join(directory, release.assetName),
				installDirectory,
				toolPaths: [dependencies.ghPath, dependencies.gitPath],
			}),
			logPath: dependencies.updateLogPath,
			cwd: dependencies.baseEnv.HOME ?? '/',
			onError: (error) => {
				flags.setFlag(PENDING_UPDATE_FLAG, null);
				fail('handoff', `Couldn't start the installer: ${error.message}`);
			},
		});
		runtime.phase = 'installing';
		runtime.handedOffAt = now();
		logger.info('update_install_handed_off', {
			version: release.version,
			installDirectory,
			updateLogPath: dependencies.updateLogPath,
		});
	};

	const handOffWhenIdle = (
		release: LatestRelease,
		directory: string,
		installDirectory: string,
	): void => {
		// Something started while the download ran (an approval or a post): wait for it.
		if (!jobs.isIdle()) {
			runtime.phase = 'waiting_for_reviews';
			runtime.verifiedDirectory = { version: release.version, directory };

			return;
		}

		try {
			handOff(release, directory, installDirectory);
		} catch (error) {
			flags.setFlag(PENDING_UPDATE_FLAG, null);
			fail('handoff', `Couldn't start the installer: ${messageOf(error)}`);
		}
	};

	const downloadAndVerify = async (
		release: LatestRelease,
		installDirectory: string,
	): Promise<void> => {
		const directory = join(dependencies.updatesDirectory, release.version);

		runtime.phase = 'downloading';
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(directory, { recursive: true });

		const downloaded = await downloadRelease({
			runCommand,
			ghPath,
			env: dependencies.baseEnv,
			release,
			directory,
		});
		const verified = downloaded.isOk
			? await verifyDownload({ runCommand, release, directory })
			: downloaded;

		if (!verified.isOk) {
			fail(verified.stage, verified.message);

			return;
		}

		logger.info('update_install_verified', { version: release.version });
		handOffWhenIdle(release, directory, installDirectory);
	};

	const tryInstall = (): void => {
		const release = runtime.latest;

		if (runtime.phase !== 'waiting_for_reviews' || release === null || !jobs.isIdle()) {
			return;
		}

		if (!installLocation.canInstall) {
			fail('install', installLocation.reason);

			return;
		}

		const verified = runtime.verifiedDirectory;

		if (verified?.version === release.version) {
			handOffWhenIdle(release, verified.directory, installLocation.installDirectory);

			return;
		}

		runtime.job = downloadAndVerify(release, installLocation.installDirectory)
			.catch((error: unknown) => fail('install', `The update failed: ${messageOf(error)}`))
			.finally(() => {
				runtime.job = null;
			});
	};

	const install = (trigger: 'manual' | 'auto'): InstallRequestResult => {
		if (!installLocation.canInstall) {
			return 'cannot_install';
		}

		if (BUSY_PHASES.includes(runtime.phase)) {
			return 'busy';
		}

		if (!isUpdateAvailable()) {
			return 'no_update';
		}

		runtime.phase = 'waiting_for_reviews';
		runtime.error = null;
		holdJobs(true);
		logger.info('update_install_started', { version: runtime.latest?.version ?? null, trigger });
		tryInstall();

		return 'ok';
	};

	const isCheckDue = (): boolean => {
		return (
			runtime.lastCheckAttemptAt === null || now() - runtime.lastCheckAttemptAt >= CHECK_INTERVAL_MS
		);
	};

	const tick = async (): Promise<void> => {
		const isHandOffOverdue =
			runtime.handedOffAt !== null && now() - runtime.handedOffAt >= HANDOFF_TIMEOUT_MS;

		if (isHandOffOverdue) {
			flags.setFlag(PENDING_UPDATE_FLAG, null);
			fail('handoff', "The installer didn't finish. See update.log");

			return;
		}

		if (runtime.phase === 'waiting_for_reviews') {
			tryInstall();

			return;
		}

		if (!isCheckDue()) {
			return;
		}

		await check();

		const shouldInstall =
			dependencies.settingsStore.get().autoUpdate &&
			runtime.phase === 'idle' &&
			isUpdateAvailable() &&
			installLocation.canInstall &&
			!isAutoInstallHeld();

		if (shouldInstall) {
			install('auto');
		}
	};

	const start = (): void => {
		rmSync(dependencies.updatesDirectory, { recursive: true, force: true });

		const pending = parseVersionAt(flags.getFlag(PENDING_UPDATE_FLAG));

		if (pending === null) {
			return;
		}

		const didSucceed = pending.version === currentVersion;

		flags.setFlag(PENDING_UPDATE_FLAG, null);

		if (!didSucceed) {
			flags.setFlag(BLOCKED_UPDATE_FLAG, toFlag(pending.version, pending.at + CHECK_INTERVAL_MS));
		}

		runtime.lastUpdate = { version: pending.version, didSucceed };
		logger.info('update_finished', { ...runtime.lastUpdate, currentVersion });
	};

	return {
		start,
		tick,
		check,
		install,
		waitForIdle: async () => {
			while (runtime.job !== null) {
				await runtime.job;
			}
		},
		getState: () => ({
			currentVersion,
			latestVersion: runtime.latest?.version ?? null,
			isUpdateAvailable: isUpdateAvailable(),
			canInstall: installLocation.canInstall,
			cannotInstallReason: installLocation.canInstall ? null : installLocation.reason,
			phase: runtime.phase,
			lastCheckedAt: runtime.lastCheckedAt,
			error: runtime.error,
			lastUpdate: runtime.lastUpdate,
		}),
	};
};
