import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunCommand } from '../commands/run-command.js';
import { createSilentLogger } from '../logging/logger.js';
import type { ReviewProgress } from '../review/review-progress.js';
import { readSessionIdFromLine } from '../review/review-result.js';
import { createClaudeClient, saveFailedResult } from './claude-client.js';
import { REPAIR_PROMPT } from './prompts.js';

const RECORDED_STREAM = readFileSync(
	new URL('../review/fixtures/claude-stream-subagents.ndjson', import.meta.url),
	'utf8',
);

describe('createClaudeClient().runReview abort', () => {
	it('passes the signal to the command; an aborted run fails and is logged as aborted', async () => {
		const controller = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];
		const warnings: (Record<string, unknown> | undefined)[] = [];
		const client = createClaudeClient({
			claudePath: '/bin/claude',
			shimDirectory: '/shims',
			failedResultsDirectory: mkdtempSync(join(tmpdir(), 'prb-failed-')),
			runCommand: async ({ signal }) => {
				signals.push(signal);
				controller.abort();

				return { exitCode: null, stdout: '', stderr: '', isTimedOut: false, durationMs: 1 };
			},
			logger: {
				...createSilentLogger(),
				warn: (_event, fields) => {
					warnings.push(fields);
				},
			},
			baseEnv: { PATH: '/usr/bin' },
		});

		const outcome = await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
			model: null,
			signal: controller.signal,
		});

		expect(signals).toEqual([controller.signal]);
		expect(outcome.kind).toBe('failed');
		expect(warnings[0]).toMatchObject({ isAborted: true });
	});
});

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
			failedResultsDirectory: mkdtempSync(join(tmpdir(), 'prb-failed-')),
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
			model: null,
		});

		expect(outcome.kind).toBe('failed');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.event).toBe('claude_run_finished');
		expect(warnings[0]?.fields?.schemaIssues).toEqual([expect.stringMatching(/^filing: /)]);
	});

	it('no structured output and no JSON in the text → diagnostics logged and the envelope saved', async () => {
		const failedResultsDirectory = mkdtempSync(join(tmpdir(), 'prb-failed-'));
		const envelope = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			num_turns: 41,
			stop_reason: 'end_turn',
			result: 'Here is the draft review for you to check before posting.',
		});
		const warnings: Record<string, unknown>[] = [];
		const client = createClaudeClient({
			claudePath: '/bin/claude',
			shimDirectory: '/shims',
			failedResultsDirectory,
			runCommand: async () => ({
				exitCode: 0,
				stdout: `{"type":"system"}\n${envelope}`,
				stderr: '',
				isTimedOut: false,
				durationMs: 1,
			}),
			logger: {
				...createSilentLogger(),
				warn: (_event, fields) => {
					warnings.push(fields ?? {});
				},
			},
			baseEnv: { PATH: '/usr/bin' },
		});

		await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
			model: null,
		});

		const savedPath = String(warnings[0]?.failedResultPath);

		expect(warnings[0]?.diagnostics).toEqual({
			subtype: 'success',
			numTurns: 41,
			stopReason: 'end_turn',
			terminalReason: null,
			hasStructuredOutput: false,
			resultLength: 57,
			resultPreview: 'Here is the draft review for you to check before posting.',
		});
		expect(savedPath.startsWith(failedResultsDirectory)).toBe(true);
		expect(readFileSync(savedPath, 'utf8')).toBe(envelope);
	});
});

describe('saveFailedResult', () => {
	it('more than 10 saved results → only the newest 10 are kept', () => {
		const directory = mkdtempSync(join(tmpdir(), 'prb-failed-'));

		for (const now of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((index) => 1_000_000 + index)) {
			saveFailedResult({ directory, kind: 'review', rawEnvelope: '{}', now });
		}

		const kept = readdirSync(directory).sort();

		expect(kept).toHaveLength(10);
		expect(kept[0]).toBe('1000003-review.json');
		expect(kept.at(-1)).toBe('1000012-review.json');
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
			failedResultsDirectory: mkdtempSync(join(tmpdir(), 'prb-failed-')),
			runCommand: fakeRunCommand,
			logger: createSilentLogger(),
			baseEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'secret' },
		});

		const outcome = await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
			model: null,
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

describe('createClaudeClient() model logging', () => {
	const UNKNOWN_MODEL_STREAM = readFileSync(
		new URL('../review/fixtures/claude-stream-unknown-model.ndjson', import.meta.url),
		'utf8',
	);

	it('logs the chosen model on start and the model Claude resolved on finish', async () => {
		const events: { event: string; fields: Record<string, unknown> | undefined }[] = [];

		const record = (event: string, fields?: Record<string, unknown>) => {
			events.push({ event, fields });
		};

		const client = createClaudeClient({
			claudePath: '/bin/claude',
			shimDirectory: '/shims',
			failedResultsDirectory: mkdtempSync(join(tmpdir(), 'prb-failed-')),
			runCommand: async () => ({
				exitCode: 1,
				stdout: UNKNOWN_MODEL_STREAM,
				stderr: '',
				isTimedOut: false,
				durationMs: 1,
			}),
			logger: { ...createSilentLogger(), info: record, warn: record },
			baseEnv: { PATH: '/usr/bin' },
		});

		await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
			model: 'prb-bogus-model',
		});

		expect(events.find(({ event }) => event === 'claude_run_started')?.fields).toMatchObject({
			kind: 'review',
			model: 'prb-bogus-model',
		});
		expect(events.find(({ event }) => event === 'claude_run_finished')?.fields).toMatchObject({
			outcome: 'failed',
			resolvedModel: 'prb-bogus-model',
		});
	});
});

describe('session repair', () => {
	const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
	const INIT_SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

	interface CapturedCall {
		args: string[];
		cwd?: string;
		env?: Record<string, string | undefined>;
		timeoutMs?: number;
	}

	const createClient = (stdout: string, calls: CapturedCall[]) => {
		return createClaudeClient({
			claudePath: '/bin/claude',
			shimDirectory: '/shims',
			failedResultsDirectory: mkdtempSync(join(tmpdir(), 'prb-failed-')),
			runCommand: async ({ args, cwd, env, timeoutMs }) => {
				calls.push({ args, cwd, env, timeoutMs });

				return { exitCode: 0, stdout, stderr: '', isTimedOut: false, durationMs: 1 };
			},
			logger: createSilentLogger(),
			baseEnv: { PATH: '/usr/bin' },
		});
	};

	const valueAfter = (args: string[], flag: string): string | undefined => {
		return args[args.indexOf(flag) + 1];
	};

	const resultLine = (fields: Record<string, unknown>): string => {
		return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields });
	};

	it('readSessionIdFromLine → the session id from a system line only, and only a UUID', () => {
		expect(
			readSessionIdFromLine(`{"type":"system","subtype":"init","session_id":"${SESSION}"}`),
		).toBe(SESSION);
		expect(readSessionIdFromLine(`{"type":"assistant","session_id":"${SESSION}"}`)).toBeNull();
		expect(readSessionIdFromLine('{"type":"system","session_id":"--help"}')).toBeNull();
		expect(readSessionIdFromLine('not json')).toBeNull();
	});

	it('missing result without session_id in the envelope → session taken from the init line', async () => {
		const stdout = [
			`{"type":"system","subtype":"init","session_id":"${INIT_SESSION}"}`,
			resultLine({ result: 'prose only' }),
		].join('\n');
		const client = createClient(stdout, []);

		const outcome = await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
			model: null,
		});

		expect(outcome).toMatchObject({ kind: 'failed', repairSessionId: INIT_SESSION });
	});

	it('both an init line and an envelope session_id → the envelope id, the newest, is used', async () => {
		const stdout = [
			`{"type":"system","subtype":"init","session_id":"${INIT_SESSION}"}`,
			resultLine({ result: 'prose only', session_id: SESSION }),
		].join('\n');
		const client = createClient(stdout, []);

		const outcome = await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
			model: null,
		});

		expect(outcome).toMatchObject({ kind: 'failed', repairSessionId: SESSION });
	});

	it('an envelope session_id that is not a UUID → not used for resuming', async () => {
		const stdout = resultLine({ result: 'prose only', session_id: '--dangerous' });
		const client = createClient(stdout, []);

		const outcome = await client.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/clone',
			model: null,
		});

		expect(outcome).toMatchObject({ kind: 'failed' });
		expect(outcome.kind === 'failed' && outcome.repairSessionId).toBeUndefined();
	});

	it('runRepair → resumes in the given folder with the same schema, system prompt and env as a review', async () => {
		const reviewCalls: CapturedCall[] = [];
		const repairCalls: CapturedCall[] = [];
		const repairStdout = resultLine({
			structured_output: { outcome: 'failed', summary: 'nothing to return' },
		});
		const reviewClient = createClient(resultLine({ result: 'prose only' }), reviewCalls);
		const repairClient = createClient(repairStdout, repairCalls);

		await reviewClient.runReview({
			pullRequestUrl: 'https://github.com/acme/api/pull/7',
			clonePath: '/worktree',
			model: null,
		});

		const outcome = await repairClient.runRepair({
			sessionId: SESSION,
			clonePath: '/worktree',
			model: null,
			attempt: 2,
		});
		const reviewArgs = reviewCalls[0]?.args ?? [];
		const repairArgs = repairCalls[0]?.args ?? [];

		expect(outcome).toEqual({
			kind: 'result',
			result: { outcome: 'failed', summary: 'nothing to return' },
		});
		expect(repairCalls[0]?.cwd).toBe('/worktree');
		expect(repairCalls[0]?.timeoutMs).toBe(180_000);
		expect(valueAfter(repairArgs, '--resume')).toBe(SESSION);
		expect(valueAfter(repairArgs, '-p')).toBe(REPAIR_PROMPT);
		expect(valueAfter(repairArgs, '--json-schema')).toBe(valueAfter(reviewArgs, '--json-schema'));
		expect(valueAfter(repairArgs, '--append-system-prompt')).toBe(
			valueAfter(reviewArgs, '--append-system-prompt'),
		);
		expect(repairCalls[0]?.env).toEqual(reviewCalls[0]?.env);
		expect(repairCalls[0]?.env?.PATH?.startsWith('/shims:')).toBe(true);
		expect(valueAfter(repairArgs, '--disallowedTools')?.split(',')).toEqual([
			'Edit',
			'Write',
			'NotebookEdit',
			'WebFetch',
			'WebSearch',
			'Task',
			'Agent',
			'Skill',
		]);
		expect(repairArgs).not.toContain('--no-session-persistence');
	});
});
