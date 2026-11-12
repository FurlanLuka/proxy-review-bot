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
	/** How long a SIGTERMed group gets before SIGKILL: a hung process must not hold its slot forever */
	killGraceMs?: number;
}

export type RunCommand = (params: RunCommandParams) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 10_000;

const runningProcessIds = new Set<number>();

const killProcessGroup = (
	processId: number | undefined,
	signal: NodeJS.Signals = 'SIGTERM',
): void => {
	if (processId === undefined) {
		return;
	}

	try {
		process.kill(-processId, signal);
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
	killGraceMs,
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
		const forceKill: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

		const terminate = (): void => {
			killProcessGroup(child.pid);
			forceKill.timer ??= setTimeout(
				() => killProcessGroup(child.pid, 'SIGKILL'),
				killGraceMs ?? KILL_GRACE_MS,
			);
		};

		const stopTimers = (): void => {
			clearTimeout(timer);

			if (forceKill.timer !== null) {
				clearTimeout(forceKill.timer);
			}
		};

		const timer = setTimeout(() => {
			state.isTimedOut = true;
			terminate();
		}, timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const abort = terminate;

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
			stopTimers();
			signal?.removeEventListener('abort', abort);
			runningProcessIds.delete(processId ?? -1);
			reject(error);
		});
		child.on('close', (exitCode) => {
			stopTimers();
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
