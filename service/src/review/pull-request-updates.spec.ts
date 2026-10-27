import { describe, expect, it } from 'bun:test';
import { ANCHOR_TIME, makeDraft, makeLive, makeTracked } from '../test-support/factories.js';
import {
	CLEARED_REPAIR_SESSION,
	buildActionUpdate,
	buildLiveUpdate,
	buildPostingUpdate,
	buildReviewCycleReset,
} from './pull-request-updates.js';
import { RETRY_BACKOFF_MS } from './review-decisions.js';

const tracked = makeTracked({ status: 'reviewing', rounds: 2, attemptsForHead: 1 });

const posting = (action: Parameters<typeof buildPostingUpdate>[0]['action']) => {
	return buildPostingUpdate({ action, tracked, jobHeadSha: 'head-1', now: ANCHOR_TIME });
};

describe('buildPostingUpdate', () => {
	it('posted COMMENT → waiting on author, round +1, head reviewed, request cleared', () => {
		expect(posting({ kind: 'posted', event: 'COMMENT', summary: 'S' })).toMatchObject({
			status: 'waiting_on_author',
			rounds: 3,
			lastReviewedHead: 'head-1',
			lastSummary: 'S',
			attemptsForHead: 0,
			isRequested: false,
		});
	});

	it('posted APPROVE → done, request cleared', () => {
		expect(posting({ kind: 'posted', event: 'APPROVE', summary: 'S' })).toMatchObject({
			status: 'done',
			isRequested: false,
		});
	});

	it('await approval → stores the draft, rounds unchanged', () => {
		const draft = makeDraft({ filing: 'approve' });
		const update = posting({ kind: 'await_approval', draft });

		expect(update).toMatchObject({
			status: 'awaiting_approval',
			pendingApproval: { headSha: 'head-1', draft },
		});
		expect(update.rounds).toBeUndefined();
	});

	it('nothing new → head reviewed, rounds unchanged', () => {
		const update = posting({ kind: 'record_nothing_new', summary: 'Same' });

		expect(update).toMatchObject({ status: 'waiting_on_author', lastReviewedHead: 'head-1' });
		expect(update.rounds).toBeUndefined();
	});

	it('fail → backoff and the error kept; discard → attempts reset', () => {
		expect(posting({ kind: 'fail', summary: 'Boom' })).toMatchObject({
			lastError: 'Boom',
			nextEligibleAt: ANCHOR_TIME + RETRY_BACKOFF_MS,
		});
		expect(posting({ kind: 'discard_draft' })).toMatchObject({
			attemptsForHead: 0,
			lastAttemptedHead: null,
		});
	});
});

describe('buildActionUpdate', () => {
	it('reopen → a fresh review cycle that ignores older reviews', () => {
		expect(buildActionUpdate({ kind: 'reopen' }, tracked, ANCHOR_TIME)).toEqual({
			...buildReviewCycleReset(ANCHOR_TIME),
			...CLEARED_REPAIR_SESSION,
			status: 'needs_review',
			firstQueuedAt: tracked.firstQueuedAt,
		});
		expect(buildReviewCycleReset(ANCHOR_TIME).trackedSince).toBe(ANCHOR_TIME);
	});

	it('reopen keeps a started review started, unless you had stopped it', () => {
		const gaveUp = makeTracked({ status: 'needs_you', firstQueuedAt: 5 });
		const stopped = makeTracked({ status: 'stopped', firstQueuedAt: 5 });

		expect(buildActionUpdate({ kind: 'reopen' }, gaveUp, ANCHOR_TIME)?.firstQueuedAt).toBe(5);
		expect(buildActionUpdate({ kind: 'reopen' }, stopped, ANCHOR_TIME)?.firstQueuedAt).toBeNull();
	});

	it('finish, take over and reopen → the saved repair session is cleared', () => {
		const withSession = makeTracked({
			repairSessionId: 'session-1',
			repairHeadSha: 'head-1',
			repairSavedAt: 5,
		});

		for (const action of [
			{ kind: 'finish' as const, reason: 'merged' as const },
			{ kind: 'take_over' as const },
			{ kind: 'reopen' as const },
		]) {
			expect(buildActionUpdate(action, withSession, ANCHOR_TIME)).toMatchObject(
				CLEARED_REPAIR_SESSION,
			);
		}
	});

	it('give up keeps the saved repair session, so Review Again can still resume it', () => {
		const withSession = makeTracked({
			repairSessionId: 'session-1',
			repairHeadSha: 'head-1',
			repairSavedAt: 5,
		});
		const update = buildActionUpdate(
			{ kind: 'give_up', reason: 'Review failed 2 times on this commit' },
			withSession,
			ANCHOR_TIME,
		);

		expect(update).not.toHaveProperty('repairSessionId');
		expect(update).not.toHaveProperty('repairHeadSha');
		expect(update).not.toHaveProperty('repairSavedAt');
	});

	it('enqueue marks the review started the first time only', () => {
		expect(buildActionUpdate({ kind: 'enqueue' }, makeTracked(), ANCHOR_TIME)?.firstQueuedAt).toBe(
			ANCHOR_TIME,
		);
		expect(
			buildActionUpdate({ kind: 'enqueue' }, makeTracked({ firstQueuedAt: 5 }), ANCHOR_TIME)
				?.firstQueuedAt,
		).toBe(5);
	});

	it('mark needs review keeps the last error only after a failed attempt', () => {
		const failed = makeTracked({ status: 'waiting_on_author', lastError: 'timed out' });
		const fresh = makeTracked({ status: 'needs_review', lastError: 'old' });

		expect(buildActionUpdate({ kind: 'mark_needs_review' }, failed, 0)?.lastError).toBe(
			'timed out',
		);
		expect(buildActionUpdate({ kind: 'mark_needs_review' }, fresh, 0)?.lastError).toBeNull();
	});

	it('none → no update', () => {
		expect(buildActionUpdate({ kind: 'none' }, tracked, 0)).toBeNull();
	});
});

describe('buildLiveUpdate', () => {
	it('head unchanged keeps headChangedAt; new head bumps it', () => {
		const base = makeTracked({ headSha: 'head-1', headChangedAt: 5 });

		expect(
			buildLiveUpdate({ tracked: base, live: makeLive(), isRequestedNow: true, now: 99 })
				.headChangedAt,
		).toBe(5);
		expect(
			buildLiveUpdate({
				tracked: base,
				live: makeLive({ headSha: 'head-2' }),
				isRequestedNow: false,
				now: 99,
			}),
		).toMatchObject({ headChangedAt: 99, isRequested: false, headSha: 'head-2' });
	});
});
