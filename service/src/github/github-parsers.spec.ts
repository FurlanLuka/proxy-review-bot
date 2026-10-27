import { describe, expect, it } from 'bun:test';
import { makeReview } from '../test-support/factories.js';
import pullRequestFixture from './fixtures/pull-request.json';
import reviewThreadsFixture from './fixtures/review-threads.json';
import reviewsFixture from './fixtures/reviews.json';
import searchFixture from './fixtures/search.json';
import {
	hasManualReview,
	isRepositoryIncluded,
	parseMyReviewState,
	parsePullRequest,
	parseReviewPages,
	parseReviewThreads,
	parseSearchResults,
} from './github-parsers.js';

describe('recorded gh fixtures', () => {
	it('search results → owner/repo from repository_url', () => {
		const [first] = parseSearchResults(searchFixture);

		expect(first?.owner).toBe('cli');
		expect(first?.repo).toBe('cli');
		expect(first?.url).toContain('/pull/');
	});

	it('search results skip drafts', () => {
		const withDraft = {
			items: [{ ...searchFixture.items[0], draft: true }, ...searchFixture.items.slice(1)],
		};

		expect(parseSearchResults(withDraft)).toHaveLength(searchFixture.items.length - 1);
	});

	it('pull request → head, base and line counts', () => {
		const live = parsePullRequest({ json: pullRequestFixture, owner: 'cli', repo: 'cli' });

		expect(live.headSha).toBe(pullRequestFixture.head.sha);
		expect(live.baseRefName).toBe('trunk');
		expect(live.state).toBe('closed');
		expect(live.isMerged).toBe(true);
		expect(live.requestedReviewerLogins).toEqual([]);
	});

	it('owner and repo come from the response, not the link that was asked for', () => {
		const live = parsePullRequest({
			json: {
				...pullRequestFixture,
				base: { ...pullRequestFixture.base, repo: { full_name: 'Acme/API' } },
			},
			owner: 'old-name',
			repo: 'old-api',
		});

		expect([live.owner, live.repo]).toEqual(['Acme', 'API']);
	});

	it('pull request with requested reviewers → their logins', () => {
		const live = parsePullRequest({
			json: { ...pullRequestFixture, requested_reviewers: [{ login: 'Luka' }, { login: 'ana' }] },
			owner: 'cli',
			repo: 'cli',
		});

		expect(live.requestedReviewerLogins).toEqual(['Luka', 'ana']);
	});

	it('slurped review pages → flat list with author type', () => {
		const reviews = parseReviewPages(reviewsFixture);

		expect(reviews.length).toBe(reviewsFixture.flat().length);
		expect(reviews.some((review) => review.authorType === 'Bot')).toBe(true);
	});

	it('review threads → comments with author typename', () => {
		const [thread] = parseReviewThreads(reviewThreadsFixture);

		expect(thread?.path).toBe('internal/attachments/client.go');
		expect(thread?.comments[0]?.authorType).toBe('User');
	});
});

describe('parseMyReviewState', () => {
	it('[APPROVED, COMMENTED] → approved (a later comment does not revoke)', () => {
		const reviews = [
			makeReview({ state: 'APPROVED', submittedAt: '2026-10-26T10:00:00Z' }),
			makeReview({ state: 'COMMENTED', submittedAt: '2026-10-26T11:00:00Z' }),
		];

		expect(parseMyReviewState(reviews, 'luka')).toBe('approved');
	});

	it('[APPROVED, DISMISSED] → dismissed', () => {
		const reviews = [
			makeReview({ state: 'APPROVED', submittedAt: '2026-10-26T10:00:00Z' }),
			makeReview({ state: 'DISMISSED', submittedAt: '2026-10-26T11:00:00Z' }),
		];

		expect(parseMyReviewState(reviews, 'luka')).toBe('dismissed');
	});

	it('only approvals by others → none', () => {
		expect(
			parseMyReviewState([makeReview({ state: 'APPROVED', authorLogin: 'ana' })], 'luka'),
		).toBe('none');
	});

	it('order by submission time, not array order', () => {
		const reviews = [
			makeReview({ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-26T12:00:00Z' }),
			makeReview({ state: 'APPROVED', submittedAt: '2026-10-26T10:00:00Z' }),
		];

		expect(parseMyReviewState(reviews, 'luka')).toBe('changes_requested');
	});
});

describe('hasManualReview', () => {
	it('my review with a body and no bot marker → true', () => {
		expect(hasManualReview([makeReview({ body: 'Looks off' })], 'luka')).toBe(true);
	});

	it('my bot-marked review → false', () => {
		const body = 'Fine\n<!-- proxy-review-bot head=abc -->';

		expect(hasManualReview([makeReview({ body })], 'luka')).toBe(false);
	});

	it('empty COMMENTED record (a thread reply) → false', () => {
		expect(hasManualReview([makeReview({ body: '' })], 'luka')).toBe(false);
	});

	it('my empty-body approval → true', () => {
		expect(hasManualReview([makeReview({ state: 'APPROVED' })], 'luka')).toBe(true);
	});

	it("someone else's review → false", () => {
		expect(hasManualReview([makeReview({ body: 'Hmm', authorLogin: 'ana' })], 'luka')).toBe(false);
	});
});

describe('isRepositoryIncluded', () => {
	it('empty watch list → every repo', () => {
		expect(isRepositoryIncluded({ watch: [], skip: [] }, 'acme', 'api')).toBe(true);
	});

	it('org entry matches all its repos, case-insensitively', () => {
		expect(isRepositoryIncluded({ watch: ['ACME'], skip: [] }, 'acme', 'api')).toBe(true);
		expect(isRepositoryIncluded({ watch: ['acme'], skip: [] }, 'other', 'api')).toBe(false);
	});

	it('repo entry matches only that repo', () => {
		expect(isRepositoryIncluded({ watch: ['acme/api'], skip: [] }, 'acme', 'web')).toBe(false);
	});

	it('skip wins over watch', () => {
		expect(isRepositoryIncluded({ watch: ['acme'], skip: ['Acme/API'] }, 'acme', 'api')).toBe(
			false,
		);
	});
});
