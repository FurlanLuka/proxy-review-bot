import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
}

const createManager = ({
	clonesDirectory = mkdtempSync(join(tmpdir(), 'prb-clones-')),
	runCommand: run,
	logger = createSilentLogger(),
}: CreateManagerParams) => {
	const clones = createCloneManager({
		clonesDirectory,
		ghPath: 'gh',
		gitPath: 'git',
		runCommand: run,
		logger,
		env: {},
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
