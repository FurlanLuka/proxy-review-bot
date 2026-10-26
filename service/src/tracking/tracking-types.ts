import type { DraftedReviewResult } from '../review/review-result.js';

export type PullRequestStatus =
	| 'needs_review'
	| 'queued'
	| 'reviewing'
	| 'waiting_on_author'
	| 'awaiting_approval'
	| 'blocked'
	| 'needs_you'
	| 'done'
	| 'stopped';

export const TERMINAL_STATUSES: ReadonlySet<PullRequestStatus> = new Set([
	'needs_you',
	'done',
	'stopped',
]);

export interface PendingApproval {
	headSha: string;
	draft: DraftedReviewResult;
}

export interface TrackedPullRequest {
	id: number;
	owner: string;
	repo: string;
	number: number;
	url: string;
	title: string;
	author: string;
	status: PullRequestStatus;
	rounds: number;
	headSha: string | null;
	baseRefName: string | null;
	additions: number;
	deletions: number;
	isRequested: boolean;
	lastReviewedHead: string | null;
	lastAttemptedHead: string | null;
	attemptsForHead: number;
	nextEligibleAt: number | null;
	headChangedAt: number | null;
	pendingApproval: PendingApproval | null;
	lastSummary: string | null;
	lastError: string | null;
	reviewStartedAt: number | null;
	trackedSince: number;
	updatedAt: number;
}

export type PullRequestUpdate = Partial<
	Omit<TrackedPullRequest, 'id' | 'owner' | 'repo' | 'number'>
>;
