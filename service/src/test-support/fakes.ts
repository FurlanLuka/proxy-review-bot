import { Database } from 'bun:sqlite';
import { expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotDependencies } from '../bot/bot-context.js';
import type { ClaudeClient } from '../claude/claude-client.js';
import type { CloneManager } from '../clones/clones.js';
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
	isHiddenFromSearch?: boolean;
	reviews: PullRequestReview[];
	threads: ReviewThread[];
}

export interface FakeGitHub extends GitHubClient {
	pullRequests: Map<number, FakePullRequest>;
	submissions: ReviewSubmission[];
	fileComments: FileCommentSubmission[];
	replies: { commentId: number; body: string }[];
	failSubmissionsWith: number[];
	failPullRequestFetchesWith: number[];
	pullRequestFetches: number[];
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
		failPullRequestFetchesWith: [],
		pullRequestFetches: [],
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
				.filter(
					(entry) =>
						entry.isRequested &&
						!entry.isHiddenFromSearch &&
						entry.live.state === 'open' &&
						!entry.live.isDraft,
				)
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

			fake.pullRequestFetches.push(reference.number);

			const failureStatus = fake.failPullRequestFetchesWith.shift();

			if (failureStatus !== undefined) {
				throw new GitHubRequestError('fake failure', failureStatus);
			}

			if (entry === undefined) {
				throw new GitHubRequestError('not found', 404);
			}

			return {
				...entry.live,
				requestedReviewerLogins: entry.isRequested ? [VIEWER_LOGIN] : [],
			};
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
	repairOutcomes: ClaudeRunOutcome<ReviewResult>[];
	repairCalls: { sessionId: string; clonePath: string; attempt: number }[];
	repairGate: Promise<void> | null;
	abortedRepairs: number;
	replyOutcomes: ClaudeRunOutcome<ReplyResult>[];
	reviewCalls: string[];
	replyPrompts: string[];
	modelCalls: { kind: 'review' | 'repair' | 'reply'; model: string | null }[];
	reviewGate: Promise<void> | null;
	reviewError: Error | null;
	reviewSyncError: Error | null;
	reviewGatesByUrl: Map<string, Promise<void>>;
	abortedReviews: string[];
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

	const runFakeReview: ClaudeClient['runReview'] = async ({
		pullRequestUrl,
		model,
		onProgress,
		signal,
	}) => {
		fake.reviewCalls.push(pullRequestUrl);
		fake.modelCalls.push({ kind: 'review', model });

		if (fake.reviewError !== null) {
			throw fake.reviewError;
		}

		const progress = { current: createReviewProgress(0, 'Starting the review') };

		onProgress?.(progress.current);

		for (const line of fake.reviewProgressLines) {
			progress.current = applyStreamLine(progress.current, line, 0);
			onProgress?.(progress.current);
		}

		notifyReviewWaiters();

		const aborted = Promise.withResolvers<'aborted'>();

		signal?.addEventListener('abort', () => aborted.resolve('aborted'), { once: true });

		const gates = Promise.all([fake.reviewGatesByUrl.get(pullRequestUrl), fake.reviewGate]);

		if ((await Promise.race([gates, aborted.promise])) === 'aborted' || signal?.aborted) {
			fake.abortedReviews.push(pullRequestUrl);

			return { kind: 'failed', summary: 'Claude exited null without a result' };
		}

		return fake.reviewOutcomes.shift() ?? { kind: 'failed', summary: 'no fake outcome queued' };
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
		repairOutcomes: [],
		repairCalls: [],
		repairGate: null,
		abortedRepairs: 0,
		replyOutcomes: [],
		reviewCalls: [],
		replyPrompts: [],
		modelCalls: [],
		reviewGate: null,
		reviewError: null,
		reviewSyncError: null,
		reviewGatesByUrl: new Map(),
		abortedReviews: [],
		reviewProgressLines: [],
		replyGate: null,
		replyError: null,
		runRepair: async ({ sessionId, clonePath, model, attempt, signal }) => {
			fake.repairCalls.push({ sessionId, clonePath, attempt });
			fake.modelCalls.push({ kind: 'repair', model });

			const aborted = Promise.withResolvers<'aborted'>();

			signal?.addEventListener('abort', () => aborted.resolve('aborted'), { once: true });

			if (
				(await Promise.race([fake.repairGate, aborted.promise])) === 'aborted' ||
				signal?.aborted
			) {
				fake.abortedRepairs += 1;

				return { kind: 'failed', summary: 'Claude exited null without a result' };
			}

			return (
				fake.repairOutcomes.shift() ?? { kind: 'failed', summary: 'no fake repair outcome queued' }
			);
		},
		runReview: (params) => {
			if (fake.reviewSyncError !== null) {
				throw fake.reviewSyncError;
			}

			return runFakeReview(params);
		},
		runReply: async ({ prompt, model }) => {
			fake.replyPrompts.push(prompt);
			fake.modelCalls.push({ kind: 'reply', model });
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

export interface FakeClones extends CloneManager {
	prepared: string[];
	released: string[];
	prepareError: Error | null;
}

export const createFakeClones = (): FakeClones => {
	const fake: FakeClones = {
		prepared: [],
		released: [],
		prepareError: null,
		prepareClone: async () => {
			if (fake.prepareError !== null) {
				throw fake.prepareError;
			}

			const path = `/tmp/fake-clone-${fake.prepared.length + 1}`;

			fake.prepared.push(path);

			return {
				path,
				release: async () => {
					fake.released.push(path);
				},
			};
		},
	};

	return fake;
};

export interface TestHarness {
	clock: { now: number };
	readiness: { status: 'ready' | 'setup_needed' };
	github: FakeGitHub;
	claude: FakeClaude;
	clones: FakeClones;
	dependencies: BotDependencies;
}

export const expectNoLeakedWorktrees = ({ clones }: Pick<TestHarness, 'clones'>): void => {
	expect(clones.released.toSorted()).toEqual(clones.prepared.toSorted());
};

export const createTestHarness = (): TestHarness => {
	const clock = { now: ANCHOR_TIME };
	const readiness: TestHarness['readiness'] = { status: 'ready' };
	const github = createFakeGitHub(clock);
	const claude = createFakeClaude();
	const clones = createFakeClones();
	const directory = mkdtempSync(join(tmpdir(), 'proxy-review-bot-test-'));
	const dependencies: BotDependencies = {
		store: createStore(new Database(':memory:')),
		settingsStore: createSettingsStore(join(directory, 'settings.json')),
		github,
		claude,
		clones,
		runReadinessChecks: async () => ({
			readiness: { status: readiness.status, checks: [] },
			viewerLogin: VIEWER_LOGIN,
		}),
		logger: createSilentLogger(),
		now: () => clock.now,
		sleep: () => Promise.resolve(),
	};

	return { clock, readiness, github, claude, clones, dependencies };
};
