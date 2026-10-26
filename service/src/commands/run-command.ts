import { spawn } from 'node:child_process';

export interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	isTimedOut: boolean;
	durationMs: number;
}

export interface RunCommandParams {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	input?: string;
	timeoutMs?: number;
}

export type RunCommand = (params: RunCommandParams) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

const runningProcessIds = new Set<number>();

const killProcessGroup = (processId: number | undefined): void => {
	if (processId === undefined) {
		return;
	}

	try {
		process.kill(-processId, 'SIGTERM');
	} catch {
		// The group already exited.
	}
};

export const killRunningCommands = (): void => {
	for (const processId of runningProcessIds) {
		killProcessGroup(processId);
	}
};

export const runCommand: RunCommand = ({ command, args, cwd, env, input, timeoutMs }) => {
	const startedAt = performance.now();

	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: env ?? process.env,
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const processId = child.pid;

		if (processId !== undefined) {
			runningProcessIds.add(processId);
		}

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const state = { isTimedOut: false };
		const timer = setTimeout(() => {
			state.isTimedOut = true;
			killProcessGroup(child.pid);
		}, timeoutMs ?? DEFAULT_TIMEOUT_MS);

		child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
		child.on('error', (error) => {
			clearTimeout(timer);
			runningProcessIds.delete(processId ?? -1);
			reject(error);
		});
		child.on('close', (exitCode) => {
			clearTimeout(timer);
			runningProcessIds.delete(processId ?? -1);
			resolve({
				exitCode,
				stdout: Buffer.concat(stdoutChunks).toString('utf8'),
				stderr: Buffer.concat(stderrChunks).toString('utf8'),
				isTimedOut: state.isTimedOut,
				durationMs: Math.round(performance.now() - startedAt),
			});
		});

		child.stdin.end(input ?? '');
	});
};
