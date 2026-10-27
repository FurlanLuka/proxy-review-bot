import { z } from 'zod';

const INLINE_COMMENT_SCHEMA = z.object({
	path: z.string().min(1),
	line: z
		.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
		.pipe(z.number().int().positive()),
	side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
	body: z.string().min(1),
});

const FILE_COMMENT_SCHEMA = z.object({
	path: z.string().min(1),
	body: z.string().min(1),
});

export const REVIEW_RESULT_SCHEMA = z.discriminatedUnion('outcome', [
	z.object({
		outcome: z.literal('drafted'),
		filing: z.enum(['approve', 'comment']),
		headRefOid: z.string().min(1),
		baseRefName: z.string().default(''),
		targetTipOid: z.string().default(''),
		summary: z.string().min(1),
		mainReview: z.string().default(''),
		comments: z.array(INLINE_COMMENT_SCHEMA).default([]),
		fileComments: z.array(FILE_COMMENT_SCHEMA).default([]),
		coverage: z.string().default(''),
	}),
	z.object({
		outcome: z.literal('nothing_new'),
		headRefOid: z.string().min(1),
		summary: z.string().min(1),
	}),
	z.object({
		outcome: z.literal('blocked'),
		reason: z.enum(['snapshot_unstable', 'diff_mismatch', 'missing_access', 'other']),
		summary: z.string().min(1),
	}),
	z.object({
		outcome: z.literal('failed'),
		summary: z.string().min(1),
	}),
]);

export type ReviewResult = z.infer<typeof REVIEW_RESULT_SCHEMA>;

export type DraftedReviewResult = Extract<ReviewResult, { outcome: 'drafted' }>;

export const REPLY_RESULT_SCHEMA = z.object({
	reply: z.string().min(1).nullable(),
});

export type ReplyResult = z.infer<typeof REPLY_RESULT_SCHEMA>;

const stringProperty = { type: 'string' };

export const REVIEW_RESULT_JSON_SCHEMA = {
	type: 'object',
	properties: {
		outcome: { type: 'string', enum: ['drafted', 'nothing_new', 'blocked', 'failed'] },
		filing: {
			type: 'string',
			enum: ['approve', 'comment'],
			description: 'The filing for a drafted review. Use "comment" for any other outcome.',
		},
		headRefOid: {
			type: 'string',
			description: 'The PR head commit you reviewed. Always fill it in.',
		},
		baseRefName: stringProperty,
		targetTipOid: stringProperty,
		summary: stringProperty,
		mainReview: stringProperty,
		comments: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					path: stringProperty,
					line: { type: 'integer' },
					side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
					body: stringProperty,
				},
				required: ['path', 'line', 'body'],
			},
		},
		fileComments: {
			type: 'array',
			items: {
				type: 'object',
				properties: { path: stringProperty, body: stringProperty },
				required: ['path', 'body'],
			},
		},
		coverage: stringProperty,
		reason: {
			type: 'string',
			enum: ['snapshot_unstable', 'diff_mismatch', 'missing_access', 'other'],
		},
	},
	required: ['outcome', 'summary', 'filing', 'headRefOid'],
};

export const REPLY_RESULT_JSON_SCHEMA = {
	type: 'object',
	properties: { reply: { type: ['string', 'null'] } },
	required: ['reply'],
};

const ENVELOPE_SCHEMA = z.object({
	type: z.literal('result'),
	subtype: z.string(),
	is_error: z.boolean(),
	result: z.string().optional(),
	structured_output: z.unknown().optional(),
	num_turns: z.number().optional(),
	stop_reason: z.string().nullable().optional(),
	terminal_reason: z.string().nullable().optional(),
	session_id: z.string().optional(),
});

type ClaudeEnvelope = z.infer<typeof ENVELOPE_SCHEMA>;

const RESULT_PREVIEW_LENGTH = 500;

export interface ResultDiagnostics {
	subtype: string;
	numTurns: number | null;
	stopReason: string | null;
	terminalReason: string | null;
	hasStructuredOutput: boolean;
	resultLength: number;
	resultPreview: string;
}

export type ClaudeRunOutcome<Result> =
	| { kind: 'result'; result: Result; isRecovered?: boolean }
	| { kind: 'usage_limited'; resumeAt: number }
	| { kind: 'setup_broken'; message: string }
	| {
			kind: 'failed';
			summary: string;
			schemaIssues?: string[];
			diagnostics?: ResultDiagnostics;
			rawEnvelope?: string;
			repairSessionId?: string;
	  };

export interface ClaudeProcessOutput {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	isTimedOut: boolean;
}

const USAGE_LIMIT_PATTERN = /usage limit reached\|?(\d{10,13})?/i;
const SETUP_BROKEN_PATTERN =
	/(not logged in|please run \/login|invalid api key|unknown (skill|command|slash command))/i;
const DEFAULT_USAGE_PAUSE_MS = 30 * 60_000;

const detectUsageLimit = (text: string, now: number): number | null => {
	const match = USAGE_LIMIT_PATTERN.exec(text);

	if (match === null) {
		return null;
	}

	const rawTimestamp = match[1];

	if (rawTimestamp === undefined) {
		return now + DEFAULT_USAGE_PAUSE_MS;
	}

	const timestamp = Number(rawTimestamp);

	return rawTimestamp.length === 10 ? timestamp * 1000 : timestamp;
};

interface ParsedEnvelope {
	envelope: ClaudeEnvelope;
	line: string;
}

const parseEnvelopeLine = (line: string): ClaudeEnvelope | null => {
	try {
		const parsed = ENVELOPE_SCHEMA.safeParse(JSON.parse(line));

		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

const parseEnvelope = (stdout: string): ParsedEnvelope | null => {
	const lines = stdout.trim().split('\n').reverse();

	for (const line of lines) {
		const envelope = parseEnvelopeLine(line);

		if (envelope !== null) {
			return { envelope, line };
		}
	}

	return null;
};

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSessionId = (value: unknown): value is string => {
	return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
};

export const readSessionIdFromLine = (line: string): string | null => {
	try {
		const event = JSON.parse(line) as { type?: unknown; session_id?: unknown };

		return event.type === 'system' && isSessionId(event.session_id) ? event.session_id : null;
	} catch {
		return null;
	}
};

const findSessionId = (stdout: string): string | undefined => {
	for (const line of stdout.split('\n')) {
		const sessionId = readSessionIdFromLine(line);

		if (sessionId !== null) {
			return sessionId;
		}
	}

	return undefined;
};

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const TRAILING_AFTER_OBJECT = /^\s*(```)?\s*$/;
const FALLBACK_REJECTED_OUTCOMES = new Set(['blocked', 'failed']);

const parseObjectEndingAt = (text: string, end: number): object | undefined => {
	for (
		let start = text.indexOf('{');
		start !== -1 && start < end;
		start = text.indexOf('{', start + 1)
	) {
		const parsed = parseJson(text.slice(start, end));

		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed;
		}
	}

	return undefined;
};

export const extractTrailingJsonObject = (text: string): unknown => {
	const lastBrace = text.lastIndexOf('}');

	if (lastBrace === -1 || !TRAILING_AFTER_OBJECT.test(text.slice(lastBrace + 1))) {
		return undefined;
	}

	const parsed = parseObjectEndingAt(text, lastBrace + 1);

	if (parsed === undefined) {
		return undefined;
	}

	const outcome = (parsed as { outcome?: unknown }).outcome;

	return typeof outcome === 'string' && FALLBACK_REJECTED_OUTCOMES.has(outcome)
		? undefined
		: parsed;
};

const buildDiagnostics = (envelope: ClaudeEnvelope): ResultDiagnostics => {
	const resultText = envelope.result ?? '';

	return {
		subtype: envelope.subtype,
		numTurns: envelope.num_turns ?? null,
		stopReason: envelope.stop_reason ?? null,
		terminalReason: envelope.terminal_reason ?? null,
		hasStructuredOutput: envelope.structured_output !== undefined,
		resultLength: resultText.length,
		resultPreview: resultText.slice(0, RESULT_PREVIEW_LENGTH),
	};
};

const describeSchemaIssues = (error: z.ZodError): string[] => {
	return error.issues.map((issue) => {
		const path = issue.path.length === 0 ? 'result' : issue.path.join('.');

		return `${path}: ${issue.message}`;
	});
};

interface StructuredOutputRead {
	value: unknown;
	isFromTextFallback: boolean;
}

const readStructuredOutput = (
	envelope: ClaudeEnvelope,
	allowTextFallback: boolean,
): StructuredOutputRead => {
	if (envelope.structured_output !== undefined) {
		return { value: envelope.structured_output, isFromTextFallback: false };
	}

	const resultText = envelope.result ?? '';
	const exact = parseJson(resultText);

	if (exact !== undefined || !allowTextFallback) {
		return { value: exact, isFromTextFallback: false };
	}

	const fallback = extractTrailingJsonObject(resultText);

	return { value: fallback, isFromTextFallback: fallback !== undefined };
};

const isJsonLine = (line: string): boolean => {
	try {
		JSON.parse(line);

		return true;
	} catch {
		return false;
	}
};

const buildErrorText = (envelope: ClaudeEnvelope | null, output: ClaudeProcessOutput): string => {
	if (envelope !== null) {
		return envelope.is_error ? `${envelope.result ?? ''}\n${output.stderr}` : '';
	}

	const plainStdoutLines = output.stdout.split('\n').filter((line) => !isJsonLine(line));

	return [...plainStdoutLines, output.stderr].join('\n');
};

interface ParseClaudeOutputParams<Result> {
	output: ClaudeProcessOutput;
	schema: z.ZodType<Result, z.ZodTypeDef, unknown>;
	now: number;
	allowTextFallback?: boolean;
}

export const parseClaudeOutput = <Result>({
	output,
	schema,
	now,
	allowTextFallback = false,
}: ParseClaudeOutputParams<Result>): ClaudeRunOutcome<Result> => {
	if (output.isTimedOut) {
		return { kind: 'failed', summary: 'Claude run timed out' };
	}

	const parsedEnvelope = parseEnvelope(output.stdout);
	const errorText = buildErrorText(parsedEnvelope?.envelope ?? null, output);
	const usageLimitedUntil = detectUsageLimit(errorText, now);

	if (usageLimitedUntil !== null) {
		return { kind: 'usage_limited', resumeAt: usageLimitedUntil };
	}

	if (SETUP_BROKEN_PATTERN.test(errorText)) {
		return { kind: 'setup_broken', message: errorText.trim().slice(0, 300) };
	}

	if (parsedEnvelope === null) {
		return {
			kind: 'failed',
			summary: `Claude exited ${output.exitCode} without a result: ${output.stderr.trim().slice(0, 200)}`,
		};
	}

	const { envelope, line } = parsedEnvelope;

	if (envelope.is_error || envelope.subtype !== 'success') {
		return { kind: 'failed', summary: `Claude run ended with ${envelope.subtype}` };
	}

	const structuredOutput = readStructuredOutput(envelope, allowTextFallback);
	const parsed = schema.safeParse(structuredOutput.value);

	if (parsed.success) {
		return structuredOutput.isFromTextFallback
			? { kind: 'result', result: parsed.data, isRecovered: true }
			: { kind: 'result', result: parsed.data };
	}

	const schemaIssues = describeSchemaIssues(parsed.error);

	return {
		kind: 'failed',
		summary: `Claude's result had the wrong shape (${schemaIssues.slice(0, 3).join('; ')})`,
		schemaIssues,
		diagnostics: buildDiagnostics(envelope),
		rawEnvelope: line,
		repairSessionId: isSessionId(envelope.session_id)
			? envelope.session_id
			: findSessionId(output.stdout),
	};
};
