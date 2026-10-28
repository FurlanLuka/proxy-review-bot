import type { Readiness } from '../readiness/readiness.js';
import type { ReviewProgress } from '../review/review-progress.js';
import type { Settings } from '../settings/settings.js';
import {
	isAutoStartAllowed,
	isOwnPullRequest,
	isReviewStarted,
	matchesManualStart,
} from '../review/review-decisions.js';
import { DRAFT_HOLDING_STATUSES } from '../tracking/tracking-types.js';
import type { PullRequestSource, TrackedPullRequest } from '../tracking/tracking-types.js';

const DONE_VISIBILITY_MS = 24 * 60 * 60_000;

export interface PullRequestView {
	id: number;
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	author: string;
	status: string;
	rounds: number;
	maxRounds: number;
	additions: number;
	deletions: number;
	headSha: string | null;
	headRefName: string | null;
	baseRefName: string | null;
	summary: string | null;
	reason: string | null;
	retryAt: number | null;
	isStarted: boolean;
	isOwn: boolean;
	isDraft: boolean;
	isManualStart: boolean;
	source: PullRequestSource;
	reviewStartedAt: number | null;
	updatedAt: number;
	progress: ReviewProgress | null;
	draft: DraftSummary | null;
}

export interface DraftSummary {
	filing: 'approve' | 'comment';
	summary: string;
	commentCount: number;
}

export interface BotState {
	viewerLogin: string | null;
	isPaused: boolean;
	usageLimitedUntil: number | null;
	readiness: Readiness;
	settings: Settings;
	pullRequests: PullRequestView[];
}

interface ToViewParams {
	tracked: TrackedPullRequest;
	settings: Settings;
	progress: ReviewProgress | null;
	viewerLogin: string | null;
}

const toView = ({ tracked, settings, progress, viewerLogin }: ToViewParams): PullRequestView => ({
	id: tracked.id,
	owner: tracked.owner,
	repo: tracked.repo,
	number: tracked.number,
	title: tracked.title,
	url: tracked.url,
	author: tracked.author,
	status: tracked.status,
	rounds: tracked.rounds,
	maxRounds: settings.maxRounds,
	additions: tracked.additions,
	deletions: tracked.deletions,
	headSha: tracked.headSha,
	headRefName: tracked.headRefName,
	baseRefName: tracked.baseRefName,
	summary: tracked.lastSummary,
	reason: tracked.lastError,
	retryAt:
		isAutoStartAllowed({
			settings,
			headRefName: tracked.headRefName,
			baseRefName: tracked.baseRefName,
			isStarted: isReviewStarted(tracked),
		}) &&
		tracked.status === 'waiting_on_author' &&
		tracked.lastError !== null
			? tracked.nextEligibleAt
			: null,
	isStarted: isReviewStarted(tracked),
	isOwn: isOwnPullRequest({ author: tracked.author, viewerLogin }),
	isDraft: tracked.isDraft,
	isManualStart:
		tracked.status === 'needs_review' &&
		matchesManualStart({
			headRefName: tracked.headRefName,
			baseRefName: tracked.baseRefName,
			rules: settings.manualStartBranches,
		}),
	source: tracked.source,
	reviewStartedAt: tracked.reviewStartedAt,
	updatedAt: tracked.updatedAt,
	progress,
	draft:
		tracked.pendingApproval === null || !DRAFT_HOLDING_STATUSES.has(tracked.status)
			? null
			: {
					filing: tracked.pendingApproval.draft.filing,
					summary: tracked.pendingApproval.draft.summary,
					commentCount:
						tracked.pendingApproval.draft.comments.length +
						tracked.pendingApproval.draft.fileComments.length,
				},
});

interface BuildBotStateParams {
	trackedPullRequests: TrackedPullRequest[];
	viewerLogin: string | null;
	isPaused: boolean;
	usageLimitedUntil: number | null;
	readiness: Readiness;
	settings: Settings;
	progressById: ReadonlyMap<number, ReviewProgress>;
	now: number;
}

export const buildBotState = ({
	trackedPullRequests,
	settings,
	progressById,
	now,
	...status
}: BuildBotStateParams): BotState => {
	const visibleSince = now - DONE_VISIBILITY_MS;

	return {
		...status,
		settings,
		pullRequests: trackedPullRequests
			.filter((tracked) => tracked.status !== 'done' || tracked.updatedAt >= visibleSince)
			.map((tracked) =>
				toView({
					tracked,
					settings,
					progress: progressById.get(tracked.id) ?? null,
					viewerLogin: status.viewerLogin,
				}),
			),
	};
};
