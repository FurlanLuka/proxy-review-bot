import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { buildReviewPrompt, REPLY_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT } from './prompts.js';

const REVIEW_TIMEOUT_MS = 30 * 60_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;

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

export interface ClaudeClient {
	runReview(params: RunReviewParams): Promise<ClaudeRunOutcome<ReviewResult>>;
	runReply(params: RunReplyParams): Promise<ClaudeRunOutcome<ReplyResult>>;
}

interface InstallCommandShimsParams {
	shimDirectory: string;
	bunPath: string;
	shimScriptPath: string;
	realGhPath: string;
	realGitPath: string;
}

export const installCommandShims = ({
	shimDirectory,
	bunPath,
	shimScriptPath,
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
			`#!/bin/sh\nexec "${bunPath}" "${shimScriptPath}" ${toolName} "${realPath}" "$@"\n`,
		);
		chmodSync(shimPath, 0o755);
	}
};

interface CreateClaudeClientParams {
	claudePath: string;
	shimDirectory: string;
	runCommand: RunCommand;
	logger: Logger;
	baseEnv: Record<string, string | undefined>;
}

interface RunClaudeParams<Result> {
	kind: ClaudeJobKind;
	args: string[];
	clonePath: string;
	parse: (output: CommandResult) => ClaudeRunOutcome<Result>;
	onStdoutLine?: (line: string) => void;
	signal?: AbortSignal;
}

export const createClaudeClient = ({
	claudePath,
	shimDirectory,
	runCommand,
	logger,
	baseEnv,
}: CreateClaudeClientParams): ClaudeClient => {
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
			timeoutMs: kind === 'review' ? REVIEW_TIMEOUT_MS : REPLY_TIMEOUT_MS,
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
			logger.warn('claude_run_finished', {
				...fields,
				summary: outcome.summary,
				schemaIssues: outcome.schemaIssues,
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
					parseClaudeOutput({ output, schema: REVIEW_RESULT_SCHEMA, now: Date.now() }),
				onStdoutLine: (line) => {
					const next = applyStreamLine(progress.current, line, Date.now());

					if (next !== progress.current) {
						progress.current = next;
						onProgress?.(next);
					}
				},
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
