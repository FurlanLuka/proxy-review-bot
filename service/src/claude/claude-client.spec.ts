import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { RunCommand } from '../commands/run-command.js';
import { createSilentLogger } from '../logging/logger.js';
import type { ReviewProgress } from '../review/review-progress.js';
import { createClaudeClient } from './claude-client.js';

const RECORDED_STREAM = readFileSync(
	new URL('../review/fixtures/claude-stream-subagents.ndjson', import.meta.url),
	'utf8',
);

describe('createClaudeClient().runReview failure logging', () => {
	it('a result with the wrong shape → one warn claude_run_finished listing the issues', async () => {
		const envelope = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			structured_output: { outcome: 'drafted', headRefOid: 'abc', summary: 's' },
		});
		const warnings: { event: string; fields: Record<string, unknown> | undefined }[] = [];
		const client = createClaudeClient({
			claudePath: '/bin/claude',
			shimDirectory: '/shims',
			runCommand: async () => ({
				exitCode: 0,
				stdout: envelope,
				stderr: '',
				isTimedOut: false,
				durationMs: 1,
			}),
			logger: {
				...createSilentLogger(),
				warn: (event, fields) => {
					warnings.push({ event, fields });
				},
			},
			baseEnv: { PATH: '/usr/bin' },
		});

		const outcome = await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
		});

		expect(outcome.kind).toBe('failed');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.event).toBe('claude_run_finished');
		expect(warnings[0]?.fields?.schemaIssues).toEqual([expect.stringMatching(/^filing: /)]);
	});
});

describe('createClaudeClient().runReview', () => {
	it('streams progress from the real output lines and returns the parsed result', async () => {
		const calls: { command: string; args: string[] }[] = [];

		const fakeRunCommand: RunCommand = async ({ command, args, onStdoutLine }) => {
			calls.push({ command, args });

			for (const line of RECORDED_STREAM.trim().split('\n')) {
				onStdoutLine?.(line);
			}

			return { exitCode: 0, stdout: RECORDED_STREAM, stderr: '', isTimedOut: false, durationMs: 1 };
		};

		const updates: ReviewProgress[] = [];
		const client = createClaudeClient({
			claudePath: '/bin/claude',
			shimDirectory: '/shims',
			runCommand: fakeRunCommand,
			logger: createSilentLogger(),
			baseEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'secret' },
		});

		const outcome = await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
			onProgress: (progress) => updates.push(progress),
		});

		expect(outcome).toEqual({
			kind: 'result',
			result: { outcome: 'nothing_new', summary: 'stream fixture', headRefOid: 'abc' },
		});
		expect(updates[0]?.message).toBe('Starting the review');
		expect(updates.at(-1)?.message).toBe('Returning structured output');
		expect(updates.at(-1)?.subagents.map((subagent) => subagent.status)).toEqual([
			'completed',
			'completed',
		]);
		expect(updates.length).toBeLessThan(RECORDED_STREAM.trim().split('\n').length);
		expect(calls[0]?.command).toBe('caffeinate');
		expect(calls[0]?.args.slice(0, 3)).toEqual(['-i', '/bin/claude', '-p']);
	});
});
