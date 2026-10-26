import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { ANCHOR_TIME, makeDraft } from '../test-support/factories.js';
import envelopeFixture from './fixtures/claude-envelope-success.json';
import { parseClaudeOutput, REPLY_RESULT_SCHEMA, REVIEW_RESULT_SCHEMA } from './review-result.js';

const output = (stdout: string, overrides = {}) => ({
	exitCode: 0,
	stdout,
	stderr: '',
	isTimedOut: false,
	...overrides,
});

const parseReview = (stdout: string, overrides = {}) => {
	return parseClaudeOutput({
		output: output(stdout, overrides),
		schema: REVIEW_RESULT_SCHEMA,
		now: ANCHOR_TIME,
	});
};

const envelopeWith = (structuredOutput: unknown, overrides = {}): string => {
	return JSON.stringify({ ...envelopeFixture, structured_output: structuredOutput, ...overrides });
};

describe('parseClaudeOutput', () => {
	it('recorded real envelope → result from structured_output', () => {
		expect(parseReview(JSON.stringify(envelopeFixture))).toEqual({
			kind: 'result',
			result: { outcome: 'nothing_new', summary: 'fixture run', headRefOid: 'abc' },
		});
	});

	it('drafted result parses', () => {
		const result = parseReview(envelopeWith(makeDraft()));

		expect(result.kind).toBe('result');
	});

	it('falls back to the result string when structured_output is absent', () => {
		const { structured_output: _omitted, ...withoutStructured } = envelopeFixture;

		expect(parseReview(JSON.stringify(withoutStructured)).kind).toBe('result');
	});

	it('is_error → failed', () => {
		expect(parseReview(envelopeWith(undefined, { is_error: true })).kind).toBe('failed');
	});

	it('error_max_turns → failed with subtype', () => {
		expect(parseReview(envelopeWith(undefined, { subtype: 'error_max_turns' }))).toEqual({
			kind: 'failed',
			summary: 'Claude run ended with error_max_turns',
		});
	});

	it('drafted without filing → failed (schema mismatch)', () => {
		const { filing: _omitted, ...withoutFiling } = makeDraft();

		expect(parseReview(envelopeWith(withoutFiling)).kind).toBe('failed');
	});

	it('timeout → failed', () => {
		expect(parseReview('', { isTimedOut: true })).toEqual({
			kind: 'failed',
			summary: 'Claude run timed out',
		});
	});

	it('garbage stdout → failed', () => {
		expect(parseReview('not json', { exitCode: 1 }).kind).toBe('failed');
	});

	it('usage limit with an epoch → usage_limited until that time', () => {
		const stdout = JSON.stringify({
			...envelopeFixture,
			is_error: true,
			result: 'Claude AI usage limit reached|1793020000',
		});

		expect(parseReview(stdout)).toEqual({ kind: 'usage_limited', resumeAt: 1793020000 * 1000 });
	});

	it('usage limit without an epoch → paused 30 minutes', () => {
		expect(parseReview('', { stderr: 'Usage limit reached', exitCode: 1 })).toEqual({
			kind: 'usage_limited',
			resumeAt: ANCHOR_TIME + 30 * 60_000,
		});
	});

	it('not logged in → setup_broken', () => {
		expect(parseReview('', { stderr: 'Not logged in · Please run /login', exitCode: 1 }).kind).toBe(
			'setup_broken',
		);
	});

	it('unknown skill → setup_broken', () => {
		const stdout = JSON.stringify({
			...envelopeFixture,
			is_error: true,
			result: 'Unknown skill: proxy:pr-review',
		});

		expect(parseReview(stdout).kind).toBe('setup_broken');
	});

	it('reply schema accepts null', () => {
		const result = parseClaudeOutput({
			output: output(envelopeWith({ reply: null })),
			schema: REPLY_RESULT_SCHEMA,
			now: ANCHOR_TIME,
		});

		expect(result).toEqual({ kind: 'result', result: { reply: null } });
	});
});

describe('parseClaudeOutput on stream-json output', () => {
	it('recorded stream → result from the final result line', () => {
		const stdout = readFileSync(
			new URL('./fixtures/claude-stream-subagents.ndjson', import.meta.url),
			'utf8',
		);

		expect(parseReview(stdout)).toEqual({
			kind: 'result',
			result: { outcome: 'nothing_new', summary: 'stream fixture', headRefOid: 'abc' },
		});
	});

	it('stream cut off before the result line → failed', () => {
		const stdout = readFileSync(
			new URL('./fixtures/claude-stream-subagents.ndjson', import.meta.url),
			'utf8',
		)
			.trim()
			.split('\n')
			.slice(0, -1)
			.join('\n');

		expect(parseReview(stdout, { exitCode: 1 }).kind).toBe('failed');
	});
});

describe('error detection on stream-json output', () => {
	const streamLine = (value: unknown): string => JSON.stringify(value);
	const init = streamLine({ type: 'system', subtype: 'init' });

	it('stream cut off whose tool output mentions a usage limit or login → failed, not paused', () => {
		const toolOutput = streamLine({
			type: 'user',
			message: {
				content: [
					{ type: 'tool_result', content: 'Usage limit reached|1793020000 and Not logged in' },
				],
			},
		});

		expect(parseReview([init, toolOutput].join('\n'), { exitCode: 1 }).kind).toBe('failed');
	});

	it('error result line with a usage limit → usage_limited at that time', () => {
		const result = streamLine({
			...envelopeFixture,
			is_error: true,
			result: 'Claude AI usage limit reached|1793020000',
		});

		expect(parseReview([init, result].join('\n'))).toEqual({
			kind: 'usage_limited',
			resumeAt: 1793020000 * 1000,
		});
	});

	it('error result line with an unknown skill → setup_broken', () => {
		const result = streamLine({
			...envelopeFixture,
			is_error: true,
			result: 'Unknown skill: proxy:pr-review',
		});

		expect(parseReview([init, result].join('\n')).kind).toBe('setup_broken');
	});

	it('successful result whose text mentions a usage limit → still a result', () => {
		const result = streamLine({
			...envelopeFixture,
			result: 'Reviewed the usage limit reached handler',
		});

		expect(parseReview([init, result].join('\n')).kind).toBe('result');
	});

	it('plain stderr from a crash before any output → setup_broken when logged out', () => {
		expect(parseReview('', { exitCode: 1, stderr: 'Not logged in · Please run /login' }).kind).toBe(
			'setup_broken',
		);
	});
});
