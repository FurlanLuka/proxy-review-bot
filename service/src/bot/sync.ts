import {
	hasManualReview,
	isRepositoryIncluded,
	parseMyReviewState,
} from '../github/github-parsers.js';
import { GitHubRequestError } from '../github/github-types.js';
import type { PullRequestReview } from '../github/github-types.js';
import { buildActionUpdate, buildLiveUpdate } from '../review/pull-request-updates.js';
import {
	decidePullRequestAction,
	isDecisionDeferred,
	isOwnPullRequest,
	isViewerRequested,
} from '../review/review-decisions.js';
import { TERMINAL_STATUSES } from '../tracking/tracking-types.js';
import type { TrackedPullRequest } from '../tracking/tracking-types.js';
import type { BotDependencies } from './bot-context.js';

interface SyncPullRequestsParams {
	dependencies: BotDependencies;
	viewerLogin: string;
	isPaused: boolean;
}

const pullRequestKey = (owner: string, repo: string, number: number): string => {
	return `${owner}/${repo}#${number}`.toLowerCase();
};

const reviewsSince = (reviews: PullRequestReview[], since: number): PullRequestReview[] => {
	return reviews.filter(
		(review) => review.submittedAt !== null && Date.parse(review.submittedAt) >= since,
	);
};

interface ClearRequestIfWithdrawnParams {
	dependencies: BotDependencies;
	tracked: TrackedPullRequest;
	viewerLogin: string;
}

const clearRequestIfWithdrawn = async ({
	dependencies,
	tracked,
	viewerLogin,
}: ClearRequestIfWithdrawnParams): Promise<void> => {
	const { store, github, logger } = dependencies;

	try {
		const live = await github.getPullRequest(tracked);

		if (live.state === 'closed' || !isViewerRequested({ live, viewerLogin })) {
			store.updatePullRequest(tracked.id, { isRequested: false });
		}
	} catch (error) {
		if (error instanceof GitHubRequestError && error.status === 404) {
			store.updatePullRequest(tracked.id, { isRequested: false });
			logger.warn('pull_request_request_check_gone', { id: tracked.id });

			return;
		}

		logger.error('pull_request_request_check_failed', { id: tracked.id, error });
	}
};

export const syncPullRequests = async ({
	dependencies,
	viewerLogin,
	isPaused,
}: SyncPullRequestsParams): Promise<void> => {
	const { store, settingsStore, github, logger, now } = dependencies;
	const settings = settingsStore.get();
	const discovered = (await github.searchRequestedPullRequests()).filter((pullRequest) =>
		isRepositoryIncluded(settings, pullRequest.owner, pullRequest.repo),
	);
	const requestedKeys = new Set(
		discovered.map((pullRequest) =>
			pullRequestKey(pullRequest.owner, pullRequest.repo, pullRequest.number),
		),
	);

	for (const pullRequest of discovered) {
		const existing = store.findPullRequest(pullRequest.owner, pullRequest.repo, pullRequest.number);

		if (existing === null) {
			const inserted = store.insertDiscovered({
				discovered: pullRequest,
				status: 'needs_review',
				now: now(),
			});

			store.recordActivity(inserted.id, 'discovered', { url: pullRequest.url });
			logger.info('pull_request_discovered', { id: inserted.id, url: pullRequest.url });
		}
	}

	for (const tracked of store.listPullRequests()) {
		const isInSearch = requestedKeys.has(
			pullRequestKey(tracked.owner, tracked.repo, tracked.number),
		);

		if (TERMINAL_STATUSES.has(tracked.status) && !isInSearch) {
			if (tracked.isRequested) {
				await clearRequestIfWithdrawn({ dependencies, tracked, viewerLogin });
			}

			continue;
		}

		try {
			const [live, reviews] = await Promise.all([
				github.getPullRequest(tracked),
				github.listReviews(tracked),
			]);
			const currentNow = now();
			const isRequestedNow = isViewerRequested({ live, viewerLogin });
			const recentReviews = reviewsSince(reviews, tracked.trackedSince);
			const isOwn = isOwnPullRequest({ author: live.author, viewerLogin });
			const action = decidePullRequestAction({
				tracked,
				live,
				isRequestedNow,
				myReviewState: parseMyReviewState(recentReviews, viewerLogin),
				hasManualReview: !isOwn && hasManualReview(recentReviews, viewerLogin),
				settings,
				isPaused,
				now: currentNow,
			});
			const actionUpdate = buildActionUpdate(action, tracked, currentNow);
			const isRequestChangeDeferred =
				action.kind === 'none' && isDecisionDeferred({ tracked, live, isPaused });

			store.updatePullRequest(tracked.id, {
				...buildLiveUpdate({
					tracked,
					live,
					isRequestedNow: isRequestChangeDeferred ? tracked.isRequested : isRequestedNow,
					now: currentNow,
				}),
				...(actionUpdate !== null && { ...actionUpdate, updatedAt: currentNow }),
			});

			if (action.kind !== 'none') {
				store.recordActivity(tracked.id, action.kind, action);
				logger.info('pull_request_transition', {
					id: tracked.id,
					from: tracked.status,
					action: action.kind,
				});
			}
		} catch (error) {
			logger.error('pull_request_sync_failed', { id: tracked.id, error });
		}
	}
};
