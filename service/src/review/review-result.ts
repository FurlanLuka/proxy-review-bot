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
		filing: { type: 'string', enum: ['approve', 'comment'] },
		headRefOid: stringProperty,
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
	required: ['outcome', 'summary'],
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
});

export type ClaudeRunOutcome<Result> =
	| { kind: 'result'; result: Result }
	| { kind: 'usage_limited'; resumeAt: number }
	| { kind: 'setup_broken'; message: string }
	| { kind: 'failed'; summary: string; schemaIssues?: string[] };

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

const parseEnvelopeLine = (line: string): z.infer<typeof ENVELOPE_SCHEMA> | null => {
	try {
		const parsed = ENVELOPE_SCHEMA.safeParse(JSON.parse(line));

		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

const parseEnvelope = (stdout: string): z.infer<typeof ENVELOPE_SCHEMA> | null => {
	const lines = stdout.trim().split('\n').reverse();

	for (const line of lines) {
		const envelope = parseEnvelopeLine(line);

		if (envelope !== null) {
			return envelope;
		}
	}

	return null;
};

const describeSchemaIssues = (error: z.ZodError): string[] => {
	return error.issues.map((issue) => {
		const path = issue.path.length === 0 ? 'result' : issue.path.join('.');

		return `${path}: ${issue.message}`;
	});
};

const readStructuredOutput = (envelope: z.infer<typeof ENVELOPE_SCHEMA>): unknown => {
	if (envelope.structured_output !== undefined) {
		return envelope.structured_output;
	}

	try {
		return JSON.parse(envelope.result ?? '');
	} catch {
		return undefined;
	}
};

const isJsonLine = (line: string): boolean => {
	try {
		JSON.parse(line);

		return true;
	} catch {
		return false;
	}
};

const buildErrorText = (
	envelope: z.infer<typeof ENVELOPE_SCHEMA> | null,
	output: ClaudeProcessOutput,
): string => {
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
}

export const parseClaudeOutput = <Result>({
	output,
	schema,
	now,
}: ParseClaudeOutputParams<Result>): ClaudeRunOutcome<Result> => {
	if (output.isTimedOut) {
		return { kind: 'failed', summary: 'Claude run timed out' };
	}

	const envelope = parseEnvelope(output.stdout);
	const errorText = buildErrorText(envelope, output);
	const usageLimitedUntil = detectUsageLimit(errorText, now);

	if (usageLimitedUntil !== null) {
		return { kind: 'usage_limited', resumeAt: usageLimitedUntil };
	}

	if (SETUP_BROKEN_PATTERN.test(errorText)) {
		return { kind: 'setup_broken', message: errorText.trim().slice(0, 300) };
	}

	if (envelope === null) {
		return {
			kind: 'failed',
			summary: `Claude exited ${output.exitCode} without a result: ${output.stderr.trim().slice(0, 200)}`,
		};
	}

	if (envelope.is_error || envelope.subtype !== 'success') {
		return { kind: 'failed', summary: `Claude run ended with ${envelope.subtype}` };
	}

	const parsed = schema.safeParse(readStructuredOutput(envelope));

	if (parsed.success) {
		return { kind: 'result', result: parsed.data };
	}

	const schemaIssues = describeSchemaIssues(parsed.error);

	return {
		kind: 'failed',
		summary: `Claude's result had the wrong shape (${schemaIssues.slice(0, 3).join('; ')})`,
		schemaIssues,
	};
};
