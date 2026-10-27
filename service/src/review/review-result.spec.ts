import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { ANCHOR_TIME, makeDraft } from '../test-support/factories.js';
import envelopeFixture from './fixtures/claude-envelope-success.json';
import { REVIEW_SYSTEM_PROMPT } from '../claude/prompts.js';
import {
	extractTrailingJsonObject,
	parseClaudeOutput,
	REPLY_RESULT_SCHEMA,
	REVIEW_RESULT_JSON_SCHEMA,
	REVIEW_RESULT_SCHEMA,
} from './review-result.js';

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

		const outcome = parseReview(envelopeWith(withoutFiling));

		expect(outcome).toMatchObject({
			kind: 'failed',
			schemaIssues: [expect.stringMatching(/^filing: /)],
		});
		expect(outcome.kind === 'failed' && outcome.summary).toStartWith(
			"Claude's result had the wrong shape (filing: ",
		);
	});

	it('an inline line that is not a whole number → failed, not coerced', () => {
		const draftWithLine = (line: unknown) => {
			return envelopeWith({
				...makeDraft(),
				comments: [{ path: 'a.ts', line, side: 'RIGHT', body: 'x' }],
			});
		};

		expect(parseReview(draftWithLine(true)).kind).toBe('failed');
		expect(parseReview(draftWithLine('12a')).kind).toBe('failed');
		expect(parseReview(draftWithLine([12])).kind).toBe('failed');
	});

	it('drafted with only the essential fields → defaults for the rest, line numbers coerced', () => {
		const outcome = parseReview(
			envelopeWith({
				outcome: 'drafted',
				filing: 'comment',
				headRefOid: 'head-1',
				summary: 'Backoff missing',
				comments: [{ path: 'a.ts', line: '12', body: 'Add a backoff' }],
			}),
		);

		expect(outcome).toEqual({
			kind: 'result',
			result: {
				outcome: 'drafted',
				filing: 'comment',
				headRefOid: 'head-1',
				baseRefName: '',
				targetTipOid: '',
				summary: 'Backoff missing',
				mainReview: '',
				comments: [{ path: 'a.ts', line: 12, side: 'RIGHT', body: 'Add a backoff' }],
				fileComments: [],
				coverage: '',
			},
		});
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

describe('what the bot asks Claude for', () => {
	it('the JSON schema always asks for filing and headRefOid, which a drafted review needs; the prompt lists required fields per outcome', () => {
		const commentItems = REVIEW_RESULT_JSON_SCHEMA.properties.comments.items;

		expect(commentItems.required).toEqual(['path', 'line', 'body']);
		expect(REVIEW_RESULT_JSON_SCHEMA.required).toEqual([
			'outcome',
			'summary',
			'filing',
			'headRefOid',
		]);
		expect(REVIEW_SYSTEM_PROMPT).toContain('"drafted": outcome, filing, headRefOid, summary.');
		expect(
			parseReview(
				envelopeWith({
					outcome: 'drafted',
					filing: 'comment',
					headRefOid: 'h',
					summary: 's',
					comments: [{ path: 'a.ts', line: 3, body: 'x' }],
				}),
			),
		).toMatchObject({ kind: 'result', result: { comments: [{ side: 'RIGHT' }] } });
	});

	it('every outcome still parses with the always-required filing and headRefOid filled in', () => {
		const alwaysRequired = { filing: 'comment', headRefOid: 'h' };

		expect(
			parseReview(
				envelopeWith({ outcome: 'blocked', reason: 'other', summary: 's', ...alwaysRequired }),
			).kind,
		).toBe('result');
		expect(
			parseReview(envelopeWith({ outcome: 'failed', summary: 's', ...alwaysRequired })).kind,
		).toBe('result');
		expect(
			parseReview(envelopeWith({ outcome: 'nothing_new', summary: 's', ...alwaysRequired })).kind,
		).toBe('result');
	});

	const MINIMAL_RESULTS: Record<string, Record<string, unknown>> = {
		drafted: { outcome: 'drafted', filing: 'comment', headRefOid: 'h', summary: 's' },
		nothing_new: { outcome: 'nothing_new', headRefOid: 'h', summary: 's' },
		blocked: { outcome: 'blocked', reason: 'other', summary: 's' },
		failed: { outcome: 'failed', summary: 's' },
	};

	for (const [outcome, minimal] of Object.entries(MINIMAL_RESULTS)) {
		it(`"${outcome}" with exactly the prompt's required fields → parsed; drop any one → thrown away`, () => {
			const requiredFields = Object.keys(minimal);

			expect(REVIEW_SYSTEM_PROMPT).toContain(`"${outcome}": ${requiredFields.join(', ')}.`);
			expect(parseReview(envelopeWith(minimal)).kind).toBe('result');

			for (const field of requiredFields) {
				const { [field]: _dropped, ...withoutField } = minimal;

				expect(parseReview(envelopeWith(withoutField)).kind).toBe('failed');
			}
		});
	}
});

describe('extractTrailingJsonObject', () => {
	it('an object that ends the text → that object', () => {
		expect(extractTrailingJsonObject('Here is the result: {"outcome":"drafted","a":1}\n')).toEqual({
			outcome: 'drafted',
			a: 1,
		});
	});

	it('a fenced block that ends the text → its object', () => {
		expect(extractTrailingJsonObject('Done.\n```json\n{"outcome":"nothing_new"}\n```\n')).toEqual({
			outcome: 'nothing_new',
		});
	});

	it('an earlier ```json example followed by prose → rejected', () => {
		const text = 'Example:\n```json\n{"outcome":"drafted"}\n```\nI showed the draft above.';

		expect(extractTrailingJsonObject(text)).toBeUndefined();
	});

	it('a stray brace in prose → rejected', () => {
		expect(
			extractTrailingJsonObject('Use {braces} carefully, the review is above.'),
		).toBeUndefined();
		expect(extractTrailingJsonObject('The map looks like {a: 1}')).toBeUndefined();
	});

	it('a stray brace earlier in the prose, then a valid trailing object → that object', () => {
		const text = 'Use the `{` key to open a block.\n```json\n{"outcome":"drafted","a":1}\n```';

		expect(extractTrailingJsonObject(text)).toEqual({ outcome: 'drafted', a: 1 });
	});

	it('an unbalanced quote earlier in the prose, then a valid trailing object → that object', () => {
		const text = 'The flag is "--force and it breaks.\n{"outcome":"nothing_new","b":2}';

		expect(extractTrailingJsonObject(text)).toEqual({ outcome: 'nothing_new', b: 2 });
	});

	it('quotes and braces inside strings are handled', () => {
		expect(extractTrailingJsonObject('x {"outcome":"drafted","note":"a } and \\" here"}')).toEqual({
			outcome: 'drafted',
			note: 'a } and " here',
		});
	});

	it('a trailing blocked or failed outcome → rejected (never accepted via the fallback)', () => {
		expect(
			extractTrailingJsonObject('e.g. {"outcome":"blocked","reason":"other","summary":"x"}'),
		).toBeUndefined();
		expect(extractTrailingJsonObject('{"outcome":"failed","summary":"x"}')).toBeUndefined();
	});
});

describe('parseClaudeOutput without structured_output', () => {
	const textEnvelope = (result: string): string => {
		return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result });
	};

	const parseWithFallback = (stdout: string) => {
		return parseClaudeOutput({
			output: output(stdout),
			schema: REVIEW_RESULT_SCHEMA,
			now: ANCHOR_TIME,
			allowTextFallback: true,
		});
	};

	it('a review whose result JSON ends the chat reply → parsed and marked recovered', () => {
		const draft = makeDraft();
		const result = `Here is my review.\n\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``;

		expect(parseWithFallback(textEnvelope(result))).toEqual({
			kind: 'result',
			result: draft,
			isRecovered: true,
		});
	});

	it('the same text without the fallback (replies) → failed', () => {
		const result = `Here is my review.\n${JSON.stringify(makeDraft())}`;

		expect(parseReview(textEnvelope(result)).kind).toBe('failed');
	});

	it('a trailing object that fails the schema → failed', () => {
		expect(parseWithFallback(textEnvelope('Result: {"outcome":"drafted"}')).kind).toBe('failed');
	});

	const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
	const STOP_CASES: [string, ReturnType<typeof output>][] = [
		[
			'"No conversation found" on stderr, no envelope',
			output('', { exitCode: 1, stderr: `No conversation found with session ID: ${SESSION}` }),
		],
		[
			'an is_error envelope that carries a session_id',
			output(
				JSON.stringify({
					type: 'result',
					subtype: 'success',
					is_error: true,
					result: 'API Error: 500',
					session_id: SESSION,
				}),
			),
		],
		['a timed-out run', output('', { isTimedOut: true })],
		[
			'a non-success subtype',
			output(
				JSON.stringify({
					type: 'result',
					subtype: 'error_max_turns',
					is_error: false,
					session_id: SESSION,
				}),
			),
		],
	];

	for (const [name, stopOutput] of STOP_CASES) {
		it(`${name} → failed with no schema issues and no session, so a repair is not retried`, () => {
			const outcome = parseClaudeOutput({
				output: stopOutput,
				schema: REVIEW_RESULT_SCHEMA,
				now: ANCHOR_TIME,
				allowTextFallback: true,
			});

			expect(outcome.kind).toBe('failed');
			expect(outcome).not.toHaveProperty('schemaIssues');
			expect(outcome).not.toHaveProperty('repairSessionId');
		});
	}

	it('only prose → failed with diagnostics and the raw envelope kept', () => {
		const envelope = textEnvelope('I showed the draft above.');

		expect(parseWithFallback(envelope)).toMatchObject({
			kind: 'failed',
			schemaIssues: ['result: Required'],
			diagnostics: {
				subtype: 'success',
				hasStructuredOutput: false,
				resultLength: 25,
				resultPreview: 'I showed the draft above.',
			},
			rawEnvelope: envelope,
		});
	});
});
