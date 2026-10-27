import type { LivePullRequest } from '../github/github-types.js';
import type { MyReviewState } from '../github/github-parsers.js';
import type { Settings } from '../settings/settings.js';
import { DRAFT_HOLDING_STATUSES, TERMINAL_STATUSES } from '../tracking/tracking-types.js';
import type { PullRequestStatus, TrackedPullRequest } from '../tracking/tracking-types.js';
import type { DraftedReviewResult, ReviewResult } from './review-result.js';

export const QUIET_PERIOD_MS = 5 * 60_000;
export const MAX_ATTEMPTS_PER_HEAD = 2;
export const RETRY_BACKOFF_MS = 10 * 60_000;

const BLOCK_REASON_TEXT = {
	snapshot_unstable: 'PR kept changing',
	diff_mismatch: "Diff didn't match GitHub",
	missing_access: 'No access',
	other: 'Stopped',
} as const;

export type PullRequestAction =
	| { kind: 'none' }
	| { kind: 'finish'; reason: 'merged' | 'closed' | 'approved' }
	| { kind: 'take_over' }
	| { kind: 'reopen' }
	| { kind: 'give_up'; reason: string }
	| { kind: 'clear_approval' }
	| { kind: 'enqueue' }
	| { kind: 'mark_needs_review' };

interface DecidePullRequestActionParams {
	tracked: TrackedPullRequest;
	live: LivePullRequest;
	isRequestedNow: boolean;
	myReviewState: MyReviewState;
	hasManualReview: boolean;
	settings: Pick<Settings, 'reviewMode' | 'maxRounds'>;
	isPaused: boolean;
	now: number;
}

const NONE: PullRequestAction = { kind: 'none' };

const RE_REQUESTABLE_STATUSES: ReadonlySet<PullRequestStatus> = new Set([
	'waiting_on_author',
	'blocked',
]);

const isInFlight = (tracked: Pick<TrackedPullRequest, 'status'>): boolean => {
	return tracked.status === 'queued' || tracked.status === 'reviewing';
};

export const isReviewStarted = (tracked: TrackedPullRequest): boolean => {
	return tracked.firstQueuedAt !== null;
};

interface IsOwnPullRequestParams {
	author: string;
	viewerLogin: string | null;
}

export const isOwnPullRequest = ({ author, viewerLogin }: IsOwnPullRequestParams): boolean => {
	return viewerLogin !== null && author.toLowerCase() === viewerLogin.toLowerCase();
};

interface IsViewerRequestedParams {
	live: Pick<LivePullRequest, 'requestedReviewerLogins'>;
	viewerLogin: string;
}

export const isViewerRequested = ({ live, viewerLogin }: IsViewerRequestedParams): boolean => {
	const viewer = viewerLogin.toLowerCase();

	return live.requestedReviewerLogins.some((login) => login.toLowerCase() === viewer);
};

interface IsDecisionDeferredParams {
	tracked: Pick<TrackedPullRequest, 'status'>;
	live: Pick<LivePullRequest, 'state' | 'isDraft'>;
	isPaused: boolean;
}

export const isDecisionDeferred = ({
	tracked,
	live,
	isPaused,
}: IsDecisionDeferredParams): boolean => {
	if (live.state === 'closed' || TERMINAL_STATUSES.has(tracked.status)) {
		return false;
	}

	return isInFlight(tracked) || isPaused || live.isDraft;
};

const giveUpAfterRounds = (rounds: number): PullRequestAction => ({
	kind: 'give_up',
	reason: `Gave up after ${rounds} rounds`,
});

export const decidePullRequestAction = ({
	tracked,
	live,
	isRequestedNow,
	myReviewState,
	hasManualReview,
	settings,
	isPaused,
	now,
}: DecidePullRequestActionParams): PullRequestAction => {
	if (live.state === 'closed') {
		return tracked.status === 'done'
			? NONE
			: { kind: 'finish', reason: live.isMerged ? 'merged' : 'closed' };
	}

	if (TERMINAL_STATUSES.has(tracked.status)) {
		return isRequestedNow && !tracked.isRequested ? { kind: 'reopen' } : NONE;
	}

	if (myReviewState === 'approved') {
		return { kind: 'finish', reason: 'approved' };
	}

	if (hasManualReview) {
		return { kind: 'take_over' };
	}

	if (isDecisionDeferred({ tracked, live, isPaused })) {
		return NONE;
	}

	const isReRequested = isRequestedNow && !tracked.isRequested;

	if (isReviewStarted(tracked) && isReRequested && RE_REQUESTABLE_STATUSES.has(tracked.status)) {
		return tracked.rounds >= settings.maxRounds
			? giveUpAfterRounds(tracked.rounds)
			: { kind: 'enqueue' };
	}

	const head = live.headSha;

	if (tracked.status === 'blocked' && head === tracked.lastAttemptedHead) {
		return NONE;
	}

	if (head === tracked.lastReviewedHead) {
		return NONE;
	}

	if (DRAFT_HOLDING_STATUSES.has(tracked.status)) {
		return { kind: 'clear_approval' };
	}

	if (head === tracked.lastAttemptedHead && tracked.attemptsForHead >= MAX_ATTEMPTS_PER_HEAD) {
		return {
			kind: 'give_up',
			reason: `Review failed ${tracked.attemptsForHead} times on this commit`,
		};
	}

	if (tracked.nextEligibleAt !== null && now < tracked.nextEligibleAt) {
		return NONE;
	}

	if (tracked.rounds >= settings.maxRounds) {
		return giveUpAfterRounds(tracked.rounds);
	}

	const isReReview = tracked.lastReviewedHead !== null;
	const headChangedAt = tracked.headChangedAt ?? now;

	if (isReReview && now - headChangedAt < QUIET_PERIOD_MS) {
		return NONE;
	}

	if (settings.reviewMode === 'auto' || isReviewStarted(tracked)) {
		return { kind: 'enqueue' };
	}

	return tracked.status === 'needs_review' ? NONE : { kind: 'mark_needs_review' };
};

export type PostingAction =
	| { kind: 'discard_draft' }
	| { kind: 'record_nothing_new'; summary: string }
	| { kind: 'block'; summary: string }
	| { kind: 'fail'; summary: string }
	| { kind: 'post'; event: 'COMMENT' | 'APPROVE'; draft: DraftedReviewResult }
	| { kind: 'await_approval'; draft: DraftedReviewResult }
	| { kind: 'hold_draft'; draft: DraftedReviewResult };

interface DecidePostingActionParams {
	result: ReviewResult;
	jobHeadSha: string;
	jobBaseRefName: string;
	live: Pick<LivePullRequest, 'headSha' | 'baseRefName' | 'state'>;
	settings: Pick<Settings, 'autoApprove' | 'smallPullRequestLineLimit' | 'postReviews'>;
	changedLines: number;
	isOwn: boolean;
}

const isAutoApproveAllowed = (
	settings: DecidePostingActionParams['settings'],
	changedLines: number,
): boolean => {
	return (
		settings.autoApprove === 'on' ||
		(settings.autoApprove === 'small' && changedLines < settings.smallPullRequestLineLimit)
	);
};

export const decidePostingAction = ({
	result,
	jobHeadSha,
	jobBaseRefName,
	live,
	settings,
	changedLines,
	isOwn,
}: DecidePostingActionParams): PostingAction => {
	if (result.outcome === 'failed') {
		return { kind: 'fail', summary: result.summary };
	}

	if (result.outcome === 'blocked') {
		return { kind: 'block', summary: `${BLOCK_REASON_TEXT[result.reason]}: ${result.summary}` };
	}

	const hasLiveMoved =
		live.state === 'closed' || live.headSha !== jobHeadSha || live.baseRefName !== jobBaseRefName;

	if (hasLiveMoved) {
		return { kind: 'discard_draft' };
	}

	if (result.headRefOid !== jobHeadSha) {
		return { kind: 'fail', summary: `Review was for ${result.headRefOid}, not ${jobHeadSha}` };
	}

	if (result.outcome === 'nothing_new') {
		return { kind: 'record_nothing_new', summary: result.summary };
	}

	// GitHub only accepts comment reviews from a PR's own author.
	const draft = isOwn ? { ...result, filing: 'comment' as const } : result;

	if (settings.postReviews === 'ask') {
		return { kind: 'hold_draft', draft };
	}

	if (draft.filing === 'comment') {
		return { kind: 'post', event: 'COMMENT', draft };
	}

	return isAutoApproveAllowed(settings, changedLines)
		? { kind: 'post', event: 'APPROVE', draft }
		: { kind: 'await_approval', draft };
};

export type ApprovalAction =
	| { kind: 'not_awaiting_approval' }
	| { kind: 'not_ready' }
	| { kind: 'closed' }
	| { kind: 'head_moved' }
	| { kind: 'post'; draft: DraftedReviewResult; headSha: string; viewerLogin: string };

interface DecideApprovalActionParams {
	tracked: TrackedPullRequest;
	live: Pick<LivePullRequest, 'headSha' | 'state'>;
	viewerLogin: string | null;
}

export const decideApprovalAction = ({
	tracked,
	live,
	viewerLogin,
}: DecideApprovalActionParams): ApprovalAction => {
	const pendingApproval = tracked.pendingApproval;

	if (!DRAFT_HOLDING_STATUSES.has(tracked.status) || pendingApproval === null) {
		return { kind: 'not_awaiting_approval' };
	}

	if (viewerLogin === null) {
		return { kind: 'not_ready' };
	}

	if (live.state === 'closed') {
		return { kind: 'closed' };
	}

	if (live.headSha !== pendingApproval.headSha) {
		return { kind: 'head_moved' };
	}

	return {
		kind: 'post',
		draft: pendingApproval.draft,
		headSha: pendingApproval.headSha,
		viewerLogin,
	};
};
