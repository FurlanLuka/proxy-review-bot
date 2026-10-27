import { buildHistory } from '../history/history.js';
import type { HistoryEntry } from '../history/history.js';
import {
	buildReviewCycleReset,
	CLEARED_REPAIR_SESSION,
	firstQueuedAtFor,
} from '../review/pull-request-updates.js';
import type { ReviewProgress } from '../review/review-progress.js';
import type { PullRequestUpdate, TrackedPullRequest } from '../tracking/tracking-types.js';
import { approvePullRequest, discardDraft, findHeldDraft, postEditedDraft } from './approval.js';
import type { ActionResult, DraftPostResult, HeldDraft } from './approval.js';
import { addPullRequest } from './add-pull-request.js';
import type { AddPullRequestResult } from './add-pull-request.js';
import type { BotDependencies, BotRuntime } from './bot-context.js';
import { runNextReplyJob } from './reply-job.js';
import { runReviewJob } from './review-job.js';
import type { JobOutcome } from './review-job.js';
import { buildBotState } from './state-view.js';
import type { BotState } from './state-view.js';
import { syncPullRequests } from './sync.js';

const READINESS_INTERVAL_MS = 10 * 60_000;
const PAUSED_FLAG = 'is_paused';
const USAGE_LIMIT_FLAG = 'usage_limited_until';
const MAX_PARALLEL_REVIEWS = 3;

export interface Bot {
	tick(): Promise<void>;
	waitForIdle(): Promise<void>;
	getState(): BotState;
	getHistory(): HistoryEntry[];
	requestReview(id: number): ActionResult;
	retry(id: number): ActionResult;
	stop(id: number): ActionResult;
	approve(id: number): Promise<ActionResult>;
	getDraft(id: number): HeldDraft | 'not_found' | 'no_draft';
	addPullRequest(url: string): Promise<AddPullRequestResult>;
	postDraft(id: number, edit: unknown): Promise<DraftPostResult>;
	discardDraft(id: number): ActionResult;
	setPaused(isPaused: boolean): void;
	recheckReadiness(): Promise<void>;
}

interface ReplyProgress {
	id: number;
	progress: ReviewProgress;
}

export const createBot = (dependencies: BotDependencies): Bot => {
	const { store, settingsStore, logger, now } = dependencies;
	const runtime: BotRuntime = {
		readiness: { status: 'checking', checks: [] },
		viewerLogin: null,
		readinessCheckedAt: null,
		isReplyJobRunning: false,
		isSyncing: false,
	};
	const readinessGeneration = { current: 0 };
	const runningJobs = new Set<Promise<void>>();
	const reviewingIds = new Set<number>();
	const reviewAborts = new Map<number, AbortController>();
	const approvingIds = new Set<number>();
	const reviewProgressById = new Map<number, ReviewProgress>();
	const replyProgress: { current: ReplyProgress | null } = { current: null };

	const isPaused = (): boolean => store.getFlag(PAUSED_FLAG) === 'true';

	const getUsageLimitedUntil = (): number | null => {
		const value = Number(store.getFlag(USAGE_LIMIT_FLAG) ?? 0);

		return value > now() ? value : null;
	};

	const recheckReadiness = async (): Promise<void> => {
		const generation = readinessGeneration.current;
		const report = await dependencies.runReadinessChecks();

		if (generation !== readinessGeneration.current) {
			logger.info('readiness_check_discarded', { status: report.readiness.status });

			return;
		}

		runtime.readiness = report.readiness;
		runtime.viewerLogin = report.viewerLogin;
		runtime.readinessCheckedAt = now();
		logger.info('readiness_checked', {
			status: report.readiness.status,
			failing: report.readiness.checks.filter((check) => !check.isOk).map((check) => check.name),
		});
	};

	const handleJobOutcome = (outcome: JobOutcome | null): void => {
		if (outcome?.kind === 'usage_limited') {
			const resumeAt = Math.max(outcome.resumeAt, getUsageLimitedUntil() ?? 0);

			store.setFlag(USAGE_LIMIT_FLAG, String(resumeAt));
			logger.warn('usage_limited', { resumeAt });
		}

		if (outcome?.kind === 'setup_broken') {
			readinessGeneration.current += 1;
			runtime.readiness = { ...runtime.readiness, status: 'checking' };
			runtime.readinessCheckedAt = null;
			logger.warn('setup_broken', { message: outcome.message });
		}
	};

	const findQueued = (): TrackedPullRequest[] => {
		return store
			.listPullRequests()
			.filter((tracked) => tracked.status === 'queued' && !reviewingIds.has(tracked.id))
			.sort((left, right) => left.updatedAt - right.updatedAt);
	};

	const trackJob = (job: Promise<JobOutcome | null>, onSettled: () => void): void => {
		const tracked: Promise<void> = job
			.then(handleJobOutcome)
			.catch((error: unknown) => logger.error('job_failed', { error }))
			.finally(() => {
				runningJobs.delete(tracked);
				onSettled();
			});

		runningJobs.add(tracked);
	};

	const startReviewJob = (tracked: TrackedPullRequest, viewerLogin: string): void => {
		const abortController = new AbortController();

		reviewingIds.add(tracked.id);
		reviewAborts.set(tracked.id, abortController);
		trackJob(
			runReviewJob({
				dependencies,
				tracked,
				viewerLogin,
				isPaused,
				onProgress: (progress) => reviewProgressById.set(tracked.id, progress),
				signal: abortController.signal,
			}),
			() => {
				reviewingIds.delete(tracked.id);
				reviewAborts.delete(tracked.id);
				reviewProgressById.delete(tracked.id);
				startQueuedReviewsNow();
			},
		);
	};

	const abortUnwantedReviews = (): void => {
		for (const [id, abortController] of reviewAborts) {
			const status = store.getPullRequest(id)?.status;

			if (status !== 'reviewing' && !abortController.signal.aborted) {
				abortController.abort();
				logger.info('review_run_aborted', { id, status });
			}
		}
	};

	const startReplyJob = (viewerLogin: string): void => {
		runtime.isReplyJobRunning = true;
		trackJob(
			runNextReplyJob({
				dependencies,
				viewerLogin,
				isPaused,
				onProgress: (id, progress) => {
					replyProgress.current = { id, progress };
				},
			}),
			() => {
				runtime.isReplyJobRunning = false;
				replyProgress.current = null;
			},
		);
	};

	const buildProgressById = (): Map<number, ReviewProgress> => {
		const answering = replyProgress.current;
		const progressById = new Map<number, ReviewProgress>(
			answering === null ? [] : [[answering.id, answering.progress]],
		);

		for (const [id, progress] of reviewProgressById) {
			progressById.set(id, progress);
		}

		return progressById;
	};

	const canRunJobs = (): boolean => {
		return runtime.readiness.status === 'ready' && !isPaused() && getUsageLimitedUntil() === null;
	};

	const startQueuedReviews = (viewerLogin: string): void => {
		const freeSlots = MAX_PARALLEL_REVIEWS - reviewingIds.size;

		for (const tracked of findQueued().slice(0, Math.max(0, freeSlots))) {
			startReviewJob(tracked, viewerLogin);
		}
	};

	const startQueuedReviewsNow = (): void => {
		const viewerLogin = runtime.viewerLogin;

		try {
			if (viewerLogin !== null && canRunJobs()) {
				startQueuedReviews(viewerLogin);
			}
		} catch (error) {
			logger.error('queued_reviews_start_failed', { error });
		}
	};

	const startJobs = (viewerLogin: string): void => {
		startQueuedReviews(viewerLogin);

		if (!runtime.isReplyJobRunning && settingsStore.get().answerQuestions) {
			startReplyJob(viewerLogin);
		}
	};

	const tick = async (): Promise<void> => {
		if (runtime.isSyncing) {
			return;
		}

		runtime.isSyncing = true;

		try {
			const isReadinessDue =
				runtime.readinessCheckedAt === null ||
				now() - runtime.readinessCheckedAt >= READINESS_INTERVAL_MS;

			if (isReadinessDue) {
				await recheckReadiness();
			}

			const viewerLogin = runtime.viewerLogin;

			if (viewerLogin === null) {
				return;
			}

			await syncPullRequests({ dependencies, viewerLogin, isPaused: isPaused() });
			abortUnwantedReviews();

			if (canRunJobs()) {
				startJobs(viewerLogin);
			}
		} catch (error) {
			logger.error('tick_failed', { error });
		} finally {
			runtime.isSyncing = false;
		}
	};

	const applyManualAction = (id: number, update: PullRequestUpdate): ActionResult => {
		const tracked = store.getPullRequest(id);

		if (tracked === null) {
			return 'not_found';
		}

		const isBusy = tracked.status === 'reviewing' || approvingIds.has(id);

		if (isBusy && update.status !== 'stopped') {
			return 'busy';
		}

		store.updatePullRequest(id, {
			...update,
			...(update.status === 'queued' && { firstQueuedAt: firstQueuedAtFor(tracked, now()) }),
			updatedAt: now(),
		});
		store.recordActivity(id, 'manual_action', update);
		logger.info('pull_request_manual_action', { id, from: tracked.status, to: update.status });
		abortUnwantedReviews();

		return 'ok';
	};

	const withPostingGuard = async <Result>(
		id: number,
		busyResult: Result,
		post: () => Promise<Result>,
	): Promise<Result> => {
		if (approvingIds.has(id)) {
			return busyResult;
		}

		approvingIds.add(id);

		try {
			return await post();
		} finally {
			approvingIds.delete(id);
		}
	};

	const approve = (id: number): Promise<ActionResult> => {
		return withPostingGuard<ActionResult>(id, 'busy', () =>
			approvePullRequest({ dependencies, id, viewerLogin: runtime.viewerLogin }),
		);
	};

	return {
		tick,
		waitForIdle: async () => {
			while (runningJobs.size > 0) {
				await Promise.all(runningJobs);
			}
		},
		getHistory: () => buildHistory({ store, now: now() }),
		getState: () =>
			buildBotState({
				trackedPullRequests: store.listPullRequests(),
				viewerLogin: runtime.viewerLogin,
				isPaused: isPaused(),
				usageLimitedUntil: getUsageLimitedUntil(),
				readiness: runtime.readiness,
				settings: settingsStore.get(),
				progressById: buildProgressById(),
				now: now(),
			}),
		requestReview: (id) => {
			const result = applyManualAction(id, {
				status: 'queued',
				lastError: null,
				nextEligibleAt: null,
				pendingApproval: null,
			});

			if (result === 'ok') {
				startQueuedReviewsNow();
			}

			return result;
		},
		retry: (id) => {
			const result = applyManualAction(id, { ...buildReviewCycleReset(now()), status: 'queued' });

			if (result === 'ok') {
				store.recordActivity(id, 'retry', {});
				startQueuedReviewsNow();
			}

			return result;
		},
		stop: (id) =>
			applyManualAction(id, {
				status: 'stopped',
				pendingApproval: null,
				...CLEARED_REPAIR_SESSION,
			}),
		approve,
		addPullRequest: async (url) => {
			const result = await addPullRequest({ dependencies, url, viewerLogin: runtime.viewerLogin });

			if (result.kind === 'added' && !result.isExisting) {
				startQueuedReviewsNow();
			}

			return result;
		},
		getDraft: (id) => findHeldDraft({ dependencies, id, viewerLogin: runtime.viewerLogin }),
		postDraft: (id, edit) =>
			withPostingGuard<DraftPostResult>(id, { result: 'busy' }, () =>
				postEditedDraft({ dependencies, id, viewerLogin: runtime.viewerLogin, edit }),
			),
		discardDraft: (id) => (approvingIds.has(id) ? 'busy' : discardDraft({ dependencies, id })),
		setPaused: (shouldPause) => {
			store.setFlag(PAUSED_FLAG, shouldPause ? 'true' : null);
			logger.info('pause_changed', { isPaused: shouldPause });

			if (!shouldPause) {
				startQueuedReviewsNow();
			}
		},
		recheckReadiness,
	};
};
