import type {
	LivePullRequest,
	PullRequestReview,
	ReviewThread,
	ReviewThreadComment,
} from '../github/github-types.js';
import type { DraftedReviewResult } from '../review/review-result.js';
import type { TrackedPullRequest } from '../tracking/tracking-types.js';

export const ANCHOR_TIME = Date.parse('2026-10-26T12:00:00Z');

export const makeTracked = (overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest => ({
	id: 1,
	owner: 'acme',
	repo: 'api',
	number: 7,
	url: 'https://github.com/acme/api/pull/7',
	title: 'Fix retry',
	author: 'ana',
	status: 'needs_review',
	rounds: 0,
	headSha: 'head-1',
	baseRefName: 'main',
	additions: 10,
	deletions: 2,
	isRequested: true,
	lastReviewedHead: null,
	lastAttemptedHead: null,
	attemptsForHead: 0,
	nextEligibleAt: null,
	headChangedAt: ANCHOR_TIME - 60 * 60_000,
	pendingApproval: null,
	lastSummary: null,
	lastError: null,
	reviewStartedAt: null,
	firstQueuedAt: null,
	trackedSince: ANCHOR_TIME - 2 * 60 * 60_000,
	updatedAt: ANCHOR_TIME - 60 * 60_000,
	...overrides,
});

export const makeLive = (overrides: Partial<LivePullRequest> = {}): LivePullRequest => ({
	owner: 'acme',
	repo: 'api',
	number: 7,
	title: 'Fix retry',
	url: 'https://github.com/acme/api/pull/7',
	author: 'ana',
	state: 'open',
	isMerged: false,
	isDraft: false,
	headSha: 'head-1',
	baseRefName: 'main',
	requestedReviewerLogins: [],
	additions: 10,
	deletions: 2,
	...overrides,
});

export const makeReview = (overrides: Partial<PullRequestReview> = {}): PullRequestReview => ({
	id: 1,
	state: 'COMMENTED',
	body: '',
	submittedAt: '2026-10-26T11:00:00Z',
	commitId: 'head-1',
	authorLogin: 'luka',
	authorType: 'User',
	...overrides,
});

export const makeDraft = (overrides: Partial<DraftedReviewResult> = {}): DraftedReviewResult => ({
	outcome: 'drafted',
	filing: 'comment',
	headRefOid: 'head-1',
	baseRefName: 'main',
	targetTipOid: 'tip-1',
	summary: 'Retry loop never backs off',
	mainReview: 'The retry loop needs a backoff.',
	comments: [{ path: 'src/retry.ts', line: 12, side: 'RIGHT', body: 'No delay between attempts.' }],
	fileComments: [],
	coverage: 'Checked retry paths.',
	...overrides,
});

export const makeComment = (overrides: Partial<ReviewThreadComment> = {}): ReviewThreadComment => ({
	databaseId: 100,
	body: 'Comment',
	createdAt: '2026-10-26T11:00:00Z',
	authorLogin: 'ana',
	authorType: 'User',
	...overrides,
});

export const makeThread = (
	comments: ReviewThreadComment[],
	overrides: Partial<ReviewThread> = {},
): ReviewThread => ({
	id: 'thread-1',
	isResolved: false,
	path: 'src/retry.ts',
	line: 12,
	comments,
	...overrides,
});
