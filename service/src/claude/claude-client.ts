import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCommand } from '../commands/run-command.js';
import type { Logger } from '../logging/logger.js';
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

export const createClaudeClient = ({
	claudePath,
	shimDirectory,
	runCommand,
	logger,
	baseEnv,
}: CreateClaudeClientParams): ClaudeClient => {
	const runClaude = async <Result>(
		kind: ClaudeJobKind,
		args: string[],
		clonePath: string,
		parse: (output: Awaited<ReturnType<RunCommand>>) => ClaudeRunOutcome<Result>,
	): Promise<ClaudeRunOutcome<Result>> => {
		logger.info('claude_run_started', { kind, clonePath });
		const output = await runCommand({
			command: 'caffeinate',
			args: ['-i', claudePath, ...args],
			cwd: clonePath,
			env: buildClaudeEnv({ baseEnv, shimDirectory }),
			timeoutMs: kind === 'review' ? REVIEW_TIMEOUT_MS : REPLY_TIMEOUT_MS,
		});
		const outcome = parse(output);

		logger.info('claude_run_finished', {
			kind,
			exitCode: output.exitCode,
			isTimedOut: output.isTimedOut,
			durationMs: output.durationMs,
			outcome: outcome.kind,
		});

		return outcome;
	};

	return {
		runReview: ({ pullRequestUrl, clonePath }) => {
			const args = buildClaudeArgs({
				kind: 'review',
				prompt: buildReviewPrompt(pullRequestUrl),
				systemPrompt: REVIEW_SYSTEM_PROMPT,
				jsonSchema: REVIEW_RESULT_JSON_SCHEMA,
			});

			return runClaude('review', args, clonePath, (output) =>
				parseClaudeOutput({ output, schema: REVIEW_RESULT_SCHEMA, now: Date.now() }),
			);
		},
		runReply: ({ prompt, clonePath }) => {
			const args = buildClaudeArgs({
				kind: 'reply',
				prompt,
				systemPrompt: REPLY_SYSTEM_PROMPT,
				jsonSchema: REPLY_RESULT_JSON_SCHEMA,
			});

			return runClaude('reply', args, clonePath, (output) =>
				parseClaudeOutput({ output, schema: REPLY_RESULT_SCHEMA, now: Date.now() }),
			);
		},
	};
};
