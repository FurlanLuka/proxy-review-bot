import type { LivePullRequest } from '../github/github-types.js';
import { TERMINAL_STATUSES } from '../tracking/tracking-types.js';
import type {
	PullRequestStatus,
	PullRequestUpdate,
	TrackedPullRequest,
} from '../tracking/tracking-types.js';
import type { PostingAction, PullRequestAction } from './review-decisions.js';
import { RETRY_BACKOFF_MS } from './review-decisions.js';

export const firstQueuedAtFor = (
	tracked: Pick<TrackedPullRequest, 'firstQueuedAt'>,
	now: number,
): number => {
	return tracked.firstQueuedAt ?? now;
};

export const CLEARED_REPAIR_SESSION = {
	repairSessionId: null,
	repairHeadSha: null,
	repairSavedAt: null,
} as const;

export const buildReviewCycleReset = (now: number): PullRequestUpdate => ({
	rounds: 0,
	attemptsForHead: 0,
	lastAttemptedHead: null,
	lastReviewedHead: null,
	nextEligibleAt: null,
	pendingApproval: null,
	lastError: null,
	trackedSince: now,
});

export const buildFailureUpdate = (summary: string, now: number): PullRequestUpdate => ({
	status: 'waiting_on_author',
	reviewStartedAt: null,
	lastError: summary,
	nextEligibleAt: now + RETRY_BACKOFF_MS,
	updatedAt: now,
});

export const buildActionUpdate = (
	action: PullRequestAction,
	tracked: TrackedPullRequest,
	now: number,
): PullRequestUpdate | null => {
	switch (action.kind) {
		case 'none':
			return null;
		case 'finish':
			return {
				status: 'done',
				pendingApproval: null,
				lastError: null,
				reviewStartedAt: null,
				...CLEARED_REPAIR_SESSION,
			};
		case 'take_over':
			return {
				status: 'needs_you',
				pendingApproval: null,
				lastError: 'You reviewed this PR yourself',
				...CLEARED_REPAIR_SESSION,
			};
		case 'reopen':
			return {
				...buildReviewCycleReset(now),
				...CLEARED_REPAIR_SESSION,
				status: 'needs_review',
				firstQueuedAt: tracked.status === 'stopped' ? null : tracked.firstQueuedAt,
			};
		case 'give_up':
			return { status: 'needs_you', pendingApproval: null, lastError: action.reason };
		case 'clear_approval':
			return { status: 'waiting_on_author', pendingApproval: null };
		case 'enqueue':
			return {
				status: 'queued',
				pendingApproval: null,
				firstQueuedAt: firstQueuedAtFor(tracked, now),
			};
		case 'mark_needs_review':
			return {
				status: 'needs_review',
				pendingApproval: null,
				lastError: tracked.status === 'waiting_on_author' ? tracked.lastError : null,
			};
	}
};

interface BuildLiveUpdateParams {
	tracked: TrackedPullRequest;
	live: LivePullRequest;
	isRequestedNow: boolean;
	now: number;
}

export const buildLiveUpdate = ({
	tracked,
	live,
	isRequestedNow,
	now,
}: BuildLiveUpdateParams): PullRequestUpdate => ({
	title: live.title,
	headSha: live.headSha,
	headRefName: live.headRefName,
	baseRefName: live.baseRefName,
	additions: live.additions,
	deletions: live.deletions,
	isRequested: isRequestedNow,
	isDraft: live.isDraft,
	headChangedAt: live.headSha === tracked.headSha ? tracked.headChangedAt : now,
});

interface BuildPostingUpdateParams {
	action:
		| Exclude<PostingAction, { kind: 'post' }>
		| { kind: 'posted'; event: 'COMMENT' | 'APPROVE'; summary: string };
	tracked: TrackedPullRequest;
	jobHeadSha: string;
	now: number;
}

export const buildPostingUpdate = ({
	action,
	tracked,
	jobHeadSha,
	now,
}: BuildPostingUpdateParams): PullRequestUpdate => {
	const finished = { reviewStartedAt: null, updatedAt: now };
	const reviewed = {
		...finished,
		lastReviewedHead: jobHeadSha,
		lastError: null,
		attemptsForHead: 0,
	};

	switch (action.kind) {
		case 'fail':
			return buildFailureUpdate(action.summary, now);
		case 'block':
			return { ...finished, status: 'blocked', lastError: action.summary };
		case 'discard_draft':
			return {
				...finished,
				status: 'waiting_on_author',
				attemptsForHead: 0,
				lastAttemptedHead: null,
				lastError: null,
			};
		case 'record_nothing_new':
			return { ...reviewed, status: 'waiting_on_author', lastSummary: action.summary };
		case 'await_approval':
			return {
				...reviewed,
				status: 'awaiting_approval',
				pendingApproval: { headSha: jobHeadSha, draft: action.draft },
				lastSummary: action.draft.summary,
			};
		case 'hold_draft':
			return {
				...reviewed,
				status: 'draft_ready',
				pendingApproval: { headSha: jobHeadSha, draft: action.draft },
				lastSummary: action.draft.summary,
			};
		case 'posted':
			return {
				...reviewed,
				status: action.event === 'APPROVE' ? 'done' : 'waiting_on_author',
				rounds: tracked.rounds + 1,
				isRequested: false,
				lastSummary: action.summary,
			};
	}
};

export type LinkedAddOutcome = 'inserted' | 'existing' | 'started' | 'requeued';

export interface LinkedAddPlan {
	outcome: LinkedAddOutcome;
	update: PullRequestUpdate | null;
}

export const statusForLinkedPullRequest = (
	live: Pick<LivePullRequest, 'isDraft'>,
): PullRequestStatus => {
	return live.isDraft ? 'needs_review' : 'queued';
};

const isRestartedByLink = (tracked: TrackedPullRequest): boolean => {
	return TERMINAL_STATUSES.has(tracked.status) || tracked.status === 'blocked';
};

interface PlanLinkedAddParams {
	existing: TrackedPullRequest | null;
	live: Pick<LivePullRequest, 'isDraft'>;
	isRequested: boolean;
	now: number;
}

export const planLinkedAdd = ({
	existing,
	live,
	isRequested,
	now,
}: PlanLinkedAddParams): LinkedAddPlan => {
	if (existing === null) {
		return { outcome: 'inserted', update: null };
	}

	if (isRestartedByLink(existing)) {
		return {
			outcome: 'requeued',
			update: {
				...buildReviewCycleReset(now),
				...CLEARED_REPAIR_SESSION,
				status: statusForLinkedPullRequest(live),
				source: 'link',
				isRequested,
				isDraft: live.isDraft,
				firstQueuedAt: now,
				reviewStartedAt: null,
				updatedAt: now,
			},
		};
	}

	if (existing.status === 'needs_review') {
		return {
			outcome: 'started',
			update: {
				status: statusForLinkedPullRequest(live),
				isDraft: live.isDraft,
				firstQueuedAt: firstQueuedAtFor(existing, now),
				lastError: null,
				nextEligibleAt: null,
				pendingApproval: null,
				updatedAt: now,
			},
		};
	}

	return { outcome: 'existing', update: null };
};
