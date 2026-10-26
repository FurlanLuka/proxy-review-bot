import { describe, expect, it } from 'bun:test';
import { runCommand } from './run-command.js';

describe('runCommand', () => {
	it('streams stdout line by line, including a last line without a newline', async () => {
		const lines: string[] = [];
		const result = await runCommand({
			command: '/bin/sh',
			args: ['-c', 'printf "one\\ntw"; sleep 0.1; printf "o\\nthree"'],
			onStdoutLine: (line) => lines.push(line),
		});

		expect(lines).toEqual(['one', 'two', 'three']);
		expect(result.stdout).toBe('one\ntwo\nthree');
		expect(result.exitCode).toBe(0);
	});

	it('timeout kills the process group and reports it', async () => {
		const result = await runCommand({
			command: '/bin/sh',
			args: ['-c', 'sleep 5'],
			timeoutMs: 100,
		});

		expect(result.isTimedOut).toBe(true);
		expect(result.durationMs).toBeLessThan(2000);
	});
});

describe('runCommand abort', () => {
	it('aborting kills the process group right away', async () => {
		const abortController = new AbortController();
		const running = runCommand({
			command: '/bin/sh',
			args: ['-c', 'sleep 5'],
			timeoutMs: 10_000,
			signal: abortController.signal,
		});

		setTimeout(() => abortController.abort(), 50);

		const result = await running;

		expect(result.isTimedOut).toBe(false);
		expect(result.durationMs).toBeLessThan(2000);
	});

	it('an already aborted signal → the command is killed as soon as it starts', async () => {
		const result = await runCommand({
			command: '/bin/sh',
			args: ['-c', 'sleep 5'],
			signal: AbortSignal.abort(),
		});

		expect(result.durationMs).toBeLessThan(2000);
	});
});

describe('runCommand line streaming robustness', () => {
	it('a multi-byte character split across chunks stays intact', async () => {
		const lines: string[] = [];

		await runCommand({
			command: '/bin/sh',
			args: ['-c', "printf '\\342\\200'; sleep 0.1; printf '\\224done\\n'"],
			onStdoutLine: (line) => lines.push(line),
		});

		expect(lines).toEqual(['—done']);
	});

	it('a throwing line listener does not crash or hang the command', async () => {
		const result = await runCommand({
			command: '/bin/sh',
			args: ['-c', 'printf "a\\nb\\n"'],
			onStdoutLine: () => {
				throw new Error('listener broke');
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('a\nb\n');
	});
});
