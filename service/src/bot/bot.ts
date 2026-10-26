import { buildReviewCycleReset } from '../review/pull-request-updates.js';
import type { PullRequestUpdate, TrackedPullRequest } from '../tracking/tracking-types.js';
import { approvePullRequest } from './approval.js';
import type { ActionResult } from './approval.js';
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

export interface Bot {
	tick(): Promise<void>;
	waitForIdle(): Promise<void>;
	getState(): BotState;
	requestReview(id: number): ActionResult;
	retry(id: number): ActionResult;
	stop(id: number): ActionResult;
	approve(id: number): Promise<ActionResult>;
	setPaused(isPaused: boolean): void;
	recheckReadiness(): Promise<void>;
}

export const createBot = (dependencies: BotDependencies): Bot => {
	const { store, settingsStore, logger, now } = dependencies;
	const runtime: BotRuntime = {
		readiness: { status: 'checking', checks: [] },
		viewerLogin: null,
		readinessCheckedAt: null,
		isJobRunning: false,
		isSyncing: false,
	};
	const jobs = { current: Promise.resolve() };
	const approvingIds = new Set<number>();

	const isPaused = (): boolean => store.getFlag(PAUSED_FLAG) === 'true';

	const getUsageLimitedUntil = (): number | null => {
		const value = Number(store.getFlag(USAGE_LIMIT_FLAG) ?? 0);

		return value > now() ? value : null;
	};

	const recheckReadiness = async (): Promise<void> => {
		const report = await dependencies.runReadinessChecks();

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
			store.setFlag(USAGE_LIMIT_FLAG, String(outcome.resumeAt));
			logger.warn('usage_limited', { resumeAt: outcome.resumeAt });
		}

		if (outcome?.kind === 'setup_broken') {
			runtime.readinessCheckedAt = null;
			logger.warn('setup_broken', { message: outcome.message });
		}
	};

	const findNextQueued = (): TrackedPullRequest | undefined => {
		return store
			.listPullRequests()
			.filter((tracked) => tracked.status === 'queued')
			.sort((left, right) => left.updatedAt - right.updatedAt)[0];
	};

	const runNextJob = async (viewerLogin: string): Promise<void> => {
		const nextQueued = findNextQueued();

		if (nextQueued !== undefined) {
			handleJobOutcome(
				await runReviewJob({ dependencies, tracked: nextQueued, viewerLogin, isPaused }),
			);

			return;
		}

		if (settingsStore.get().answerQuestions) {
			handleJobOutcome(await runNextReplyJob({ dependencies, viewerLogin, isPaused }));
		}
	};

	const startNextJob = (viewerLogin: string): void => {
		runtime.isJobRunning = true;
		jobs.current = runNextJob(viewerLogin)
			.catch((error: unknown) => logger.error('job_failed', { error }))
			.finally(() => {
				runtime.isJobRunning = false;
			});
	};

	const canRunJobs = (): boolean => {
		return (
			!runtime.isJobRunning &&
			runtime.readiness.status === 'ready' &&
			!isPaused() &&
			getUsageLimitedUntil() === null
		);
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

			if (canRunJobs()) {
				startNextJob(viewerLogin);
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

		store.updatePullRequest(id, { ...update, updatedAt: now() });
		store.recordActivity(id, 'manual_action', update);
		logger.info('pull_request_manual_action', { id, from: tracked.status, to: update.status });

		return 'ok';
	};

	const approve = async (id: number): Promise<ActionResult> => {
		if (approvingIds.has(id)) {
			return 'busy';
		}

		approvingIds.add(id);

		try {
			return await approvePullRequest({ dependencies, id, viewerLogin: runtime.viewerLogin });
		} finally {
			approvingIds.delete(id);
		}
	};

	return {
		tick,
		waitForIdle: async () => {
			await jobs.current;
		},
		getState: () =>
			buildBotState({
				trackedPullRequests: store.listPullRequests(),
				viewerLogin: runtime.viewerLogin,
				isPaused: isPaused(),
				usageLimitedUntil: getUsageLimitedUntil(),
				readiness: runtime.readiness,
				settings: settingsStore.get(),
				now: now(),
			}),
		requestReview: (id) =>
			applyManualAction(id, { status: 'queued', lastError: null, nextEligibleAt: null }),
		retry: (id) => applyManualAction(id, { ...buildReviewCycleReset(now()), status: 'queued' }),
		stop: (id) => applyManualAction(id, { status: 'stopped', pendingApproval: null }),
		approve,
		setPaused: (shouldPause) => {
			store.setFlag(PAUSED_FLAG, shouldPause ? 'true' : null);
			logger.info('pause_changed', { isPaused: shouldPause });
		},
		recheckReadiness,
	};
};
