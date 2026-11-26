import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../commands/run-command.js';
import type { RunCommand } from '../commands/run-command.js';
import { createSilentLogger } from '../logging/logger.js';
import type { Logger } from '../logging/logger.js';
import { createCloneManager } from './clones.js';

const SUCCESS = { exitCode: 0, stdout: '', stderr: '', isTimedOut: false, durationMs: 1 };

const createRecordingRunCommand = () => {
	const peaks = { overall: 0, byRepo: new Map<string, number>() };
	const activeByRepo = new Map<string, number>();
	const activeTotal = { count: 0 };

	const recordingRunCommand: RunCommand = async ({ args }) => {
		const repoPath = (args[0] === '-C' ? (args[1] ?? '') : (args[3] ?? '')).toLowerCase();
		const current = (activeByRepo.get(repoPath) ?? 0) + 1;

		activeByRepo.set(repoPath, current);
		activeTotal.count += 1;
		peaks.byRepo.set(repoPath, Math.max(peaks.byRepo.get(repoPath) ?? 0, current));
		peaks.overall = Math.max(peaks.overall, activeTotal.count);
		await Bun.sleep(5);
		activeByRepo.set(repoPath, current - 1);
		activeTotal.count -= 1;

		return SUCCESS;
	};

	return { recordingRunCommand, peaks };
};

interface CreateManagerParams {
	clonesDirectory?: string;
	runCommand: RunCommand;
	logger?: Logger;
	sleep?: (milliseconds: number) => Promise<void>;
}

const createManager = ({
	clonesDirectory = mkdtempSync(join(tmpdir(), 'prb-clones-')),
	runCommand: run,
	logger = createSilentLogger(),
	sleep = async () => {},
}: CreateManagerParams) => {
	const clones = createCloneManager({
		clonesDirectory,
		ghPath: 'gh',
		gitPath: 'git',
		runCommand: run,
		logger,
		env: {},
		sleep,
	});

	return { clones, clonesDirectory };
};

const git = async (args: string[]): Promise<string> => {
	const result = await runCommand({ command: 'git', args, env: process.env });

	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}

	return result.stdout;
};

const createLocalClone = async (): Promise<string> => {
	const root = mkdtempSync(join(tmpdir(), 'prb-git-'));
	const origin = join(root, 'origin');
	const clonesDirectory = join(root, 'clones');

	await git(['init', '-q', origin]);
	await git([
		'-C',
		origin,
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.com',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'first',
	]);
	await git(['clone', '-q', origin, join(clonesDirectory, 'acme', 'api')]);

	return clonesDirectory;
};

const listWorktrees = async (clonesDirectory: string): Promise<string> => {
	return git(['-C', join(clonesDirectory, 'acme', 'api'), 'worktree', 'list']);
};

const reference = { owner: 'acme', repo: 'api', number: 1 };

describe('createCloneManager locking', () => {
	it('one repo → updated one at a time; other repos → in parallel', async () => {
		const { recordingRunCommand, peaks } = createRecordingRunCommand();
		const { clones, clonesDirectory } = createManager({ runCommand: recordingRunCommand });

		await Promise.all([
			clones.prepareClone(reference),
			clones.prepareClone({ ...reference, number: 3 }),
			clones.prepareClone({ owner: 'acme', repo: 'web', number: 2 }),
		]);

		expect(peaks.byRepo.get(join(clonesDirectory, 'acme', 'api').toLowerCase())).toBe(1);
		expect(peaks.overall).toBeGreaterThanOrEqual(2);
	});

	it('same repo in different case → serialized', async () => {
		const { recordingRunCommand, peaks } = createRecordingRunCommand();
		const { clones, clonesDirectory } = createManager({ runCommand: recordingRunCommand });

		await Promise.all([
			clones.prepareClone(reference),
			clones.prepareClone({ owner: 'Acme', repo: 'API', number: 2 }),
		]);

		expect(peaks.byRepo.get(join(clonesDirectory, 'acme', 'api').toLowerCase())).toBe(1);
	});

	it('a failed update → the next one for that repo still runs', async () => {
		const exitCodes = [1];
		const { clones } = createManager({
			runCommand: async () => ({ ...SUCCESS, exitCode: exitCodes.shift() ?? 0, stderr: 'boom' }),
		});

		const outcomes = await Promise.allSettled([
			clones.prepareClone(reference),
			clones.prepareClone(reference),
		]);

		expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'fulfilled']);
	});

	it('worktree removal fails → logged, release still resolves', async () => {
		const warnings: unknown[] = [];
		const { clones } = createManager({
			runCommand: async ({ args }) =>
				args.includes('remove') ? { ...SUCCESS, exitCode: 1, stderr: 'locked' } : SUCCESS,
			logger: {
				...createSilentLogger(),
				warn: (event) => {
					warnings.push(event);
				},
			},
		});

		const clone = await clones.prepareClone(reference);

		expect(await clone.release()).toBeUndefined();
		expect(warnings).toEqual(['worktree_remove_failed']);
	});
});

describe('createCloneManager with a real git repo', () => {
	it('two jobs on one repo → separate worktrees, each removed on release', async () => {
		const { clones, clonesDirectory } = createManager({
			clonesDirectory: await createLocalClone(),
			runCommand,
		});

		const [first, second] = await Promise.all([
			clones.prepareClone(reference),
			clones.prepareClone({ ...reference, number: 2 }),
		]);

		expect(first.path).not.toBe(second.path);
		expect(await listWorktrees(clonesDirectory)).toContain(first.path);
		expect(await listWorktrees(clonesDirectory)).toContain(second.path);

		await first.release();

		expect(existsSync(first.path)).toBe(false);
		expect(await listWorktrees(clonesDirectory)).not.toContain(first.path);
		expect(await listWorktrees(clonesDirectory)).toContain(second.path);

		await second.release();
	});

	it('worktrees left by a crash → removed the first time the repo is prepared', async () => {
		const clonesDirectory = await createLocalClone();
		const crashed = await createManager({ clonesDirectory, runCommand }).clones.prepareClone(
			reference,
		);
		const restarted = createManager({ clonesDirectory, runCommand }).clones;

		const fresh = await restarted.prepareClone(reference);

		expect(existsSync(crashed.path)).toBe(false);
		expect(await listWorktrees(clonesDirectory)).not.toContain(crashed.path);

		await fresh.release();
	});

	it('a sibling repo named like "<repo>-jobs" → left alone by stale cleanup', async () => {
		const clonesDirectory = await createLocalClone();
		const siblingMarker = join(
			clonesDirectory,
			reference.owner,
			`${reference.repo}-jobs`,
			'marker',
		);

		mkdirSync(dirname(siblingMarker), { recursive: true });
		writeFileSync(siblingMarker, 'keep');

		const clone = await createManager({ clonesDirectory, runCommand }).clones.prepareClone(
			reference,
		);

		expect(existsSync(siblingMarker)).toBe(true);
		expect(clone.path.startsWith(join(clonesDirectory, '.worktrees'))).toBe(true);

		await clone.release();
	});
});

describe('git lock errors', () => {
	const lockFailure = (stderr: string) => ({ ...SUCCESS, exitCode: 1, stderr });

	const createLockingRunCommand = (failures: string[], failingCommand = 'fetch') => {
		const calls: string[][] = [];

		const run: RunCommand = async ({ args }) => {
			calls.push(args);

			const isFailingCommand = args.includes(failingCommand);
			const failure = isFailingCommand ? failures.shift() : undefined;

			return failure === undefined ? SUCCESS : lockFailure(failure);
		};

		return { run, calls };
	};

	it('a fetch that hits a ref lock is retried with growing backoff, then succeeds', async () => {
		const { run, calls } = createLockingRunCommand([
			"error: cannot lock ref 'refs/remotes/origin/main'",
			"fatal: Unable to create '/x/.git/shallow.lock': File exists.",
		]);
		const delays: number[] = [];
		const warnings: string[] = [];
		const { clones } = createManager({
			runCommand: run,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
			logger: {
				...createSilentLogger(),
				warn: (event) => {
					warnings.push(event);
				},
			},
		});

		const clone = await clones.prepareClone({ owner: 'acme', repo: 'api', number: 1 });

		expect(clone.path).toContain('.worktrees');
		expect(calls.filter((args) => args.includes('fetch'))).toHaveLength(3);
		expect(delays).toEqual([500, 1000]);
		expect(warnings).toEqual(['git_lock_retry', 'git_lock_retry']);
	});

	it('a worktree add that hits a lock is retried too', async () => {
		const { run, calls } = createLockingRunCommand(
			["fatal: Unable to create '/x/.git/worktrees.lock': File exists."],
			'add',
		);
		const { clones } = createManager({ runCommand: run });

		const clone = await clones.prepareClone({ owner: 'acme', repo: 'api', number: 1 });

		expect(clone.path).toContain('.worktrees');
		expect(calls.filter((args) => args.includes('add'))).toHaveLength(2);
	});

	it('still locked after three retries and nothing to repair → re-cloned', async () => {
		const lockError = "error: cannot lock ref 'refs/remotes/origin/main'";
		const { run, calls } = createLockingRunCommand([lockError, lockError, lockError, lockError]);
		const { clones } = createManager({ runCommand: run });

		await clones.prepareClone({ owner: 'acme', repo: 'api', number: 1 });

		expect(calls.filter((args) => args.includes('fetch'))).toHaveLength(4);
		expect(calls.filter((args) => args[0] === 'repo' && args[1] === 'clone')).toHaveLength(2);
	});

	it('the fresh clone fails too → the prepare fails', async () => {
		const lockError = "error: cannot lock ref 'refs/remotes/origin/main'";
		const calls: string[][] = [];
		const { clones } = createManager({
			runCommand: async ({ args }) => {
				calls.push(args);

				if (args.includes('fetch')) {
					return { ...SUCCESS, exitCode: 1, stderr: lockError };
				}

				const isReclone =
					args[1] === 'clone' && calls.filter((call) => call[1] === 'clone').length > 1;

				return isReclone ? { ...SUCCESS, exitCode: 1, stderr: 'clone failed' } : SUCCESS;
			},
		});

		await expect(clones.prepareClone({ owner: 'acme', repo: 'api', number: 1 })).rejects.toThrow(
			'clone failed',
		);
	});

	it('any other git error is not retried', async () => {
		const { run, calls } = createLockingRunCommand(['fatal: repository not found']);
		const { clones } = createManager({ runCommand: run });

		await expect(clones.prepareClone({ owner: 'acme', repo: 'api', number: 1 })).rejects.toThrow(
			'repository not found',
		);
		expect(calls.filter((args) => args.includes('fetch'))).toHaveLength(1);
	});
});

describe('broken clone repair', () => {
	const failure = (stderr: string) => ({ ...SUCCESS, exitCode: 1, stderr });
	const collidingRefError =
		// Verbatim shape of the speak-api failure on 2026-11-26
		"error: could not delete references: cannot lock ref 'refs/remotes/origin/feature/prof-1/x': Unable to create '/c/.git/refs/remotes/origin/feature/prof-1/x.lock': File exists.";

	interface ScriptedRunParams {
		fetchFailures: string[];
		remoteRefs?: string[];
	}

	const createScriptedRun = ({ fetchFailures, remoteRefs = [] }: ScriptedRunParams) => {
		const calls: string[][] = [];

		const run: RunCommand = async ({ command, args }) => {
			calls.push([command, ...args]);

			if (args.includes('fetch')) {
				const stderr = fetchFailures.shift();

				return stderr === undefined || stderr === '' ? SUCCESS : failure(stderr);
			}

			if (args.includes('for-each-ref')) {
				return { ...SUCCESS, stdout: `${remoteRefs.join('\n')}\n` };
			}

			return SUCCESS;
		};

		return { run, calls };
	};

	const createLoggedManager = (run: RunCommand, clonesDirectory?: string) => {
		const events: string[] = [];

		const record = (event: string) => {
			events.push(event);
		};

		const manager = createManager({
			clonesDirectory,
			runCommand: run,
			logger: { ...createSilentLogger(), info: record, warn: record, error: record },
		});

		return { ...manager, events };
	};

	const withCloneDirectory = (clonesDirectory: string): string => {
		mkdirSync(join(clonesDirectory, 'acme', 'api', '.git'), { recursive: true });

		return clonesDirectory;
	};

	it('refs differing only in case block the prune → both deleted, fetch retried, no re-clone', async () => {
		const { run, calls } = createScriptedRun({
			fetchFailures: [collidingRefError, collidingRefError, collidingRefError, collidingRefError],
			remoteRefs: [
				'refs/remotes/origin/main',
				'refs/remotes/origin/feature/PROF-1/x',
				'refs/remotes/origin/feature/prof-1/x',
			],
		});
		const { clones, events } = createLoggedManager(
			run,
			withCloneDirectory(mkdtempSync(join(tmpdir(), 'prb-clones-'))),
		);

		await clones.prepareClone(reference);

		const deleted = calls.filter((args) => args.includes('update-ref')).map((args) => args.at(-1));

		expect(deleted).toEqual([
			'refs/remotes/origin/feature/PROF-1/x',
			'refs/remotes/origin/feature/prof-1/x',
		]);
		expect(calls.some((args) => args[0] === 'gh')).toBe(false);
		expect(events).toContain('clone_repaired');
	});

	it('repair did not help and nothing uses the clone → re-cloned', async () => {
		const corrupt = 'fatal: bad object refs/remotes/origin/main';
		const { run, calls } = createScriptedRun({ fetchFailures: [corrupt, corrupt] });
		const clonesDirectory = withCloneDirectory(mkdtempSync(join(tmpdir(), 'prb-clones-')));
		const { clones, events } = createLoggedManager(run, clonesDirectory);

		await clones.prepareClone(reference);

		expect(calls.filter((args) => args[0] === 'gh' && args.includes('clone'))).toHaveLength(1);
		expect(events).toContain('clone_repaired');
	});

	it('repair did not help but another review is using the clone → fails, clone kept', async () => {
		const corrupt = 'fatal: bad object refs/remotes/origin/main';
		const { run, calls } = createScriptedRun({ fetchFailures: ['', corrupt, corrupt] });
		const clonesDirectory = withCloneDirectory(mkdtempSync(join(tmpdir(), 'prb-clones-')));
		const { clones, events } = createLoggedManager(run, clonesDirectory);
		const running = await clones.prepareClone(reference);

		await expect(clones.prepareClone({ ...reference, number: 2 })).rejects.toThrow('bad object');
		expect(calls.some((args) => args[0] === 'gh')).toBe(false);
		expect(existsSync(join(clonesDirectory, 'acme', 'api', '.git'))).toBe(true);
		expect(events).toContain('clone_reclone_skipped');

		await running.release();
	});

	it('one review released twice while another still runs → no re-clone under the one running', async () => {
		const corrupt = 'fatal: bad object refs/remotes/origin/main';
		const { run, calls } = createScriptedRun({ fetchFailures: ['', '', corrupt, corrupt] });
		const { clones, events } = createLoggedManager(
			run,
			withCloneDirectory(mkdtempSync(join(tmpdir(), 'prb-clones-'))),
		);
		const first = await clones.prepareClone(reference);
		const second = await clones.prepareClone({ ...reference, number: 2 });

		await first.release();
		await first.release();

		await expect(clones.prepareClone({ ...reference, number: 3 })).rejects.toThrow('bad object');
		expect(calls.some((args) => args[0] === 'gh')).toBe(false);
		expect(events).toContain('clone_reclone_skipped');

		await second.release();
	});

	it('every review released → the next broken fetch may re-clone', async () => {
		const corrupt = 'fatal: bad object refs/remotes/origin/main';
		const { run, calls } = createScriptedRun({ fetchFailures: ['', corrupt, corrupt] });
		const { clones } = createLoggedManager(
			run,
			withCloneDirectory(mkdtempSync(join(tmpdir(), 'prb-clones-'))),
		);
		const finished = await clones.prepareClone(reference);

		await finished.release();
		await clones.prepareClone({ ...reference, number: 2 });

		expect(calls.filter((args) => args[0] === 'gh' && args.includes('clone'))).toHaveLength(1);
	});

	it('refs repaired but the retry hits a network error → clone kept, network error reported', async () => {
		const offline = 'fatal: unable to access: Could not resolve host: github.com';
		const { run, calls } = createScriptedRun({
			fetchFailures: [
				collidingRefError,
				collidingRefError,
				collidingRefError,
				collidingRefError,
				offline,
			],
			remoteRefs: ['refs/remotes/origin/feature/PROF-1/x', 'refs/remotes/origin/feature/prof-1/x'],
		});
		const clonesDirectory = withCloneDirectory(mkdtempSync(join(tmpdir(), 'prb-clones-')));
		const { clones } = createLoggedManager(run, clonesDirectory);

		await expect(clones.prepareClone(reference)).rejects.toThrow('Could not resolve host');
		expect(calls.some((args) => args[0] === 'gh')).toBe(false);
		expect(existsSync(join(clonesDirectory, 'acme', 'api', '.git'))).toBe(true);
	});

	it('network errors → no repair and no re-clone', async () => {
		const offline = 'fatal: unable to access: Could not resolve host: github.com';
		const { run, calls } = createScriptedRun({ fetchFailures: [offline] });
		const { clones, events } = createLoggedManager(
			run,
			withCloneDirectory(mkdtempSync(join(tmpdir(), 'prb-clones-'))),
		);

		await expect(clones.prepareClone(reference)).rejects.toThrow('Could not resolve host');
		expect(calls.some((args) => args[0] === 'gh')).toBe(false);
		expect(events).not.toContain('clone_repair_started');
	});
});

describe('broken clone repair with a real git repo', () => {
	const commitIn = (repository: string, message: string) =>
		git([
			'-C',
			repository,
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.com',
			'commit',
			'-q',
			'--allow-empty',
			'-m',
			message,
		]);

	it('a lock file left by a crashed git → removed, the fetch goes through', async () => {
		const clonesDirectory = await createLocalClone();
		const clonePath = join(clonesDirectory, 'acme', 'api');
		const origin = join(dirname(clonesDirectory), 'origin');
		const branch = (await git(['-C', origin, 'symbolic-ref', '--short', 'HEAD'])).trim();
		const staleLock = join(clonePath, '.git', 'refs', 'remotes', 'origin', `${branch}.lock`);

		await commitIn(origin, 'second');
		mkdirSync(dirname(staleLock), { recursive: true });
		writeFileSync(staleLock, '');
		utimesSync(staleLock, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

		const clone = await createManager({ clonesDirectory, runCommand }).clones.prepareClone(
			reference,
		);

		expect(existsSync(staleLock)).toBe(false);
		expect(await git(['-C', clonePath, 'log', '-1', '--format=%s', `origin/${branch}`])).toContain(
			'second',
		);

		await clone.release();
	});
});
