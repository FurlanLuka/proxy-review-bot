import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult, RunCommand } from '../commands/run-command.js';
import type { Logger } from '../logging/logger.js';
import { applyStreamLine, createReviewProgress } from '../review/review-progress.js';
import type { ReviewProgress } from '../review/review-progress.js';
import {
	parseClaudeOutput,
	REPLY_RESULT_JSON_SCHEMA,
	REPLY_RESULT_SCHEMA,
	REVIEW_RESULT_JSON_SCHEMA,
	REVIEW_RESULT_SCHEMA,
} from '../review/review-result.js';
import type { ClaudeRunOutcome, ReplyResult, ReviewResult } from '../review/review-result.js';
import { buildClaudeArgs, buildClaudeEnv } from './claude-args.js';
import type { ClaudeJobKind } from './claude-args.js';
import { buildShimScript } from './command-shim.js';
import {
	buildReviewPrompt,
	REPAIR_PROMPT,
	REPLY_SYSTEM_PROMPT,
	REVIEW_SYSTEM_PROMPT,
} from './prompts.js';

const REVIEW_TIMEOUT_MS = 30 * 60_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;
const REPAIR_TIMEOUT_MS = 3 * 60_000;
const KEPT_FAILED_RESULTS = 10;

interface RunReviewParams {
	pullRequestUrl: string;
	clonePath: string;
	onProgress?: (progress: ReviewProgress) => void;
	signal?: AbortSignal;
}

interface RunReplyParams {
	prompt: string;
	clonePath: string;
}

export interface RunRepairParams {
	sessionId: string;
	clonePath: string;
	attempt: number;
	signal?: AbortSignal;
}

export interface ClaudeClient {
	runReview(params: RunReviewParams): Promise<ClaudeRunOutcome<ReviewResult>>;
	runRepair(params: RunRepairParams): Promise<ClaudeRunOutcome<ReviewResult>>;
	runReply(params: RunReplyParams): Promise<ClaudeRunOutcome<ReplyResult>>;
}

type ClaudeRunKind = ClaudeJobKind | 'repair';

const TIMEOUT_BY_KIND: Record<ClaudeRunKind, number> = {
	review: REVIEW_TIMEOUT_MS,
	reply: REPLY_TIMEOUT_MS,
	repair: REPAIR_TIMEOUT_MS,
};

interface InstallCommandShimsParams {
	shimDirectory: string;
	shimCommand: string[];
	realGhPath: string;
	realGitPath: string;
}

export const installCommandShims = ({
	shimDirectory,
	shimCommand,
	realGhPath,
	realGitPath,
}: InstallCommandShimsParams): void => {
	mkdirSync(shimDirectory, { recursive: true });

	for (const [toolName, realPath] of [
		['gh', realGhPath],
		['git', realGitPath],
	] as const) {
		const shimPath = join(shimDirectory, toolName);

		writeFileSync(
			shimPath,
			buildShimScript({ shimCommand, toolName, realPath, safeDirectory: shimDirectory }),
		);
		chmodSync(shimPath, 0o755);
	}
};

interface SaveFailedResultParams {
	directory: string;
	kind: ClaudeRunKind;
	rawEnvelope: string;
	now: number;
}

export const saveFailedResult = ({
	directory,
	kind,
	rawEnvelope,
	now,
}: SaveFailedResultParams): string => {
	mkdirSync(directory, { recursive: true });

	const filePath = join(directory, `${now}-${kind}.json`);

	writeFileSync(filePath, rawEnvelope);

	const staleFiles = readdirSync(directory)
		.filter((name) => name.endsWith('.json'))
		.sort()
		.reverse()
		.slice(KEPT_FAILED_RESULTS);

	for (const name of staleFiles) {
		rmSync(join(directory, name), { force: true });
	}

	return filePath;
};

interface CreateClaudeClientParams {
	claudePath: string;
	shimDirectory: string;
	failedResultsDirectory: string;
	runCommand: RunCommand;
	logger: Logger;
	baseEnv: Record<string, string | undefined>;
}

interface RunClaudeParams<Result> {
	kind: ClaudeRunKind;
	args: string[];
	clonePath: string;
	parse: (output: CommandResult) => ClaudeRunOutcome<Result>;
	onStdoutLine?: (line: string) => void;
	signal?: AbortSignal;
}

export const createClaudeClient = ({
	claudePath,
	shimDirectory,
	failedResultsDirectory,
	runCommand,
	logger,
	baseEnv,
}: CreateClaudeClientParams): ClaudeClient => {
	const keepFailedResult = (
		kind: ClaudeRunKind,
		rawEnvelope: string | undefined,
	): string | null => {
		if (rawEnvelope === undefined) {
			return null;
		}

		try {
			return saveFailedResult({
				directory: failedResultsDirectory,
				kind,
				rawEnvelope,
				now: Date.now(),
			});
		} catch (error) {
			logger.error('failed_result_save_failed', { kind, error });

			return null;
		}
	};

	const runClaude = async <Result>({
		kind,
		args,
		clonePath,
		parse,
		onStdoutLine,
		signal,
	}: RunClaudeParams<Result>): Promise<ClaudeRunOutcome<Result>> => {
		logger.info('claude_run_started', { kind, clonePath });
		const output = await runCommand({
			command: 'caffeinate',
			args: ['-i', claudePath, ...args],
			cwd: clonePath,
			env: buildClaudeEnv({ baseEnv, shimDirectory }),
			timeoutMs: TIMEOUT_BY_KIND[kind],
			onStdoutLine,
			signal,
		});
		const outcome = parse(output);

		const fields = {
			kind,
			exitCode: output.exitCode,
			isTimedOut: output.isTimedOut,
			isAborted: signal?.aborted ?? false,
			durationMs: output.durationMs,
			outcome: outcome.kind,
		};

		if (outcome.kind === 'failed') {
			const failedResultPath = keepFailedResult(kind, outcome.rawEnvelope);

			logger.warn('claude_run_finished', {
				...fields,
				summary: outcome.summary,
				schemaIssues: outcome.schemaIssues,
				diagnostics: outcome.diagnostics,
				failedResultPath,
			});
		} else {
			logger.info('claude_run_finished', fields);
		}

		return outcome;
	};

	return {
		runReview: ({ pullRequestUrl, clonePath, onProgress, signal }) => {
			const args = buildClaudeArgs({
				kind: 'review',
				prompt: buildReviewPrompt(pullRequestUrl),
				systemPrompt: REVIEW_SYSTEM_PROMPT,
				jsonSchema: REVIEW_RESULT_JSON_SCHEMA,
			});
			const progress = { current: createReviewProgress(Date.now(), 'Starting the review') };
			onProgress?.(progress.current);

			return runClaude({
				kind: 'review',
				args,
				clonePath,
				signal,
				parse: (output) =>
					parseClaudeOutput({
						output,
						schema: REVIEW_RESULT_SCHEMA,
						now: Date.now(),
						allowTextFallback: true,
					}),
				onStdoutLine: (line) => {
					const next = applyStreamLine(progress.current, line, Date.now());

					if (next !== progress.current) {
						progress.current = next;
						onProgress?.(next);
					}
				},
			});
		},
		runRepair: ({ sessionId, clonePath, attempt, signal }) => {
			logger.info('claude_repair_run', { sessionId, attempt });

			return runClaude({
				kind: 'repair',
				args: buildClaudeArgs({
					kind: 'review',
					prompt: REPAIR_PROMPT,
					systemPrompt: REVIEW_SYSTEM_PROMPT,
					jsonSchema: REVIEW_RESULT_JSON_SCHEMA,
					resumeSessionId: sessionId,
				}),
				clonePath,
				signal,
				parse: (output) =>
					parseClaudeOutput({
						output,
						schema: REVIEW_RESULT_SCHEMA,
						now: Date.now(),
						allowTextFallback: true,
					}),
			});
		},
		runReply: ({ prompt, clonePath }) => {
			const args = buildClaudeArgs({
				kind: 'reply',
				prompt,
				systemPrompt: REPLY_SYSTEM_PROMPT,
				jsonSchema: REPLY_RESULT_JSON_SCHEMA,
			});

			return runClaude({
				kind: 'reply',
				args,
				clonePath,
				parse: (output) =>
					parseClaudeOutput({ output, schema: REPLY_RESULT_SCHEMA, now: Date.now() }),
			});
		},
	};
};
