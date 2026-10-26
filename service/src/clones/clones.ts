import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCommand } from '../commands/run-command.js';
import type { PullRequestReference } from '../github/github-types.js';
import type { Logger } from '../logging/logger.js';

export interface CloneManager {
	prepareClone(reference: PullRequestReference): Promise<string>;
}

interface CreateCloneManagerParams {
	clonesDirectory: string;
	ghPath: string;
	gitPath: string;
	runCommand: RunCommand;
	logger: Logger;
	env: Record<string, string | undefined>;
}

export const createCloneManager = ({
	clonesDirectory,
	ghPath,
	gitPath,
	runCommand,
	logger,
	env,
}: CreateCloneManagerParams): CloneManager => {
	const runChecked = async (command: string, args: string[]): Promise<void> => {
		const result = await runCommand({ command, args, env, timeoutMs: 10 * 60_000 });

		if (result.exitCode !== 0) {
			throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim()}`);
		}
	};

	return {
		prepareClone: async ({ owner, repo }) => {
			const clonePath = join(clonesDirectory, owner, repo);

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

			await runChecked(gitPath, ['-C', clonePath, 'fetch', '--prune', 'origin']);

			return clonePath;
		},
	};
};
