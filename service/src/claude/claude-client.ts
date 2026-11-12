import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult, RunCommand } from '../commands/run-command.js';
import type { Logger } from '../logging/logger.js';
import { applyStreamLine, createReviewProgress } from '../review/review-progress.js';
import type { ReviewProgress } from '../review/review-progress.js';
import {
	parseClaudeOutput,
	readSessionIdFromLine,
	resolvedModelOf,
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
	withReviewInstructions,
} from './prompts.js';

const REVIEW_TIMEOUT_MS = 30 * 60_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;
const REPAIR_TIMEOUT_MS = 3 * 60_000;
const KEPT_FAILED_RESULTS = 10;
const HEARTBEAT_INTERVAL_MS = 2 * 60_000;
/** Silence this long reads as stalled: well under the 30-min timeout, past long tool calls */
export const STALL_AFTER_MS = 10 * 60_000;
// Activity reaches the card at most this often; a 10-min threshold needs no finer grain
const ACTIVITY_REFRESH_MS = 30_000;

interface RunReviewParams {
	pullRequestUrl: string;
	clonePath: string;
	model: string | null;
	/** The developer's own review instructions, "" when off */
	instructions: string;
	onProgress?: (progress: ReviewProgress) => void;
	signal?: AbortSignal;
	/** The job's logger, so run lines carry the PR they belong to */
	logger?: Logger;
}

interface RunReplyParams {
	prompt: string;
	clonePath: string;
	model: string | null;
	instructions: string;
}

export interface RunRepairParams {
	sessionId: string;
	clonePath: string;
	model: string | null;
	instructions: string;
	attempt: number;
	signal?: AbortSignal;
	logger?: Logger;
	/** Called as Claude prints lines, at most every 30 s */
	onActivity?: (at: number) => void;
	/** The card's progress, so repair heartbeats say which phase was being repaired */
	getProgress?: () => ReviewProgress;
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
	now?: () => number;
	heartbeatIntervalMs?: number;
	stallAfterMs?: number;
}

interface RunClaudeParams<Result> {
	kind: ClaudeRunKind;
	model: string | null;
	hasReviewInstructions: boolean;
	args: string[];
	clonePath: string;
	parse: (output: CommandResult) => ClaudeRunOutcome<Result>;
	onStdoutLine?: (line: string) => void;
	signal?: AbortSignal;
	runLogger?: Logger;
	getProgress?: () => ReviewProgress;
}

interface RunActivity {
	sessionId: string | null;
	lastActivityAt: number;
	hasStalled: boolean;
}

const runningAdvisorsOf = (progress: ReviewProgress | undefined): string[] => {
	return (progress?.subagents ?? [])
		.filter((subagent) => subagent.status === 'running')
		.map((subagent) => subagent.label);
};

interface ActivityThrottle {
	reportedAt: number;
}

const isActivityDue = (throttle: ActivityThrottle, at: number): boolean => {
	return at - throttle.reportedAt >= ACTIVITY_REFRESH_MS;
};

export const createClaudeClient = ({
	claudePath,
	shimDirectory,
	failedResultsDirectory,
	runCommand,
	logger,
	baseEnv,
	now = Date.now,
	heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
	stallAfterMs = STALL_AFTER_MS,
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
				now: now(),
			});
		} catch (error) {
			logger.error('failed_result_save_failed', { kind, error });

			return null;
		}
	};

	const runClaude = async <Result>({
		kind,
		model,
		hasReviewInstructions,
		args,
		clonePath,
		parse,
		onStdoutLine,
		signal,
		runLogger = logger,
		getProgress,
	}: RunClaudeParams<Result>): Promise<ClaudeRunOutcome<Result>> => {
		const startedAt = now();
		const activity: RunActivity = { sessionId: null, lastActivityAt: startedAt, hasStalled: false };

		const logHeartbeat = (): void => {
			const progress = getProgress?.();
			const idleMs = now() - activity.lastActivityAt;

			runLogger.info('claude_run_progress', {
				kind,
				sessionId: activity.sessionId,
				elapsedMs: now() - startedAt,
				phase: progress?.phase ?? null,
				message: progress?.message ?? null,
				runningAdvisors: runningAdvisorsOf(progress),
				idleMs,
			});

			if (idleMs >= stallAfterMs && !activity.hasStalled) {
				activity.hasStalled = true;
				runLogger.warn('claude_run_stalled', { kind, sessionId: activity.sessionId, idleMs });
			}
		};

		const handleLine = (line: string): void => {
			activity.lastActivityAt = now();

			if (activity.sessionId === null) {
				activity.sessionId = readSessionIdFromLine(line);

				if (activity.sessionId !== null) {
					runLogger.info('claude_session_started', {
						kind,
						sessionId: activity.sessionId,
						clonePath,
					});
				}
			}

			onStdoutLine?.(line);
		};

		// Replies are short and bounded by their own timeout; reviews and repairs need a pulse
		const heartbeat = kind === 'reply' ? null : setInterval(logHeartbeat, heartbeatIntervalMs);

		runLogger.info('claude_run_started', { kind, model, hasReviewInstructions, clonePath });

		try {
			const output = await runCommand({
				command: 'caffeinate',
				args: ['-i', claudePath, ...args],
				cwd: clonePath,
				env: buildClaudeEnv({ baseEnv, shimDirectory }),
				timeoutMs: TIMEOUT_BY_KIND[kind],
				onStdoutLine: handleLine,
				signal,
			});
			const outcome = parse(output);

			const fields = {
				kind,
				sessionId: activity.sessionId,
				exitCode: output.exitCode,
				isTimedOut: output.isTimedOut,
				isAborted: signal?.aborted ?? false,
				durationMs: output.durationMs,
				outcome: outcome.kind,
				resolvedModel: resolvedModelOf(output.stdout),
			};

			if (outcome.kind === 'failed') {
				const failedResultPath = keepFailedResult(kind, outcome.rawEnvelope);

				runLogger.warn('claude_run_finished', {
					...fields,
					summary: outcome.summary,
					schemaIssues: outcome.schemaIssues,
					diagnostics: outcome.diagnostics,
					failedResultPath,
				});
			} else {
				runLogger.info('claude_run_finished', fields);
			}

			return outcome;
		} finally {
			if (heartbeat !== null) {
				clearInterval(heartbeat);
			}
		}
	};

	return {
		runReview: ({
			pullRequestUrl,
			clonePath,
			model,
			instructions,
			onProgress,
			signal,
			logger: runLogger,
		}) => {
			const args = buildClaudeArgs({
				kind: 'review',
				prompt: buildReviewPrompt(pullRequestUrl),
				systemPrompt: withReviewInstructions(REVIEW_SYSTEM_PROMPT, instructions),
				jsonSchema: REVIEW_RESULT_JSON_SCHEMA,
				model,
			});
			const progress = { current: createReviewProgress(now(), 'Starting the review') };
			const throttle: ActivityThrottle = { reportedAt: progress.current.lastActivityAt };
			onProgress?.(progress.current);

			return runClaude({
				kind: 'review',
				model,
				hasReviewInstructions: instructions !== '',
				args,
				clonePath,
				signal,
				runLogger,
				getProgress: () => progress.current,
				parse: (output) =>
					parseClaudeOutput({
						output,
						schema: REVIEW_RESULT_SCHEMA,
						now: now(),
						allowTextFallback: true,
					}),
				onStdoutLine: (line) => {
					const at = now();
					const next = applyStreamLine(progress.current, line, at);

					if (next === progress.current && !isActivityDue(throttle, at)) {
						return;
					}

					throttle.reportedAt = at;
					progress.current = { ...next, lastActivityAt: at };
					onProgress?.(progress.current);
				},
			});
		},
		runRepair: ({
			sessionId,
			clonePath,
			model,
			instructions,
			attempt,
			signal,
			logger: runLogger = logger,
			onActivity,
			getProgress,
		}) => {
			const throttle: ActivityThrottle = { reportedAt: now() };

			runLogger.info('claude_repair_run', { sessionId, attempt });

			return runClaude({
				kind: 'repair',
				model,
				hasReviewInstructions: instructions !== '',
				args: buildClaudeArgs({
					kind: 'review',
					prompt: REPAIR_PROMPT,
					systemPrompt: withReviewInstructions(REVIEW_SYSTEM_PROMPT, instructions),
					jsonSchema: REVIEW_RESULT_JSON_SCHEMA,
					model,
					resumeSessionId: sessionId,
				}),
				clonePath,
				signal,
				runLogger,
				getProgress,
				parse: (output) =>
					parseClaudeOutput({
						output,
						schema: REVIEW_RESULT_SCHEMA,
						now: now(),
						allowTextFallback: true,
					}),
				onStdoutLine: () => {
					const at = now();

					if (isActivityDue(throttle, at)) {
						throttle.reportedAt = at;
						onActivity?.(at);
					}
				},
			});
		},
		runReply: ({ prompt, clonePath, model, instructions }) => {
			const args = buildClaudeArgs({
				kind: 'reply',
				prompt,
				systemPrompt: withReviewInstructions(REPLY_SYSTEM_PROMPT, instructions),
				jsonSchema: REPLY_RESULT_JSON_SCHEMA,
				model,
			});

			return runClaude({
				kind: 'reply',
				model,
				hasReviewInstructions: instructions !== '',
				args,
				clonePath,
				parse: (output) => parseClaudeOutput({ output, schema: REPLY_RESULT_SCHEMA, now: now() }),
			});
		},
	};
};
