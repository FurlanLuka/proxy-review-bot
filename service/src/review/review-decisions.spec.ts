import { describe, expect, it } from 'bun:test';
import { ANCHOR_TIME, makeDraft, makeLive, makeTracked } from '../test-support/factories.js';
import {
	isDecisionDeferred,
	isOwnPullRequest,
	isViewerRequested,
	decideApprovalAction,
	decidePostingAction,
	decidePullRequestAction,
	MAX_ATTEMPTS_PER_HEAD,
	QUIET_PERIOD_MS,
} from './review-decisions.js';

const AUTO = { reviewMode: 'auto', maxRounds: 5 } as const;
const MANUAL = { reviewMode: 'manual', maxRounds: 5 } as const;

const decide = (overrides: Partial<Parameters<typeof decidePullRequestAction>[0]> = {}) => {
	return decidePullRequestAction({
		tracked: makeTracked(),
		live: makeLive(),
		isRequestedNow: true,
		myReviewState: 'none',
		hasManualReview: false,
		settings: AUTO,
		isPaused: false,
		now: ANCHOR_TIME,
		...overrides,
	});
};

describe('decidePullRequestAction', () => {
	it('new PR in auto mode → enqueue', () => {
		expect(decide()).toEqual({ kind: 'enqueue' });
	});

	it('manual mode, review already started: new commits and elapsed backoff enqueue, never needs review', () => {
		const started = { firstQueuedAt: ANCHOR_TIME - 3 * 60 * 60_000 };

		expect(
			decide({
				settings: MANUAL,
				tracked: makeTracked({
					...started,
					status: 'waiting_on_author',
					lastReviewedHead: 'head-0',
				}),
			}),
		).toEqual({ kind: 'enqueue' });
		expect(
			decide({
				settings: MANUAL,
				tracked: makeTracked({
					...started,
					status: 'waiting_on_author',
					lastError: 'timed out',
					nextEligibleAt: ANCHOR_TIME - 1,
				}),
			}),
		).toEqual({ kind: 'enqueue' });
	});

	it('started review re-requested on the same commit → a new round; at the round limit → give up', () => {
		const reRequested = {
			status: 'waiting_on_author' as const,
			firstQueuedAt: 1,
			isRequested: false,
			lastReviewedHead: 'head-1',
			rounds: 1,
		};

		expect(decide({ settings: MANUAL, tracked: makeTracked(reRequested) })).toEqual({
			kind: 'enqueue',
		});
		expect(
			decide({ settings: MANUAL, tracked: makeTracked({ ...reRequested, status: 'blocked' }) }),
		).toEqual({ kind: 'enqueue' });
		expect(
			decide({ settings: MANUAL, tracked: makeTracked({ ...reRequested, rounds: 5 }) }),
		).toEqual({ kind: 'give_up', reason: 'Gave up after 5 rounds' });
		expect(
			decide({
				settings: MANUAL,
				tracked: makeTracked({ ...reRequested, firstQueuedAt: null }),
			}),
		).toEqual({ kind: 'none' });
	});

	it('new PR in manual mode → mark needs review, then nothing once marked', () => {
		expect(
			decide({ settings: MANUAL, tracked: makeTracked({ status: 'waiting_on_author' }) }),
		).toEqual({ kind: 'mark_needs_review' });
		expect(decide({ settings: MANUAL })).toEqual({ kind: 'none' });
	});

	it('merged → finish merged; closed → finish closed; already done → none', () => {
		expect(decide({ live: makeLive({ state: 'closed', isMerged: true }) })).toEqual({
			kind: 'finish',
			reason: 'merged',
		});
		expect(decide({ live: makeLive({ state: 'closed' }) })).toEqual({
			kind: 'finish',
			reason: 'closed',
		});
		expect(
			decide({ live: makeLive({ state: 'closed' }), tracked: makeTracked({ status: 'done' }) }),
		).toEqual({ kind: 'none' });
	});

	it('merged while awaiting approval → finish', () => {
		const tracked = makeTracked({ status: 'awaiting_approval', lastReviewedHead: 'head-1' });

		expect(decide({ tracked, live: makeLive({ state: 'closed', isMerged: true }) }).kind).toBe(
			'finish',
		);
	});

	it('developer approved → finish approved', () => {
		expect(decide({ myReviewState: 'approved' })).toEqual({ kind: 'finish', reason: 'approved' });
	});

	it('developer posted their own review → take over', () => {
		expect(decide({ hasManualReview: true })).toEqual({ kind: 'take_over' });
	});

	it('terminal PR re-requested → reopen; still requested → none', () => {
		const stopped = makeTracked({ status: 'stopped', isRequested: false });

		expect(decide({ tracked: stopped })).toEqual({ kind: 'reopen' });
		expect(decide({ tracked: makeTracked({ status: 'stopped', isRequested: true }) })).toEqual({
			kind: 'none',
		});
		expect(decide({ tracked: makeTracked({ status: 'done' }), isRequestedNow: false })).toEqual({
			kind: 'none',
		});
	});

	it('queued, reviewing or paused → none', () => {
		expect(decide({ tracked: makeTracked({ status: 'queued' }) })).toEqual({ kind: 'none' });
		expect(decide({ tracked: makeTracked({ status: 'reviewing' }) })).toEqual({ kind: 'none' });
		expect(decide({ isPaused: true })).toEqual({ kind: 'none' });
	});

	it('head unchanged since last review → none (no re-review every tick)', () => {
		const tracked = makeTracked({ status: 'waiting_on_author', lastReviewedHead: 'head-1' });

		expect(decide({ tracked })).toEqual({ kind: 'none' });
	});

	it('blocked on the same head → none; new head → reviews again', () => {
		const tracked = makeTracked({ status: 'blocked', lastAttemptedHead: 'head-1' });

		expect(decide({ tracked })).toEqual({ kind: 'none' });
		expect(decide({ tracked, live: makeLive({ headSha: 'head-2' }) })).toEqual({ kind: 'enqueue' });
	});

	it('failed twice on the same head → give up', () => {
		const tracked = makeTracked({
			status: 'waiting_on_author',
			lastAttemptedHead: 'head-1',
			attemptsForHead: MAX_ATTEMPTS_PER_HEAD,
		});

		expect(decide({ tracked }).kind).toBe('give_up');
	});

	it('backoff not elapsed → none; elapsed → enqueue', () => {
		const tracked = makeTracked({
			status: 'waiting_on_author',
			lastAttemptedHead: 'head-1',
			attemptsForHead: 1,
			nextEligibleAt: ANCHOR_TIME + 1,
		});

		expect(decide({ tracked })).toEqual({ kind: 'none' });
		expect(decide({ tracked, now: ANCHOR_TIME + 2 })).toEqual({ kind: 'enqueue' });
	});

	it('rounds at max with a new head → give up; head unchanged → none', () => {
		const tracked = makeTracked({
			status: 'waiting_on_author',
			rounds: 5,
			lastReviewedHead: 'head-1',
		});

		expect(decide({ tracked })).toEqual({ kind: 'none' });
		expect(decide({ tracked, live: makeLive({ headSha: 'head-2' }) })).toEqual({
			kind: 'give_up',
			reason: 'Gave up after 5 rounds',
		});
	});

	it('re-review inside the quiet period → none; after it → enqueue', () => {
		const tracked = makeTracked({
			status: 'waiting_on_author',
			rounds: 1,
			lastReviewedHead: 'head-1',
			headChangedAt: ANCHOR_TIME - 60_000,
		});
		const live = makeLive({ headSha: 'head-2' });

		expect(decide({ tracked, live })).toEqual({ kind: 'none' });
		expect(decide({ tracked, live, now: ANCHOR_TIME + QUIET_PERIOD_MS })).toEqual({
			kind: 'enqueue',
		});
	});

	it('head moved while awaiting approval → clear the approval at once, even inside the quiet period', () => {
		const tracked = makeTracked({
			status: 'awaiting_approval',
			lastReviewedHead: 'head-1',
			headChangedAt: ANCHOR_TIME,
		});

		expect(decide({ tracked, live: makeLive({ headSha: 'head-2' }) })).toEqual({
			kind: 'clear_approval',
		});
	});

	it('head moved while a draft is ready → clear it', () => {
		const tracked = makeTracked({
			status: 'draft_ready',
			lastReviewedHead: 'head-1',
			headChangedAt: ANCHOR_TIME,
		});

		expect(decide({ tracked, live: makeLive({ headSha: 'head-2' }) })).toEqual({
			kind: 'clear_approval',
		});
	});

	it('PR converted back to draft → none', () => {
		expect(decide({ live: makeLive({ isDraft: true }) })).toEqual({ kind: 'none' });
	});
});

const decidePosting = (overrides: Partial<Parameters<typeof decidePostingAction>[0]> = {}) => {
	return decidePostingAction({
		result: makeDraft(),
		jobHeadSha: 'head-1',
		jobBaseRefName: 'main',
		live: { headSha: 'head-1', baseRefName: 'main', state: 'open' },
		settings: { autoApprove: 'off', smallPullRequestLineLimit: 100, postReviews: 'auto' },
		changedLines: 50,
		isOwn: false,
		...overrides,
	});
};

describe('decidePostingAction by Post reviews and Auto-approve', () => {
	const approve = makeDraft({ filing: 'approve' });
	const comment = makeDraft({ filing: 'comment' });

	it.each([
		['ask', 'off', comment, 50, 'hold_draft'],
		['ask', 'on', approve, 50, 'hold_draft'],
		['auto', 'off', comment, 50, 'post COMMENT'],
		['auto', 'off', approve, 50, 'await_approval'],
		['auto', 'on', approve, 50, 'post APPROVE'],
		['auto', 'small', approve, 99, 'post APPROVE'],
		['auto', 'small', approve, 100, 'await_approval'],
	] as const)(
		'Post reviews %s, Auto-approve %s, %o filing, %i changed lines → %s',
		(postReviews, autoApprove, result, changedLines, expected) => {
			const action = decidePosting({
				result,
				changedLines,
				settings: { autoApprove, smallPullRequestLineLimit: 100, postReviews },
			});
			const label = action.kind === 'post' ? `post ${action.event}` : action.kind;

			expect(label).toBe(expected);
		},
	);
});

describe('isViewerRequested', () => {
	it('viewer among requested reviewers, any case → true; absent → false', () => {
		const live = makeLive({ requestedReviewerLogins: ['Luka', 'ana'] });

		expect(isViewerRequested({ live, viewerLogin: 'luka' })).toBe(true);
		expect(isViewerRequested({ live: makeLive(), viewerLogin: 'luka' })).toBe(false);
	});
});

describe('isDecisionDeferred', () => {
	it('paused, running or draft → deferred; closed or finished → never deferred', () => {
		const live = makeLive();

		expect(isDecisionDeferred({ tracked: makeTracked(), live, isPaused: true })).toBe(true);
		expect(
			isDecisionDeferred({ tracked: makeTracked({ status: 'reviewing' }), live, isPaused: false }),
		).toBe(true);
		expect(
			isDecisionDeferred({
				tracked: makeTracked(),
				live: makeLive({ isDraft: true }),
				isPaused: false,
			}),
		).toBe(true);
		expect(isDecisionDeferred({ tracked: makeTracked(), live, isPaused: false })).toBe(false);
		expect(
			isDecisionDeferred({
				tracked: makeTracked(),
				live: makeLive({ state: 'closed' }),
				isPaused: true,
			}),
		).toBe(false);
		expect(
			isDecisionDeferred({ tracked: makeTracked({ status: 'done' }), live, isPaused: true }),
		).toBe(false);
	});
});

describe('isOwnPullRequest', () => {
	it.each([
		['luka', 'luka', true],
		['Luka', 'luka', true],
		['luka', 'LUKA', true],
		['ana', 'luka', false],
		['luka', null, false],
	])('author %s, viewer %s → %s', (author, viewerLogin, expected) => {
		expect(isOwnPullRequest({ author, viewerLogin })).toBe(expected);
	});
});

describe('decidePostingAction on your own PR', () => {
	const approveDraft = makeDraft({ filing: 'approve' });

	it('posting automatically with auto-approve on and an approve filing → posts COMMENT', () => {
		expect(
			decidePosting({
				result: approveDraft,
				isOwn: true,
				settings: { autoApprove: 'on', smallPullRequestLineLimit: 100, postReviews: 'auto' },
			}),
		).toMatchObject({ kind: 'post', event: 'COMMENT', draft: { filing: 'comment' } });
	});

	it('posting automatically with auto-approve off and an approve filing → posts COMMENT, never waits to approve', () => {
		expect(decidePosting({ result: approveDraft, isOwn: true })).toMatchObject({
			kind: 'post',
			event: 'COMMENT',
		});
	});

	it('Post reviews on Ask me first and an approve filing → the held draft is a comment', () => {
		expect(
			decidePosting({
				result: approveDraft,
				isOwn: true,
				settings: { autoApprove: 'off', smallPullRequestLineLimit: 100, postReviews: 'ask' },
			}),
		).toMatchObject({ kind: 'hold_draft', draft: { filing: 'comment' } });
	});
});

describe('decidePostingAction', () => {
	it('comment filing → post COMMENT', () => {
		expect(decidePosting()).toMatchObject({ kind: 'post', event: 'COMMENT' });
	});

	it('auto-approve on + comment filing → still COMMENT, never approves', () => {
		expect(
			decidePosting({
				settings: { autoApprove: 'on', smallPullRequestLineLimit: 100, postReviews: 'auto' },
			}),
		).toMatchObject({ kind: 'post', event: 'COMMENT' });
	});

	it('approve filing with auto-approve off → await approval', () => {
		expect(decidePosting({ result: makeDraft({ filing: 'approve' }) })).toMatchObject({
			kind: 'await_approval',
		});
	});

	it('small threshold: N−1 → approve, N → await, 0 → approve', () => {
		const settings = {
			autoApprove: 'small',
			smallPullRequestLineLimit: 100,
			postReviews: 'auto',
		} as const;
		const result = makeDraft({ filing: 'approve' });

		expect(decidePosting({ result, settings, changedLines: 99 })).toMatchObject({
			kind: 'post',
			event: 'APPROVE',
		});
		expect(decidePosting({ result, settings, changedLines: 100 })).toMatchObject({
			kind: 'await_approval',
		});
		expect(decidePosting({ result, settings, changedLines: 0 })).toMatchObject({
			kind: 'post',
			event: 'APPROVE',
		});
	});

	it('live head moved, base changed or PR closed → discard the draft', () => {
		expect(
			decidePosting({ live: { headSha: 'head-2', baseRefName: 'main', state: 'open' } }).kind,
		).toBe('discard_draft');
		expect(
			decidePosting({ live: { headSha: 'head-1', baseRefName: 'develop', state: 'open' } }).kind,
		).toBe('discard_draft');
		expect(
			decidePosting({ live: { headSha: 'head-1', baseRefName: 'main', state: 'closed' } }).kind,
		).toBe('discard_draft');
	});

	it('Claude reviewed a different commit while the live head is unchanged → fail (counts as an attempt)', () => {
		expect(decidePosting({ result: makeDraft({ headRefOid: 'abc1234' }) })).toEqual({
			kind: 'fail',
			summary: 'Review was for abc1234, not head-1',
		});
	});

	it('Post reviews on Ask me first → hold the draft for the developer, for comment and approve filings', () => {
		const settings = {
			autoApprove: 'on',
			smallPullRequestLineLimit: 100,
			postReviews: 'ask',
		} as const;
		const commentDraft = makeDraft();
		const approveDraft = makeDraft({ filing: 'approve' });

		expect(decidePosting({ settings, result: commentDraft })).toEqual({
			kind: 'hold_draft',
			draft: commentDraft,
		});
		expect(decidePosting({ settings, result: approveDraft })).toEqual({
			kind: 'hold_draft',
			draft: approveDraft,
		});
	});

	it('Post reviews on Ask me first still records nothing new and discards a moved head', () => {
		const settings = {
			autoApprove: 'off',
			smallPullRequestLineLimit: 100,
			postReviews: 'ask',
		} as const;

		expect(
			decidePosting({
				settings,
				result: { outcome: 'nothing_new', headRefOid: 'head-1', summary: 'Same' },
			}).kind,
		).toBe('record_nothing_new');
		expect(
			decidePosting({ settings, live: { headSha: 'head-2', baseRefName: 'main', state: 'open' } })
				.kind,
		).toBe('discard_draft');
	});

	it('post and await_approval carry the draft', () => {
		const draft = makeDraft({ filing: 'approve' });

		expect(decidePosting({ result: draft })).toEqual({ kind: 'await_approval', draft });
	});

	it('only the target tip drifted → still posts', () => {
		expect(decidePosting({ result: makeDraft({ targetTipOid: 'old-tip' }) })).toMatchObject({
			kind: 'post',
			event: 'COMMENT',
		});
	});

	it('nothing new, blocked, failed outcomes', () => {
		expect(
			decidePosting({ result: { outcome: 'nothing_new', headRefOid: 'head-1', summary: 'Same' } }),
		).toEqual({ kind: 'record_nothing_new', summary: 'Same' });
		expect(
			decidePosting({ result: { outcome: 'blocked', reason: 'diff_mismatch', summary: 'Odd' } }),
		).toEqual({ kind: 'block', summary: "Diff didn't match GitHub: Odd" });
		expect(decidePosting({ result: { outcome: 'failed', summary: 'Boom' } })).toEqual({
			kind: 'fail',
			summary: 'Boom',
		});
	});
});

describe('decideApprovalAction', () => {
	const draft = makeDraft({ filing: 'approve' });
	const awaiting = makeTracked({
		status: 'awaiting_approval',
		pendingApproval: { headSha: 'head-1', draft },
	});

	it('pending approval on the live head → post that draft', () => {
		expect(
			decideApprovalAction({ tracked: awaiting, live: makeLive(), viewerLogin: 'luka' }),
		).toEqual({ kind: 'post', draft, headSha: 'head-1', viewerLogin: 'luka' });
	});

	it('head moved → head_moved; closed → closed', () => {
		expect(
			decideApprovalAction({
				tracked: awaiting,
				live: makeLive({ headSha: 'head-2' }),
				viewerLogin: 'luka',
			}).kind,
		).toBe('head_moved');
		expect(
			decideApprovalAction({
				tracked: awaiting,
				live: makeLive({ state: 'closed' }),
				viewerLogin: 'luka',
			}).kind,
		).toBe('closed');
	});

	it('unknown viewer → not_ready (keeps the draft); not awaiting → not_awaiting_approval', () => {
		expect(
			decideApprovalAction({ tracked: awaiting, live: makeLive(), viewerLogin: null }).kind,
		).toBe('not_ready');
		expect(
			decideApprovalAction({ tracked: makeTracked(), live: makeLive(), viewerLogin: 'luka' }).kind,
		).toBe('not_awaiting_approval');
	});
});
