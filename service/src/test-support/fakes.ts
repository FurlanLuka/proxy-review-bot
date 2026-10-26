import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotDependencies } from '../bot/bot-context.js';
import type { ClaudeClient } from '../claude/claude-client.js';
import type {
	DiscoveredPullRequest,
	FileCommentSubmission,
	GitHubClient,
	LivePullRequest,
	PullRequestReview,
	ReviewSubmission,
	ReviewThread,
} from '../github/github-types.js';
import { GitHubRequestError } from '../github/github-types.js';
import { createSilentLogger } from '../logging/logger.js';
import { applyStreamLine, createReviewProgress } from '../review/review-progress.js';
import type { ClaudeRunOutcome, ReplyResult, ReviewResult } from '../review/review-result.js';
import { createSettingsStore } from '../settings/settings.js';
import { createStore } from '../tracking/store.js';
import { ANCHOR_TIME, makeLive } from './factories.js';

export const VIEWER_LOGIN = 'luka';

interface FakePullRequest {
	live: LivePullRequest;
	isRequested: boolean;
	reviews: PullRequestReview[];
	threads: ReviewThread[];
}

export interface FakeGitHub extends GitHubClient {
	pullRequests: Map<number, FakePullRequest>;
	submissions: ReviewSubmission[];
	fileComments: FileCommentSubmission[];
	replies: { commentId: number; body: string }[];
	failSubmissionsWith: number[];
	addPullRequest(number: number, overrides?: Partial<LivePullRequest>): FakePullRequest;
}

export const createFakeGitHub = (clock: { now: number }): FakeGitHub => {
	const pullRequests = new Map<number, FakePullRequest>();
	const fake: FakeGitHub = {
		pullRequests,
		submissions: [],
		fileComments: [],
		replies: [],
		failSubmissionsWith: [],
		addPullRequest: (number, overrides = {}) => {
			const entry = {
				live: makeLive({ number, url: `https://github.com/acme/api/pull/${number}`, ...overrides }),
				isRequested: true,
				reviews: [],
				threads: [],
			};

			pullRequests.set(number, entry);

			return entry;
		},
		searchRequestedPullRequests: async () => {
			return [...pullRequests.values()]
				.filter((entry) => entry.isRequested && entry.live.state === 'open')
				.map(
					(entry): DiscoveredPullRequest => ({
						owner: entry.live.owner,
						repo: entry.live.repo,
						number: entry.live.number,
						title: entry.live.title,
						url: entry.live.url,
						author: entry.live.author,
					}),
				);
		},
		getPullRequest: async (reference) => {
			const entry = pullRequests.get(reference.number);

			if (entry === undefined) {
				throw new GitHubRequestError('not found', 404);
			}

			return { ...entry.live };
		},
		listReviews: async (reference) => [...(pullRequests.get(reference.number)?.reviews ?? [])],
		listReviewThreads: async (reference) => pullRequests.get(reference.number)?.threads ?? [],
		submitReview: async (reference, submission) => {
			const failureStatus = fake.failSubmissionsWith.shift();

			if (failureStatus !== undefined) {
				throw new GitHubRequestError(`HTTP ${failureStatus}`, failureStatus);
			}

			fake.submissions.push(submission);
			const entry = pullRequests.get(reference.number);

			entry?.reviews.push({
				id: fake.submissions.length,
				state:
					submission.event === 'APPROVE'
						? 'APPROVED'
						: submission.event === 'REQUEST_CHANGES'
							? 'CHANGES_REQUESTED'
							: 'COMMENTED',
				body: submission.body,
				submittedAt: new Date(clock.now).toISOString(),
				commitId: submission.commitId,
				authorLogin: VIEWER_LOGIN,
				authorType: 'User',
			});

			if (entry !== undefined) {
				entry.isRequested = false;
			}
		},
		postFileComment: async (_reference, submission) => {
			fake.fileComments.push(submission);
		},
		replyToComment: async (reference, commentId, body) => {
			fake.replies.push({ commentId, body });

			for (const thread of pullRequests.get(reference.number)?.threads ?? []) {
				if (thread.comments.some((comment) => comment.databaseId === commentId)) {
					thread.comments.push({
						databaseId: 10_000 + fake.replies.length,
						body,
						createdAt: new Date(clock.now).toISOString(),
						authorLogin: VIEWER_LOGIN,
						authorType: 'User',
					});
				}
			}
		},
	};

	return fake;
};

export interface FakeClaude extends ClaudeClient {
	reviewOutcomes: ClaudeRunOutcome<ReviewResult>[];
	replyOutcomes: ClaudeRunOutcome<ReplyResult>[];
	reviewCalls: string[];
	replyPrompts: string[];
	reviewGate: Promise<void> | null;
	reviewProgressLines: string[];
	replyEntered: Promise<void>;
	waitForReviewCall: (count: number) => Promise<void>;
	replyGate: Promise<void> | null;
	replyError: Error | null;
}

export const createFakeClaude = (): FakeClaude => {
	const reviewWaiters: { count: number; resolve: () => void }[] = [];
	const replyEntered = Promise.withResolvers<void>();

	const notifyReviewWaiters = (): void => {
		for (const waiter of reviewWaiters.filter(({ count }) => fake.reviewCalls.length >= count)) {
			waiter.resolve();
		}
	};

	const fake: FakeClaude = {
		replyEntered: replyEntered.promise,
		waitForReviewCall: (count) => {
			const waiter = Promise.withResolvers<void>();

			reviewWaiters.push({ count, resolve: waiter.resolve });
			notifyReviewWaiters();

			return waiter.promise;
		},
		reviewOutcomes: [],
		replyOutcomes: [],
		reviewCalls: [],
		replyPrompts: [],
		reviewGate: null,
		reviewProgressLines: [],
		replyGate: null,
		replyError: null,
		runReview: async ({ pullRequestUrl, onProgress }) => {
			fake.reviewCalls.push(pullRequestUrl);

			const progress = { current: createReviewProgress(0, 'Starting the review') };

			onProgress?.(progress.current);

			for (const line of fake.reviewProgressLines) {
				progress.current = applyStreamLine(progress.current, line, 0);
				onProgress?.(progress.current);
			}

			notifyReviewWaiters();

			if (fake.reviewGate !== null) {
				await fake.reviewGate;
			}

			return fake.reviewOutcomes.shift() ?? { kind: 'failed', summary: 'no fake outcome queued' };
		},
		runReply: async ({ prompt }) => {
			fake.replyPrompts.push(prompt);
			replyEntered.resolve();

			if (fake.replyGate !== null) {
				await fake.replyGate;
			}

			if (fake.replyError !== null) {
				throw fake.replyError;
			}

			return fake.replyOutcomes.shift() ?? { kind: 'result', result: { reply: null } };
		},
	};

	return fake;
};

export interface TestHarness {
	clock: { now: number };
	readiness: { status: 'ready' | 'setup_needed' };
	github: FakeGitHub;
	claude: FakeClaude;
	dependencies: BotDependencies;
}

export const createTestHarness = (): TestHarness => {
	const clock = { now: ANCHOR_TIME };
	const readiness: TestHarness['readiness'] = { status: 'ready' };
	const github = createFakeGitHub(clock);
	const claude = createFakeClaude();
	const directory = mkdtempSync(join(tmpdir(), 'proxy-review-bot-test-'));
	const dependencies: BotDependencies = {
		store: createStore(new Database(':memory:')),
		settingsStore: createSettingsStore(join(directory, 'settings.json')),
		github,
		claude,
		clones: { prepareClone: async () => '/tmp/fake-clone' },
		runReadinessChecks: async () => ({
			readiness: { status: readiness.status, checks: [] },
			viewerLogin: VIEWER_LOGIN,
		}),
		logger: createSilentLogger(),
		now: () => clock.now,
	};

	return { clock, readiness, github, claude, dependencies };
};
