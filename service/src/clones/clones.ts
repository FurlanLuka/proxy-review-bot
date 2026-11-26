import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCommand } from '../commands/run-command.js';
import type { PullRequestReference } from '../github/github-types.js';
import type { Logger } from '../logging/logger.js';

const WORKTREES_DIRECTORY = '.worktrees';
const GIT_LOCK_PATTERN = /cannot lock ref|Unable to create '[^']*\.lock': File exists/i;
const GIT_LOCK_RETRIES = 3;
const GIT_LOCK_BACKOFF_MS = 500;

/**
 * Errors that mean the clone itself is in a bad state, not that GitHub or the network is down.
 * Only these start the repair below; a network error would make a re-clone fail the same way.
 */
const BROKEN_CLONE_PATTERN =
	/cannot lock ref|\.lock': File exists|bad object|corrupt|not a git repository|bad ref|broken link|fatal: bad revision/i;
const LOCKED_REF_PATTERN = /cannot lock ref '([^']+)'/g;
/** A lock file this old is left over from a git process that died: git holds them for seconds. */
const STALE_LOCK_AGE_MS = 10 * 60_000;

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

interface FetchRepairingCloneParams {
	owner: string;
	repo: string;
	key: string;
	clonePath: string;
	worktreesDirectory: string;
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
	/** Reviews using each repo's clone right now: a clone in use is never deleted to re-clone it */
	const activeWorktrees = new Map<string, number>();

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

	const listRemoteRefs = async (clonePath: string): Promise<string[]> => {
		const result = await runCommand({
			command: gitPath,
			args: ['-C', clonePath, 'for-each-ref', '--format=%(refname)', 'refs/remotes/'],
			env,
			timeoutMs: 60_000,
		});

		if (result.exitCode !== 0) {
			logger.warn('clone_ref_list_failed', { clonePath, stderr: result.stderr.trim() });

			return [];
		}

		return result.stdout.split('\n').filter(Boolean);
	};

	/**
	 * Removes lock files left by a git process that died. The repo's jobs are serialized, so
	 * nothing else is writing here; the age check also spares a lock a Claude run just took.
	 */
	const removeStaleLocks = (clonePath: string): string[] => {
		const gitDirectory = join(clonePath, '.git');
		const removed: string[] = [];

		const sweep = (directory: string, isRecursive: boolean): void => {
			const entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : [];

			for (const entry of entries) {
				const path = join(directory, entry.name);

				if (entry.isDirectory() && isRecursive) {
					sweep(path, true);
				} else if (
					entry.isFile() &&
					entry.name.endsWith('.lock') &&
					Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) >
						STALE_LOCK_AGE_MS
				) {
					rmSync(path, { force: true });
					removed.push(path.slice(gitDirectory.length + 1));
				}
			}
		};

		sweep(gitDirectory, false);
		sweep(join(gitDirectory, 'refs'), true);

		return removed;
	};

	/**
	 * Deletes the remote-tracking refs git could not lock, plus every ref that differs from one of
	 * them only in case. macOS folds case, so pruning `feature/PROF-1/x` and `feature/prof-1/x`
	 * together asks for the same lock file twice and fails every time. These refs are only a local
	 * copy of the remote: the next fetch writes back whichever still exist.
	 */
	const removeLockedRefs = async (clonePath: string, message: string): Promise<string[]> => {
		const locked = new Set(
			[...message.matchAll(LOCKED_REF_PATTERN)]
				.map((match) => (match[1] ?? '').toLowerCase())
				.filter((ref) => ref.startsWith('refs/remotes/')),
		);

		if (locked.size === 0) {
			return [];
		}

		const targets = (await listRemoteRefs(clonePath)).filter((ref) =>
			locked.has(ref.toLowerCase()),
		);

		const removed: string[] = [];

		for (const ref of targets) {
			try {
				await runChecked(gitPath, ['-C', clonePath, 'update-ref', '-d', ref]);
				removed.push(ref);
			} catch (error) {
				logger.warn('clone_ref_delete_failed', { clonePath, ref, error });
			}
		}

		return removed;
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

	const createClone = async (owner: string, repo: string, clonePath: string): Promise<void> => {
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
	};

	const fetchClone = (clonePath: string): Promise<void> =>
		runGitRetryingLocks(['-C', clonePath, 'fetch', '--prune', 'origin']);

	/**
	 * Fetches, and when the clone itself is broken repairs it instead of failing every review on
	 * that repo until someone fixes it by hand: first stale locks and refs git can't lock, then,
	 * if that wasn't enough and no review is using the clone, a fresh clone.
	 */
	const fetchRepairingClone = async ({
		owner,
		repo,
		key,
		clonePath,
		worktreesDirectory,
	}: FetchRepairingCloneParams): Promise<void> => {
		try {
			await fetchClone(clonePath);

			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			if (!BROKEN_CLONE_PATTERN.test(message)) {
				throw error;
			}

			const removedLocks = removeStaleLocks(clonePath);
			const removedRefs = await removeLockedRefs(clonePath, message);

			logger.warn('clone_repair_started', { owner, repo, removedLocks, removedRefs });

			let latestError = error;

			if (removedLocks.length > 0 || removedRefs.length > 0) {
				try {
					await fetchClone(clonePath);
					logger.info('clone_repaired', { owner, repo, how: 'refs_and_locks' });

					return;
				} catch (retryError) {
					logger.warn('clone_repair_retry_failed', { owner, repo, error: retryError });
					latestError = retryError;

					// The clone may be fine now and the network down: re-cloning would only lose it
					const retryMessage =
						retryError instanceof Error ? retryError.message : String(retryError);

					if (!BROKEN_CLONE_PATTERN.test(retryMessage)) {
						throw retryError;
					}
				}
			}

			if ((activeWorktrees.get(key) ?? 0) > 0) {
				logger.warn('clone_reclone_skipped', { owner, repo, reason: 'reviews_running' });
				throw latestError;
			}

			rmSync(clonePath, { recursive: true, force: true });
			rmSync(worktreesDirectory, { recursive: true, force: true });
			await createClone(owner, repo, clonePath);
			logger.info('clone_repaired', { owner, repo, how: 'reclone' });
		}
	};

	const prepareJobWorktree = async ({
		owner,
		repo,
		key,
	}: PrepareJobWorktreeParams): Promise<JobWorktree> => {
		const clonePath = join(clonesDirectory, owner, repo);
		const worktreesDirectory = join(clonesDirectory, WORKTREES_DIRECTORY, owner, repo);

		if (!existsSync(join(clonePath, '.git'))) {
			await createClone(owner, repo, clonePath);
		}

		if (!cleanedRepos.has(key)) {
			await removeStaleWorktrees({ owner, repo, clonePath, worktreesDirectory });
			cleanedRepos.add(key);
		}

		await fetchRepairingClone({ owner, repo, key, clonePath, worktreesDirectory });

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
			const { clonePath, worktreePath } = await oneAtATimePerRepo(key, async () => {
				const prepared = await prepareJobWorktree({ owner, repo, key });

				activeWorktrees.set(key, (activeWorktrees.get(key) ?? 0) + 1);

				return prepared;
			});

			let isReleased = false;

			return {
				path: worktreePath,
				release: () =>
					oneAtATimePerRepo(key, async () => {
						if (isReleased) {
							return;
						}

						isReleased = true;
						activeWorktrees.set(key, (activeWorktrees.get(key) ?? 1) - 1);
						await removeWorktree(clonePath, worktreePath);
					}),
			};
		},
	};
};
