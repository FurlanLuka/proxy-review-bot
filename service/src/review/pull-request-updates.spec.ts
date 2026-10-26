import { describe, expect, it } from 'bun:test';
import { ANCHOR_TIME, makeDraft, makeLive, makeTracked } from '../test-support/factories.js';
import {
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
	it('posted COMMENT → waiting on author, round +1, head reviewed', () => {
		expect(posting({ kind: 'posted', event: 'COMMENT', summary: 'S' })).toMatchObject({
			status: 'waiting_on_author',
			rounds: 3,
			lastReviewedHead: 'head-1',
			lastSummary: 'S',
			attemptsForHead: 0,
		});
	});

	it('posted APPROVE → done', () => {
		expect(posting({ kind: 'posted', event: 'APPROVE', summary: 'S' }).status).toBe('done');
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
			status: 'needs_review',
		});
		expect(buildReviewCycleReset(ANCHOR_TIME).trackedSince).toBe(ANCHOR_TIME);
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
