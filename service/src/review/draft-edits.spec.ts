import { describe, expect, it } from 'bun:test';
import { makeDraft } from '../test-support/factories.js';
import type { DraftedReviewResult } from './review-result.js';
import { applyDraftEdits, OWN_PULL_REQUEST_REASON } from './draft-edits.js';

const applyDraftEditsTo = (target: DraftedReviewResult, candidate: unknown) => {
	return applyDraftEdits({ draft: target, draftHeadSha: 'head-1', candidate, isOwn: false });
};

const draft = makeDraft({
	filing: 'approve',
	comments: [
		{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'One' },
		{ path: 'b.ts', line: 9, side: 'LEFT', body: 'Two' },
	],
	fileComments: [{ path: 'c.ts', body: 'Whole file' }],
});

const edit = (overrides: Record<string, unknown> = {}) => ({
	headSha: 'head-1',
	event: 'COMMENT',
	mainReview: 'Edited main',
	comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'Edited one' }],
	fileComments: [],
	...overrides,
});

describe('applyDraftEdits', () => {
	it('edited text and dropped comments → the posted draft has exactly that', () => {
		const result = applyDraftEditsTo(draft, edit());

		expect(result).toEqual({
			kind: 'valid',
			event: 'COMMENT',
			draft: {
				...draft,
				mainReview: 'Edited main',
				comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'Edited one' }],
				fileComments: [],
			},
		});
	});

	it('approve filing → APPROVE allowed; comment filing → APPROVE rejected', () => {
		expect(applyDraftEditsTo(draft, edit({ event: 'APPROVE' })).kind).toBe('valid');
		expect(
			applyDraftEditsTo(makeDraft({ filing: 'comment' }), edit({ event: 'APPROVE', comments: [] })),
		).toEqual({
			kind: 'invalid',
			reason: 'this draft cannot approve',
		});
	});

	it('an invented anchor or side → invalid', () => {
		expect(
			applyDraftEditsTo(
				draft,
				edit({ comments: [{ path: 'a.ts', line: 4, side: 'RIGHT', body: 'x' }] }),
			).kind,
		).toBe('invalid');
		expect(
			applyDraftEditsTo(
				draft,
				edit({ comments: [{ path: 'a.ts', line: 3, side: 'LEFT', body: 'x' }] }),
			).kind,
		).toBe('invalid');
		expect(
			applyDraftEditsTo(draft, edit({ fileComments: [{ path: 'z.ts', body: 'x' }] })).kind,
		).toBe('invalid');
	});

	it('empty comment body, unknown event or extra keys → invalid', () => {
		expect(
			applyDraftEditsTo(
				draft,
				edit({ comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: '  ' }] }),
			).kind,
		).toBe('invalid');
		expect(applyDraftEditsTo(draft, edit({ event: 'DISMISS' })).kind).toBe('invalid');
		expect(applyDraftEditsTo(draft, { ...edit(), surprise: true }).kind).toBe('invalid');
	});

	it('edits made against an older draft head → stale, even when anchors match', () => {
		expect(applyDraftEditsTo(draft, edit({ headSha: 'head-0' }))).toEqual({ kind: 'stale' });
	});

	it('a cleared comment body → invalid with a reason the app can show', () => {
		expect(
			applyDraftEditsTo(
				draft,
				edit({ comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: ' ' }] }),
			),
		).toEqual({
			kind: 'invalid',
			reason: 'a comment is empty',
		});
	});

	it('an over-long comment → "too long", not "empty"', () => {
		const longBody = 'x'.repeat(65_001);

		expect(
			applyDraftEditsTo(
				draft,
				edit({ comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: longBody }] }),
			),
		).toEqual({ kind: 'invalid', reason: 'a comment is too long' });
	});

	it('REQUEST_CHANGES is allowed whatever the filing', () => {
		expect(
			applyDraftEditsTo(
				makeDraft({ filing: 'comment' }),
				edit({ event: 'REQUEST_CHANGES', comments: [] }),
			).kind,
		).toBe('valid');
		expect(applyDraftEditsTo(draft, edit({ event: 'REQUEST_CHANGES' })).kind).toBe('valid');
	});

	it('REQUEST_CHANGES with no main review and no comments → invalid', () => {
		const requestChanges = (overrides: Record<string, unknown>) => {
			return applyDraftEditsTo(
				draft,
				edit({ event: 'REQUEST_CHANGES', comments: [], ...overrides }),
			);
		};

		expect(requestChanges({ mainReview: '' })).toEqual({
			kind: 'invalid',
			reason: 'requesting changes needs a comment',
		});
		expect(requestChanges({ mainReview: '   ' }).kind).toBe('invalid');
		expect(
			requestChanges({
				mainReview: '',
				comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'Fix' }],
			}).kind,
		).toBe('valid');
		expect(
			requestChanges({ mainReview: '', fileComments: [{ path: 'c.ts', body: 'Fix' }] }).kind,
		).toBe('valid');
	});

	it('your own PR → only COMMENT is accepted', () => {
		const ownEdit = (event: string) => {
			return applyDraftEdits({
				draft,
				draftHeadSha: 'head-1',
				candidate: edit({ event }),
				isOwn: true,
			});
		};

		expect(ownEdit('APPROVE')).toEqual({ kind: 'invalid', reason: OWN_PULL_REQUEST_REASON });
		expect(ownEdit('REQUEST_CHANGES')).toEqual({
			kind: 'invalid',
			reason: OWN_PULL_REQUEST_REASON,
		});
		expect(ownEdit('COMMENT').kind).toBe('valid');
	});
});
