import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCommand } from '../commands/run-command.js';
import type { PullRequestReference } from '../github/github-types.js';
import type { Logger } from '../logging/logger.js';

const WORKTREES_DIRECTORY = '.worktrees';
const GIT_LOCK_PATTERN = /cannot lock ref|Unable to create '[^']*\.lock': File exists/i;
const GIT_LOCK_RETRIES = 3;
const GIT_LOCK_BACKOFF_MS = 500;

export interface PreparedClone {
	path: string;
	release(): Promise<void>;
}

export const runInClone = async <Result>(
	clone: PreparedClone,
	run: (clonePath: string) => Promise<Result>,
): Promise<Result> => {
	try {
		return await run(clone.path);
	} finally {
		void clone.release();
	}
};

export interface CloneManager {
	prepareClone(reference: PullRequestReference): Promise<PreparedClone>;
}

interface CreateCloneManagerParams {
	clonesDirectory: string;
	ghPath: string;
	gitPath: string;
	runCommand: RunCommand;
	logger: Logger;
	env: Record<string, string | undefined>;
	sleep?: (milliseconds: number) => Promise<void>;
}

interface RemoveStaleWorktreesParams {
	owner: string;
	repo: string;
	clonePath: string;
	worktreesDirectory: string;
}

interface PrepareJobWorktreeParams {
	owner: string;
	repo: string;
	key: string;
}

interface JobWorktree {
	clonePath: string;
	worktreePath: string;
}

export const createCloneManager = ({
	clonesDirectory,
	ghPath,
	gitPath,
	runCommand,
	logger,
	env,
	sleep = Bun.sleep,
}: CreateCloneManagerParams): CloneManager => {
	const pendingByRepo = new Map<string, Promise<unknown>>();
	const cleanedRepos = new Set<string>();

	const runChecked = async (command: string, args: string[]): Promise<void> => {
		const result = await runCommand({ command, args, env, timeoutMs: 10 * 60_000 });

		if (result.exitCode !== 0) {
			throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim()}`);
		}
	};

	const runGitRetryingLocks = async (args: string[]): Promise<void> => {
		for (let attempt = 1; ; attempt++) {
			try {
				await runChecked(gitPath, args);

				return;
			} catch (error) {
				const isLockError = error instanceof Error && GIT_LOCK_PATTERN.test(error.message);

				if (!isLockError || attempt > GIT_LOCK_RETRIES) {
					throw error;
				}

				logger.warn('git_lock_retry', { args: args.slice(2, 4), attempt });
				await sleep(GIT_LOCK_BACKOFF_MS * attempt);
			}
		}
	};

	const oneAtATimePerRepo = <Value>(key: string, task: () => Promise<Value>): Promise<Value> => {
		const previous = pendingByRepo.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(task);

		pendingByRepo.set(key, next);

		return next;
	};

	const removeStaleWorktrees = async ({
		owner,
		repo,
		clonePath,
		worktreesDirectory,
	}: RemoveStaleWorktreesParams): Promise<void> => {
		rmSync(worktreesDirectory, { recursive: true, force: true });
		await runChecked(gitPath, ['-C', clonePath, 'worktree', 'prune']);
		logger.info('stale_worktrees_removed', { owner, repo });
	};

	const prepareJobWorktree = async ({
		owner,
		repo,
		key,
	}: PrepareJobWorktreeParams): Promise<JobWorktree> => {
		const clonePath = join(clonesDirectory, owner, repo);
		const worktreesDirectory = join(clonesDirectory, WORKTREES_DIRECTORY, owner, repo);

		if (!existsSync(join(clonePath, '.git'))) {
			mkdirSync(join(clonesDirectory, owner), { recursive: true });
			logger.info('clone_created', { owner, repo });
			await runChecked(ghPath, [
				'repo',
				'clone',
				`${owner}/${repo}`,
				clonePath,
				'--',
				'--filter=blob:none',
			]);
		}

		if (!cleanedRepos.has(key)) {
			await removeStaleWorktrees({ owner, repo, clonePath, worktreesDirectory });
			cleanedRepos.add(key);
		}

		await runGitRetryingLocks(['-C', clonePath, 'fetch', '--prune', 'origin']);

		const worktreePath = join(worktreesDirectory, randomUUID());

		mkdirSync(worktreesDirectory, { recursive: true });
		await runGitRetryingLocks([
			'-C',
			clonePath,
			'worktree',
			'add',
			'--detach',
			'--no-checkout',
			worktreePath,
		]);
		logger.info('worktree_created', { owner, repo, worktreePath });

		return { clonePath, worktreePath };
	};

	const removeWorktree = async (clonePath: string, worktreePath: string): Promise<void> => {
		try {
			await runChecked(gitPath, ['-C', clonePath, 'worktree', 'remove', '--force', worktreePath]);
			logger.info('worktree_removed', { worktreePath });
		} catch (error) {
			logger.warn('worktree_remove_failed', { worktreePath, error });
		}
	};

	return {
		prepareClone: async ({ owner, repo }) => {
			const key = `${owner}/${repo}`.toLowerCase();
			const { clonePath, worktreePath } = await oneAtATimePerRepo(key, () =>
				prepareJobWorktree({ owner, repo, key }),
			);

			return {
				path: worktreePath,
				release: () => oneAtATimePerRepo(key, () => removeWorktree(clonePath, worktreePath)),
			};
		},
	};
};
