import type { Readiness } from '../readiness/readiness.js';
import type { ReviewProgress } from '../review/review-progress.js';
import type { Settings } from '../settings/settings.js';
import { DRAFT_HOLDING_STATUSES } from '../tracking/tracking-types.js';
import type { TrackedPullRequest } from '../tracking/tracking-types.js';

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
	summary: string | null;
	reason: string | null;
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

const toView = (
	tracked: TrackedPullRequest,
	maxRounds: number,
	progress: ReviewProgress | null,
): PullRequestView => ({
	id: tracked.id,
	owner: tracked.owner,
	repo: tracked.repo,
	number: tracked.number,
	title: tracked.title,
	url: tracked.url,
	author: tracked.author,
	status: tracked.status,
	rounds: tracked.rounds,
	maxRounds,
	additions: tracked.additions,
	deletions: tracked.deletions,
	headSha: tracked.headSha,
	summary: tracked.lastSummary,
	reason: tracked.lastError,
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
			.map((tracked) => toView(tracked, settings.maxRounds, progressById.get(tracked.id) ?? null)),
	};
};
