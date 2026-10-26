export interface PullRequestReference {
	owner: string;
	repo: string;
	number: number;
}

export interface DiscoveredPullRequest extends PullRequestReference {
	title: string;
	url: string;
	author: string;
}

export interface LivePullRequest extends PullRequestReference {
	title: string;
	url: string;
	author: string;
	state: 'open' | 'closed';
	isMerged: boolean;
	isDraft: boolean;
	headSha: string;
	baseRefName: string;
	additions: number;
	deletions: number;
}

export interface PullRequestReview {
	id: number;
	state: string;
	body: string;
	submittedAt: string | null;
	commitId: string;
	authorLogin: string;
	authorType: string;
}

export interface ReviewThreadComment {
	databaseId: number;
	body: string;
	createdAt: string;
	authorLogin: string;
	authorType: string;
}

export interface ReviewThread {
	id: string;
	isResolved: boolean;
	path: string;
	line: number | null;
	comments: ReviewThreadComment[];
}

export interface InlineReviewComment {
	path: string;
	line: number;
	side: 'LEFT' | 'RIGHT';
	body: string;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewSubmission {
	commitId: string;
	event: ReviewEvent;
	body: string;
	comments: InlineReviewComment[];
}

export interface FileCommentSubmission {
	commitId: string;
	path: string;
	body: string;
}

export interface GitHubClient {
	searchRequestedPullRequests(): Promise<DiscoveredPullRequest[]>;
	getPullRequest(reference: PullRequestReference): Promise<LivePullRequest>;
	listReviews(reference: PullRequestReference): Promise<PullRequestReview[]>;
	listReviewThreads(reference: PullRequestReference): Promise<ReviewThread[]>;
	submitReview(reference: PullRequestReference, submission: ReviewSubmission): Promise<void>;
	postFileComment(
		reference: PullRequestReference,
		submission: FileCommentSubmission,
	): Promise<void>;
	replyToComment(reference: PullRequestReference, commentId: number, body: string): Promise<void>;
}

export class GitHubRequestError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
		this.name = 'GitHubRequestError';
	}
}
