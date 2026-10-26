import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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
	onStdoutLine?: (line: string) => void;
	signal?: AbortSignal;
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

export const runCommand: RunCommand = ({
	command,
	args,
	cwd,
	env,
	input,
	timeoutMs,
	onStdoutLine,
	signal,
}) => {
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
		const abort = (): void => killProcessGroup(child.pid);

		signal?.addEventListener('abort', abort, { once: true });

		if (signal?.aborted) {
			abort();
		}

		const lineBuffer = { pending: '' };
		const decoder = new StringDecoder('utf8');

		const emitLine = (line: string): void => {
			try {
				onStdoutLine?.(line);
			} catch {
				// A broken progress listener must not take the command down.
			}
		};

		child.stdout.on('data', (chunk: Buffer) => {
			stdoutChunks.push(chunk);

			if (onStdoutLine === undefined) {
				return;
			}

			const lines = (lineBuffer.pending + decoder.write(chunk)).split('\n');

			lineBuffer.pending = lines.pop() ?? '';

			for (const line of lines) {
				emitLine(line);
			}
		});
		child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
		child.on('error', (error) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			runningProcessIds.delete(processId ?? -1);
			reject(error);
		});
		child.on('close', (exitCode) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);

			const remainder = lineBuffer.pending + decoder.end();

			if (onStdoutLine !== undefined && remainder.length > 0) {
				emitLine(remainder);
			}

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
