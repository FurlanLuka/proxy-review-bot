import { z } from 'zod';
import { hasBotMarker } from '../review/bot-marker.js';
import type {
	DiscoveredPullRequest,
	LivePullRequest,
	PullRequestReview,
	ReviewThread,
} from './github-types.js';

const SEARCH_RESPONSE_SCHEMA = z.object({
	items: z.array(
		z.object({
			number: z.number(),
			title: z.string(),
			html_url: z.string(),
			repository_url: z.string(),
			draft: z.boolean().optional(),
			user: z.object({ login: z.string() }),
		}),
	),
});

const PULL_REQUEST_SCHEMA = z.object({
	number: z.number(),
	title: z.string(),
	html_url: z.string(),
	state: z.enum(['open', 'closed']),
	merged: z.boolean(),
	draft: z.boolean(),
	additions: z.number(),
	deletions: z.number(),
	user: z.object({ login: z.string() }),
	head: z.object({ sha: z.string() }),
	base: z.object({
		ref: z.string(),
		repo: z.object({ full_name: z.string() }).optional(),
	}),
	requested_reviewers: z.array(z.object({ login: z.string() })).default([]),
});

const REVIEW_SCHEMA = z.object({
	id: z.number(),
	state: z.string(),
	body: z.string().nullable(),
	submitted_at: z.string().nullable().optional(),
	commit_id: z.string().nullable(),
	user: z.object({ login: z.string(), type: z.string() }).nullable(),
});

const REVIEW_PAGES_SCHEMA = z.array(z.array(REVIEW_SCHEMA));

const REVIEW_THREADS_SCHEMA = z.object({
	data: z.object({
		repository: z.object({
			pullRequest: z.object({
				reviewThreads: z.object({
					nodes: z.array(
						z.object({
							id: z.string(),
							isResolved: z.boolean(),
							path: z.string(),
							line: z.number().nullable(),
							comments: z.object({
								nodes: z.array(
									z.object({
										databaseId: z.number(),
										body: z.string(),
										createdAt: z.string(),
										author: z.object({ login: z.string(), __typename: z.string() }).nullable(),
									}),
								),
							}),
						}),
					),
				}),
			}),
		}),
	}),
});

const DECISIVE_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

export type MyReviewState = 'approved' | 'changes_requested' | 'dismissed' | 'none';

export const parseSearchResults = (json: unknown): DiscoveredPullRequest[] => {
	const response = SEARCH_RESPONSE_SCHEMA.parse(json);

	return response.items
		.filter((item) => item.draft !== true)
		.map((item) => {
			const [owner = '', repo = ''] = item.repository_url.split('/').slice(-2);

			return {
				owner,
				repo,
				number: item.number,
				title: item.title,
				url: item.html_url,
				author: item.user.login,
			};
		});
};

interface ParsePullRequestParams {
	json: unknown;
	owner: string;
	repo: string;
}

export const parsePullRequest = ({
	json,
	owner,
	repo,
}: ParsePullRequestParams): LivePullRequest => {
	const pullRequest = PULL_REQUEST_SCHEMA.parse(json);
	const [canonicalOwner, canonicalRepo] = pullRequest.base.repo?.full_name.split('/') ?? [];

	return {
		owner: canonicalOwner || owner,
		repo: canonicalRepo || repo,
		number: pullRequest.number,
		title: pullRequest.title,
		url: pullRequest.html_url,
		author: pullRequest.user.login,
		state: pullRequest.state,
		isMerged: pullRequest.merged,
		isDraft: pullRequest.draft,
		headSha: pullRequest.head.sha,
		baseRefName: pullRequest.base.ref,
		requestedReviewerLogins: pullRequest.requested_reviewers.map((reviewer) => reviewer.login),
		additions: pullRequest.additions,
		deletions: pullRequest.deletions,
	};
};

export const parseReviewPages = (json: unknown): PullRequestReview[] => {
	return REVIEW_PAGES_SCHEMA.parse(json)
		.flat()
		.map((review) => ({
			id: review.id,
			state: review.state,
			body: review.body ?? '',
			submittedAt: review.submitted_at ?? null,
			commitId: review.commit_id ?? '',
			authorLogin: review.user?.login ?? '',
			authorType: review.user?.type ?? 'User',
		}));
};

export const parseReviewThreads = (json: unknown): ReviewThread[] => {
	const response = REVIEW_THREADS_SCHEMA.parse(json);

	return response.data.repository.pullRequest.reviewThreads.nodes.map((thread) => ({
		id: thread.id,
		isResolved: thread.isResolved,
		path: thread.path,
		line: thread.line,
		comments: thread.comments.nodes.map((comment) => ({
			databaseId: comment.databaseId,
			body: comment.body,
			createdAt: comment.createdAt,
			authorLogin: comment.author?.login ?? 'ghost',
			authorType: comment.author?.__typename ?? 'User',
		})),
	}));
};

const sortBySubmission = (reviews: PullRequestReview[]): PullRequestReview[] => {
	return [...reviews]
		.filter((review) => review.submittedAt !== null)
		.sort((left, right) => (left.submittedAt ?? '').localeCompare(right.submittedAt ?? ''));
};

export const parseMyReviewState = (reviews: PullRequestReview[], login: string): MyReviewState => {
	const decisiveReviews = sortBySubmission(reviews).filter(
		(review) => review.authorLogin === login && DECISIVE_REVIEW_STATES.has(review.state),
	);
	const latestReview = decisiveReviews.at(-1);

	return latestReview === undefined
		? 'none'
		: latestReview.state === 'APPROVED'
			? 'approved'
			: latestReview.state === 'CHANGES_REQUESTED'
				? 'changes_requested'
				: 'dismissed';
};

export const hasManualReview = (reviews: PullRequestReview[], login: string): boolean => {
	return reviews.some((review) => {
		const isMine = review.authorLogin === login && review.submittedAt !== null;
		const isSubstantive = review.body.trim().length > 0 || review.state !== 'COMMENTED';

		return isMine && isSubstantive && !hasBotMarker(review.body);
	});
};

interface RepositoryFilter {
	watch: string[];
	skip: string[];
}

const matchesEntry = (entry: string, owner: string, repo: string): boolean => {
	const normalizedEntry = entry.trim().toLowerCase();

	return normalizedEntry.includes('/')
		? normalizedEntry === `${owner}/${repo}`.toLowerCase()
		: normalizedEntry === owner.toLowerCase();
};

export const isRepositoryIncluded = (
	filter: RepositoryFilter,
	owner: string,
	repo: string,
): boolean => {
	const isSkipped = filter.skip.some((entry) => matchesEntry(entry, owner, repo));

	if (isSkipped) {
		return false;
	}

	return (
		filter.watch.length === 0 || filter.watch.some((entry) => matchesEntry(entry, owner, repo))
	);
};
