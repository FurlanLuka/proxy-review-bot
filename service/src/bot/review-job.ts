import { runInClone } from '../clones/clones.js';
import type { Logger } from '../logging/logger.js';
import {
	buildFailureUpdate,
	buildPostingUpdate,
	CLEARED_REPAIR_SESSION,
} from '../review/pull-request-updates.js';
import { decidePostingAction } from '../review/review-decisions.js';
import type { ReviewProgress } from '../review/review-progress.js';
import { findUsableSavedSession } from '../review/review-repair-rules.js';
import type { ReviewResult } from '../review/review-result.js';
import type { PullRequestUpdate, TrackedPullRequest } from '../tracking/tracking-types.js';
import type { BotDependencies } from './bot-context.js';
import { postReview } from './posting.js';
import { reviewWithRepair } from './review-repair.js';
import type { RepairContext } from './review-repair.js';

export type JobOutcome =
	| { kind: 'completed' }
	| { kind: 'usage_limited'; resumeAt: number }
	| { kind: 'setup_broken'; message: string };

interface RunReviewJobParams {
	dependencies: BotDependencies;
	tracked: TrackedPullRequest;
	viewerLogin: string;
	isPaused: () => boolean;
	onProgress?: (progress: ReviewProgress) => void;
	signal?: AbortSignal;
}

type JobRelease = 'discard' | 'requeue';

const COMPLETED: JobOutcome = { kind: 'completed' };

const findRelease = (
	{ dependencies, tracked, isPaused }: RunReviewJobParams,
	isAboutToPost: boolean,
): JobRelease | null => {
	const current = dependencies.store.getPullRequest(tracked.id);

	if (current === null || current.status !== 'reviewing') {
		return 'discard';
	}

	return isAboutToPost && isPaused() ? 'requeue' : null;
};

const releaseJob = (params: RunReviewJobParams, release: JobRelease): void => {
	const { store, logger, now } = params.dependencies;
	const current = store.getPullRequest(params.tracked.id);

	if (current === null) {
		return;
	}

	store.updatePullRequest(current.id, {
		reviewStartedAt: null,
		attemptsForHead: Math.max(0, current.attemptsForHead - 1),
		...(release === 'requeue' && { status: 'queued', updatedAt: now() }),
	});
	logger.warn('review_result_not_posted', { id: current.id, release, status: current.status });
};

interface ApplyResultParams {
	job: RunReviewJobParams;
	result: ReviewResult;
	jobHeadSha: string;
	jobBaseRefName: string;
	isRecovered: boolean;
}

const describeError = (error: unknown): string => {
	return error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
};

const applyResult = async ({
	job,
	result,
	jobHeadSha,
	jobBaseRefName,
	isRecovered,
}: ApplyResultParams): Promise<PullRequestUpdate | JobRelease> => {
	const { store, github, settingsStore, logger, now } = job.dependencies;
	const tracked = store.getPullRequest(job.tracked.id) ?? job.tracked;
	const live = await github.getPullRequest(tracked);
	const currentSettings = settingsStore.get();
	const settings = isRecovered
		? { ...currentSettings, reviewMode: 'manual' as const }
		: currentSettings;
	const action = decidePostingAction({
		result,
		jobHeadSha,
		jobBaseRefName,
		live,
		settings,
		changedLines: live.additions + live.deletions,
	});

	logger.info('review_result', {
		id: tracked.id,
		outcome: result.outcome,
		action: action.kind,
		isRecovered,
	});

	if (action.kind !== 'post') {
		return buildPostingUpdate({ action, tracked, jobHeadSha, now: now() });
	}

	const release = findRelease(job, true);

	if (release !== null) {
		return release;
	}

	try {
		const postOutcome = await postReview({
			github,
			logger,
			reference: tracked,
			draft: action.draft,
			event: action.event,
			headSha: jobHeadSha,
			viewerLogin: job.viewerLogin,
		});

		store.recordActivity(tracked.id, 'review_posted', {
			event: action.event,
			headSha: jobHeadSha,
			postOutcome,
		});
	} catch (error) {
		logger.error('review_post_failed', { id: tracked.id, error });

		return {
			status: 'needs_you',
			reviewStartedAt: null,
			lastError: `Posting the review failed: ${describeError(error)}`,
			updatedAt: now(),
		};
	}

	return buildPostingUpdate({
		action: { kind: 'posted', event: action.event, summary: action.draft.summary },
		tracked,
		jobHeadSha,
		now: now(),
	});
};

const writeFinalUpdate = (params: RunReviewJobParams, update: PullRequestUpdate): void => {
	const { store } = params.dependencies;
	const isStillReviewing = store.getPullRequest(params.tracked.id)?.status === 'reviewing';
	const { status: _keptStatus, ...updateWithoutStatus } = update;

	store.updatePullRequest(params.tracked.id, isStillReviewing ? update : updateWithoutStatus);
	store.recordActivity(params.tracked.id, 'review_finished', { status: update.status });
};

interface SaveRepairSessionParams {
	job: RunReviewJobParams;
	sessionId: string;
	headSha: string;
	jobLogger: Logger;
}

const saveRepairSession = ({
	job,
	sessionId,
	headSha,
	jobLogger,
}: SaveRepairSessionParams): void => {
	const { store, now } = job.dependencies;

	if (findRelease(job, false) !== null) {
		jobLogger.info('repair_session_not_saved', { sessionId });

		return;
	}

	store.updatePullRequest(job.tracked.id, {
		repairSessionId: sessionId,
		repairHeadSha: headSha,
		repairSavedAt: now(),
	});
};

const clearRepairSession = (job: RunReviewJobParams): void => {
	job.dependencies.store.updatePullRequest(job.tracked.id, CLEARED_REPAIR_SESSION);
};

interface BuildRepairContextParams {
	job: RunReviewJobParams;
	clonePath: string;
	headSha: string;
	jobLogger: Logger;
}

const buildRepairContext = ({
	job,
	clonePath,
	headSha,
	jobLogger,
}: BuildRepairContextParams): RepairContext => {
	const { claude, sleep, now } = job.dependencies;

	return {
		claude,
		sleep,
		now,
		logger: jobLogger,
		pullRequestUrl: job.tracked.url,
		clonePath,
		signal: job.signal,
		onProgress: job.onProgress,
		isReleased: () => job.signal?.aborted === true || findRelease(job, false) !== null,
		saveSession: (sessionId) => saveRepairSession({ job, sessionId, headSha, jobLogger }),
		clearSession: () => clearRepairSession(job),
	};
};

export const runReviewJob = async (params: RunReviewJobParams): Promise<JobOutcome> => {
	const { dependencies, tracked } = params;
	const { store, github, clones, logger, now } = dependencies;
	const jobLogger = logger.child({ jobPullRequestId: tracked.id, jobStartedAt: now() });

	store.updatePullRequest(tracked.id, {
		status: 'reviewing',
		reviewStartedAt: now(),
		nextEligibleAt: null,
		updatedAt: now(),
	});

	try {
		const live = await github.getPullRequest(tracked);
		const isSameHead = live.headSha === tracked.lastAttemptedHead;

		store.updatePullRequest(tracked.id, {
			lastAttemptedHead: live.headSha,
			attemptsForHead: isSameHead ? tracked.attemptsForHead + 1 : 1,
		});
		jobLogger.info('review_job_started', { url: tracked.url, headSha: live.headSha });

		const savedSessionId = findUsableSavedSession({
			saved: tracked,
			headSha: live.headSha,
			now: now(),
		});

		if (tracked.repairSessionId !== null && savedSessionId === null) {
			clearRepairSession(params);
		}

		const clone = await clones.prepareClone(tracked);
		const run = await runInClone(clone, async (clonePath) => {
			if (findRelease(params, false) !== null) {
				jobLogger.info('review_run_skipped', { reason: 'released_before_run' });

				return null;
			}

			return reviewWithRepair({
				context: buildRepairContext({ job: params, clonePath, headSha: live.headSha, jobLogger }),
				savedSessionId,
			});
		});
		const release = findRelease(params, false);

		if (release !== null || run === null) {
			releaseJob(params, release ?? 'discard');

			return COMPLETED;
		}

		const { outcome, isRecovered } = run;

		if (outcome.kind === 'usage_limited' || outcome.kind === 'setup_broken') {
			releaseJob(params, 'requeue');
			jobLogger.warn('review_job_interrupted', { reason: outcome.kind });

			return outcome;
		}

		const update =
			outcome.kind === 'failed'
				? buildFailureUpdate(outcome.summary, now())
				: await applyResult({
						job: params,
						result: outcome.result,
						jobHeadSha: live.headSha,
						jobBaseRefName: live.baseRefName,
						isRecovered,
					});

		if (update === 'discard' || update === 'requeue') {
			releaseJob(params, update);

			return COMPLETED;
		}

		writeFinalUpdate(params, update);

		if (outcome.kind === 'result') {
			clearRepairSession(params);
		}

		const finishedFields = { status: update.status, error: update.lastError };

		if (update.lastError) {
			jobLogger.warn('review_job_finished', finishedFields);
		} else {
			jobLogger.info('review_job_finished', finishedFields);
		}
	} catch (error) {
		jobLogger.error('review_job_failed', { error });
		writeFinalUpdate(params, buildFailureUpdate(describeError(error), now()));
	}

	return COMPLETED;
};
