import { describe, expect, it } from 'bun:test';
import { makeDraft } from '../test-support/factories.js';
import { createBotMarker } from './bot-marker.js';
import { buildReviewPayload } from './review-payload.js';

describe('buildReviewPayload', () => {
	it('normal COMMENT payload', () => {
		const payload = buildReviewPayload({
			draft: makeDraft({
				comments: [
					{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'Right side' },
					{ path: 'b.ts', line: 9, side: 'LEFT', body: 'Left side' },
				],
				fileComments: [{ path: 'c.ts', body: 'Whole file' }],
			}),
			event: 'COMMENT',
			headSha: 'head-1',
			shouldFoldInlineComments: false,
		});

		expect(payload).toMatchSnapshot();
	});

	it('marker on every body (main, inline, file)', () => {
		const payload = buildReviewPayload({
			draft: makeDraft({ fileComments: [{ path: 'c.ts', body: 'Whole file' }] }),
			event: 'COMMENT',
			headSha: 'head-9',
			shouldFoldInlineComments: false,
		});
		const bodies = [
			payload.review.body,
			...payload.review.comments.map((comment) => comment.body),
			...payload.fileComments.map((comment) => comment.body),
		];

		for (const body of bodies) {
			expect(body).toContain(createBotMarker('head-9'));
		}
	});

	it('empty COMMENT with no comments still gets a body', () => {
		const payload = buildReviewPayload({
			draft: makeDraft({ mainReview: '', comments: [] }),
			event: 'COMMENT',
			headSha: 'head-1',
			shouldFoldInlineComments: false,
		});

		expect(payload.review.body.startsWith('Reviewed, no further comments.')).toBe(true);
	});

	it('APPROVE with an empty main review uses the summary', () => {
		const payload = buildReviewPayload({
			draft: makeDraft({ mainReview: '', summary: 'Logic is sound' }),
			event: 'APPROVE',
			headSha: 'head-1',
			shouldFoldInlineComments: false,
		});

		expect(payload.review.body.startsWith('Logic is sound')).toBe(true);
	});

	it('folded mode → no inline comments, each one in the body with path:line', () => {
		const payload = buildReviewPayload({
			draft: makeDraft(),
			event: 'COMMENT',
			headSha: 'head-1',
			shouldFoldInlineComments: true,
		});

		expect(payload.review.comments).toEqual([]);
		expect(payload.review.body).toContain('**src/retry.ts:12**');
		expect(payload).toMatchSnapshot();
	});
});
