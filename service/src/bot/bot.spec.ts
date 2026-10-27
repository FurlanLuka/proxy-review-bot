import { describe, expect, it } from 'bun:test';
import { createBotMarker } from '../review/bot-marker.js';
import { QUIET_PERIOD_MS } from '../review/review-decisions.js';
import {
	MAX_REPAIR_ATTEMPTS,
	REPAIR_PAUSE_MS,
	repairProgressMessage,
	SAVED_SESSION_MAX_AGE_MS,
	UNREPAIRED_RESULT_SUMMARY,
} from '../review/review-repair-rules.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import { makeComment, makeDraft, makeThread } from '../test-support/factories.js';
import { createTestHarness, expectNoLeakedWorktrees, VIEWER_LOGIN } from '../test-support/fakes.js';
import type { TestHarness } from '../test-support/fakes.js';
import { createBot } from './bot.js';

// Leaves postReviews out so it follows reviewMode unless a test sets it.
const DEFAULTS_WITH_DERIVED_POSTING = Object.fromEntries(
	Object.entries(DEFAULT_SETTINGS).filter(([key]) => key !== 'postReviews'),
);

const setUp = (settings = {}) => {
	const harness = createTestHarness();

	harness.dependencies.settingsStore.replace({ ...DEFAULTS_WITH_DERIVED_POSTING, ...settings });

	const bot = createBot(harness.dependencies);

	const settle = async (): Promise<void> => {
		await bot.waitForIdle();
		expectNoLeakedWorktrees(harness);
	};

	const tickAndSettle = async (): Promise<void> => {
		await bot.tick();
		await settle();
	};

	const statusOf = (number: number) => {
		return bot.getState().pullRequests.find((pullRequest) => pullRequest.number === number);
	};

	return { ...harness, bot, settle, tickAndSettle, statusOf };
};

const draftedFor = (headSha: string, filing: 'approve' | 'comment') => ({
	kind: 'result' as const,
	result: makeDraft({ headRefOid: headSha, filing }),
});

const pushCommit = (harness: TestHarness, number: number, headSha: string): void => {
	const entry = harness.github.pullRequests.get(number);

	if (entry !== undefined) {
		entry.live.headSha = headSha;
	}
};

describe('bot in manual mode', () => {
	it('never reviews until the developer clicks Review', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('needs_review');
		expect(setup.claude.reviewCalls).toEqual([]);
		expect(setup.github.submissions).toEqual([]);
	});

	it('Review click → a draft held for you, nothing posted until you post it', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		expect(setup.bot.requestReview(setup.statusOf(7)?.id ?? 0)).toBe('ok');
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)).toMatchObject({
			status: 'draft_ready',
			rounds: 0,
			draft: { filing: 'comment', commentCount: 1, summary: 'Retry loop never backs off' },
		});
	});
});

describe('bot in auto mode', () => {
	it('full loop: comment → push → approval pending → click approve', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
		expect(await setup.github.searchRequestedPullRequests()).toEqual([]);

		pushCommit(setup, 7, 'head-2');
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);

		setup.clock.now += QUIET_PERIOD_MS;
		setup.claude.reviewOutcomes.push(draftedFor('head-2', 'approve'));
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.status).toBe('awaiting_approval');
		expect(setup.github.submissions).toHaveLength(1);

		expect(await setup.bot.approve(setup.statusOf(7)?.id ?? 0)).toBe('ok');
		expect(setup.github.submissions.at(-1)?.event).toBe('APPROVE');
		expect(setup.statusOf(7)).toMatchObject({ status: 'done', rounds: 2 });
	});

	it('approve with a stale head → head_moved and nothing posted', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'approve'));
		await setup.tickAndSettle();
		pushCommit(setup, 7, 'head-2');

		expect(await setup.bot.approve(setup.statusOf(7)?.id ?? 0)).toBe('head_moved');
		expect(setup.github.submissions).toEqual([]);
	});

	it('auto-approve on → posts APPROVE directly', async () => {
		const setup = setUp({ reviewMode: 'auto', autoApprove: 'on' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'approve'));
		await setup.tickAndSettle();

		expect(setup.github.submissions[0]?.event).toBe('APPROVE');
		expect(setup.statusOf(7)?.status).toBe('done');
	});

	it('posting fails → rounds unchanged, PR needs you', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.github.failSubmissionsWith = [500];
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({ status: 'needs_you', rounds: 0 });
	});

	it('422 anchor rejection → retried once with comments folded', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.github.failSubmissionsWith = [422];
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.github.submissions).toHaveLength(1);
		expect(setup.github.submissions[0]?.comments).toEqual([]);
		expect(setup.github.submissions[0]?.body).toContain('**src/retry.ts:12**');
	});

	it('manual mode, started review: a failed run shows its retry time and is retried after the backoff', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({
			status: 'waiting_on_author',
			reason: 'Claude run timed out',
			retryAt: setup.clock.now + 10 * 60_000,
			isStarted: true,
		});

		setup.clock.now += 11 * 60_000;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(setup.github.submissions).toEqual([]);
	});

	it('manual mode, started review: the author re-requests you on the same commit → a new round, held as a draft', async () => {
		const setup = setUp({ reviewMode: 'manual' });
		const entry = setup.github.addPullRequest(7);

		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		await setup.settle();

		const posted = await setup.bot.postDraft(setup.statusOf(7)?.id ?? 0, {
			headSha: 'head-1',
			event: 'COMMENT',
			mainReview: 'Please add a backoff',
			comments: [],
			fileComments: [],
		});

		expect(posted.result).toBe('ok');

		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', rounds: 1 });

		entry.isRequested = true;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)).toMatchObject({ status: 'draft_ready', rounds: 1, isStarted: true });
		expect(setup.github.submissions).toHaveLength(1);
	});

	describe('re-request detection', () => {
		const startAndPost = async (setup: ReturnType<typeof setUp>) => {
			await setup.tickAndSettle();
			setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
			setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
			await setup.settle();

			const id = setup.statusOf(7)?.id ?? 0;
			const posted = await setup.bot.postDraft(id, {
				headSha: 'head-1',
				event: 'COMMENT',
				mainReview: 'Please add a backoff',
				comments: [],
				fileComments: [],
			});

			expect(posted.result).toBe('ok');
			expect(setup.dependencies.store.getPullRequest(id)?.isRequested).toBe(false);

			return id;
		};

		it('a started PR still requested, toggled to draft and back during its backoff → no extra round', async () => {
			const setup = setUp({ reviewMode: 'manual' });
			const entry = setup.github.addPullRequest(7);

			await setup.tickAndSettle();
			setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
			setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
			await setup.settle();

			const retryAt = setup.statusOf(7)?.retryAt;

			expect(entry.isRequested).toBe(true);
			expect(setup.statusOf(7)).toMatchObject({
				status: 'waiting_on_author',
				reason: 'Claude run timed out',
			});
			expect(retryAt).not.toBeNull();

			entry.live.isDraft = true;
			await setup.tickAndSettle();
			entry.live.isDraft = false;
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(1);
			expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', retryAt });

			setup.clock.now += 11 * 60_000;
			setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(2);
			expect(setup.statusOf(7)?.status).toBe('draft_ready');
		});

		it('finished PR whose repo is gone (404) → request cleared, no repeated fetches', async () => {
			const setup = setUp({ reviewMode: 'manual' });
			const entry = setup.github.addPullRequest(7);

			await setup.tickAndSettle();
			entry.live.state = 'closed';
			entry.live.isMerged = true;
			await setup.tickAndSettle();
			setup.github.pullRequests.delete(7);
			await setup.tickAndSettle();

			const fetchesBefore = setup.github.pullRequestFetches.length;

			await setup.tickAndSettle();
			await setup.tickAndSettle();

			expect(setup.statusOf(7)?.status).toBe('done');
			expect(setup.github.pullRequestFetches.length).toBe(fetchesBefore);
		});

		it('merged while still requested → request cleared once, no GitHub fetch on later ticks', async () => {
			const setup = setUp({ reviewMode: 'manual' });
			const entry = setup.github.addPullRequest(7);

			await setup.tickAndSettle();
			entry.live.state = 'closed';
			entry.live.isMerged = true;
			await setup.tickAndSettle();
			await setup.tickAndSettle();

			expect(setup.statusOf(7)?.status).toBe('done');

			const fetchesBefore = setup.github.pullRequestFetches.length;

			await setup.tickAndSettle();
			await setup.tickAndSettle();

			expect(setup.github.pullRequestFetches.length).toBe(fetchesBefore);
		});

		it('gave up while still requested, toggled to draft and back → no reopen, no new review', async () => {
			const setup = setUp({ reviewMode: 'manual' });
			const entry = setup.github.addPullRequest(7);

			await setup.tickAndSettle();
			setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
			setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
			await setup.settle();
			setup.clock.now += 11 * 60_000;
			setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
			await setup.tickAndSettle();
			await setup.tickAndSettle();

			expect(setup.statusOf(7)?.status).toBe('needs_you');
			expect(entry.isRequested).toBe(true);

			entry.live.isDraft = true;
			await setup.tickAndSettle();
			entry.live.isDraft = false;
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(2);
			expect(setup.statusOf(7)?.status).toBe('needs_you');
		});

		it('gave up while still requested, GitHub errors during the draft tick → request kept, no reopen', async () => {
			const setup = setUp({ reviewMode: 'manual' });
			const entry = setup.github.addPullRequest(7);

			await setup.tickAndSettle();
			setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
			setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
			await setup.settle();
			setup.clock.now += 11 * 60_000;
			setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
			await setup.tickAndSettle();
			await setup.tickAndSettle();
			entry.live.isDraft = true;
			setup.github.failPullRequestFetchesWith.push(500);
			await setup.tickAndSettle();

			expect(setup.github.failPullRequestFetchesWith).toEqual([]);
			expect(setup.dependencies.store.getPullRequest(setup.statusOf(7)?.id ?? 0)?.isRequested).toBe(
				true,
			);

			entry.live.isDraft = false;
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(2);
			expect(setup.statusOf(7)?.status).toBe('needs_you');
		});

		it('re-requested while a round is running → absorbed by that round, draft held, no extra round', async () => {
			const setup = setUp({ reviewMode: 'manual' });
			const entry = setup.github.addPullRequest(7);
			const id = await startAndPost(setup);
			const gate = createGate();

			pushCommit(setup, 7, 'head-2');
			await setup.tickAndSettle();
			setup.clock.now += QUIET_PERIOD_MS;
			setup.claude.reviewGate = gate.promise;
			setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));
			await setup.bot.tick();
			await setup.claude.waitForReviewCall(2);
			entry.isRequested = true;
			await setup.bot.tick();
			gate.open();
			await setup.settle();
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(2);
			expect(setup.statusOf(7)?.status).toBe('draft_ready');
			expect(setup.dependencies.store.getPullRequest(id)?.isRequested).toBe(true);
		});

		it('re-requested while search still lags behind → seen from the PR itself, new round', async () => {
			const setup = setUp({ reviewMode: 'manual' });
			const entry = setup.github.addPullRequest(7);

			await startAndPost(setup);
			entry.isRequested = true;
			entry.isHiddenFromSearch = true;
			setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(2);
			expect(setup.statusOf(7)?.status).toBe('draft_ready');
		});

		it('re-requested while paused → acted on after resuming, not lost', async () => {
			const setup = setUp({ reviewMode: 'manual' });
			const entry = setup.github.addPullRequest(7);
			const id = await startAndPost(setup);

			setup.bot.setPaused(true);
			entry.isRequested = true;
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(1);
			expect(setup.dependencies.store.getPullRequest(id)?.isRequested).toBe(false);

			setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
			setup.bot.setPaused(false);
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(2);
			expect(setup.statusOf(7)?.status).toBe('draft_ready');
		});

		it('new commits while a draft is held → the old draft is dropped, a fresh round runs, nothing posted', async () => {
			const setup = setUp({ reviewMode: 'manual' });

			setup.github.addPullRequest(7);
			await setup.tickAndSettle();
			setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
			setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
			await setup.settle();

			expect(setup.statusOf(7)?.status).toBe('draft_ready');

			pushCommit(setup, 7, 'head-2');
			await setup.tickAndSettle();
			setup.clock.now += QUIET_PERIOD_MS;
			setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(2);
			expect(setup.statusOf(7)?.status).toBe('draft_ready');
			expect(setup.bot.getDraft(setup.statusOf(7)?.id ?? 0)).toMatchObject({ headSha: 'head-2' });
			expect(setup.github.submissions).toEqual([]);
		});
	});

	it('manual mode, review never started: new commits still wait in Ready to review', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		pushCommit(setup, 7, 'head-2');
		setup.clock.now += QUIET_PERIOD_MS;
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({ status: 'needs_review', isStarted: false });
		expect(setup.claude.reviewCalls).toHaveLength(0);
	});

	it('Review again on a failed round runs now and keeps the round count', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		pushCommit(setup, 7, 'head-2');
		await setup.tickAndSettle();
		setup.clock.now += QUIET_PERIOD_MS;
		setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', rounds: 1 });

		setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));

		expect(setup.bot.requestReview(setup.statusOf(7)?.id ?? 0)).toBe('ok');

		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(3);
		expect(setup.statusOf(7)).toMatchObject({
			status: 'waiting_on_author',
			rounds: 2,
			reason: null,
		});
	});

	it('failed run backs off, then gives up after two attempts on the same head', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({
			status: 'waiting_on_author',
			reason: 'Claude run timed out',
			retryAt: setup.clock.now + 10 * 60_000,
			rounds: 0,
		});

		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);

		setup.clock.now += 11 * 60_000;
		setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);

		setup.clock.now += 11 * 60_000;
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.status).toBe('needs_you');
	});

	it('usage limit pauses the queue without failing the PR', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push({ kind: 'usage_limited', resumeAt: setup.clock.now + 60_000 });
		await setup.tickAndSettle();
		setup.github.addPullRequest(8);
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.bot.getState().usageLimitedUntil).toBe(setup.clock.now + 60_000);
		expect(setup.statusOf(7)?.status).toBe('queued');

		setup.clock.now += 61_000;
		setup.claude.reviewOutcomes.push(
			draftedFor('head-1', 'comment'),
			draftedFor('head-1', 'comment'),
		);
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(3);
	});

	it('developer reviews by hand → bot takes its hands off', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.reviews.push({
			id: 99,
			state: 'CHANGES_REQUESTED',
			body: 'Please split this',
			submittedAt: new Date(setup.clock.now + 1000).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		pushCommit(setup, 7, 'head-2');
		setup.clock.now += QUIET_PERIOD_MS * 2;
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('needs_you');
		expect(setup.claude.reviewCalls).toHaveLength(1);
	});

	it('merged → done, and paused bot reviews nothing', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);

		setup.bot.setPaused(true);
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toEqual([]);

		entry.live.state = 'closed';
		entry.live.isMerged = true;
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('done');
	});

	it('watch list excludes other repos', async () => {
		const setup = setUp({ reviewMode: 'auto', watch: ['other-org'] });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();

		expect(setup.bot.getState().pullRequests).toEqual([]);
	});

	it('crash during a review → reset to queued on boot', () => {
		const setup = setUp();
		const { store } = setup.dependencies;
		const tracked = store.insertDiscovered({
			discovered: { owner: 'acme', repo: 'api', number: 7, title: 't', url: 'u', author: 'a' },
			status: 'reviewing',
			now: setup.clock.now,
		});

		expect(store.resetInterruptedReviews(setup.clock.now)).toBe(1);
		expect(store.getPullRequest(tracked.id)?.status).toBe('queued');
	});

	it('already posted for this head (crash after post) → not posted twice', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);

		entry.reviews.push({
			id: 1,
			state: 'COMMENTED',
			body: `Earlier\n${createBotMarker('head-1')}`,
			submittedAt: new Date(setup.clock.now).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.github.submissions).toEqual([]);
	});
});

describe('stopping a review before Claude starts', () => {
	it('stopped while the clone is prepared → Claude never runs, nothing posted, worktree released', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const prepareGate = createGate();
		const prepareClone = setup.clones.prepareClone;

		setup.github.addPullRequest(7);

		setup.clones.prepareClone = async (reference) => {
			await prepareGate.promise;

			return prepareClone(reference);
		};

		await setup.bot.tick();
		await waitUntil(() => setup.statusOf(7)?.status === 'reviewing');
		setup.bot.stop(setup.statusOf(7)?.id ?? 0);
		prepareGate.open();
		await setup.settle();

		expect(setup.claude.reviewCalls).toEqual([]);
		expect(setup.github.submissions).toEqual([]);
		expect(setup.clones.released).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('stopped');
	});
});

describe('stopping a running review', () => {
	it('Stop kills the Claude run, frees its slot for the next PR, and posts nothing for it', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const gate = createGate();

		for (const number of [7, 8, 9, 10]) {
			setup.github.addPullRequest(number);
		}

		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(...[1, 2, 3].map(() => draftedFor('head-1', 'comment')));
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(3);

		const stoppedUrl = setup.claude.reviewCalls[0] ?? '';
		const stopped = setup.bot
			.getState()
			.pullRequests.find((pullRequest) => pullRequest.url === stoppedUrl);

		expect(setup.bot.stop(stopped?.id ?? 0)).toBe('ok');

		await Bun.sleep(0);

		expect(setup.claude.abortedReviews).toEqual([stoppedUrl]);

		await waitUntil(
			() =>
				setup.bot.getState().pullRequests.find((pullRequest) => pullRequest.url === stoppedUrl)
					?.progress === null,
		);
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(4);

		expect(setup.claude.reviewCalls).toHaveLength(4);

		gate.open();
		await setup.settle();

		expect(setup.github.submissions).toHaveLength(3);
		expect(
			setup.bot.getState().pullRequests.find((pullRequest) => pullRequest.url === stoppedUrl)
				?.status,
		).toBe('stopped');
	});

	it('PR merged during a review → the run is killed on the next sync', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);
		const gate = createGate();

		setup.claude.reviewGate = gate.promise;
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(1);
		entry.live.state = 'closed';
		entry.live.isMerged = true;
		await setup.bot.tick();
		await Bun.sleep(0);

		expect(setup.claude.abortedReviews).toEqual([entry.live.url]);

		gate.open();
		await setup.settle();

		expect(setup.statusOf(7)?.status).toBe('done');
		expect(setup.github.submissions).toEqual([]);
	});
});

describe('starting queued reviews without waiting for the next poll', () => {
	it('clicking Review starts the review right away, before the next tick', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		expect(setup.bot.requestReview(setup.statusOf(7)?.id ?? 0)).toBe('ok');

		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('a finished review frees its slot and the next queued PR starts without a tick', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		for (const number of [7, 8, 9, 10]) {
			setup.github.addPullRequest(number);
		}

		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(...[1, 2, 3, 4].map(() => draftedFor('head-1', 'comment')));

		for (const number of [7, 8, 9, 10]) {
			setup.bot.requestReview(setup.statusOf(number)?.id ?? 0);
		}

		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(4);
		expect(new Set(setup.claude.reviewCalls).size).toBe(4);
	});

	it('clicking Retry starts the review right away, before the next tick', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();

		const id = setup.statusOf(7)?.id ?? 0;

		setup.dependencies.store.updatePullRequest(id, { status: 'needs_you' });
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		expect(setup.bot.retry(id)).toBe('ok');

		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it.each([
		{
			name: 'paused',
			block: (setup: ReturnType<typeof setUp>) => setup.bot.setPaused(true),
			unblock: (setup: ReturnType<typeof setUp>) => setup.bot.setPaused(false),
		},
		{
			name: 'usage limited',
			block: (setup: ReturnType<typeof setUp>) =>
				setup.dependencies.store.setFlag('usage_limited_until', String(setup.clock.now + 60_000)),
			unblock: (setup: ReturnType<typeof setUp>) => {
				setup.clock.now += 61_000;
			},
		},
		{
			name: 'setup needed',
			block: async (setup: ReturnType<typeof setUp>) => {
				setup.readiness.status = 'setup_needed';
				setup.clock.now += 11 * 60_000;
				await setup.tickAndSettle();
			},
			unblock: (setup: ReturnType<typeof setUp>) => {
				setup.readiness.status = 'ready';
				setup.clock.now += 11 * 60_000;
			},
		},
	])(
		'$name → clicking Review queues without starting; it starts once that clears',
		async ({ block, unblock }) => {
			const setup = setUp({ reviewMode: 'manual' });

			setup.github.addPullRequest(7);
			await setup.tickAndSettle();
			await block(setup);
			setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

			expect(setup.bot.requestReview(setup.statusOf(7)?.id ?? 0)).toBe('ok');

			await setup.settle();

			expect(setup.claude.reviewCalls).toHaveLength(0);
			expect(setup.statusOf(7)?.status).toBe('queued');

			await unblock(setup);
			await setup.tickAndSettle();

			expect(setup.claude.reviewCalls).toHaveLength(1);
			expect(setup.statusOf(7)?.status).toBe('draft_ready');
		},
	);

	it('setup broken mid-run → nothing new starts until the re-check, which then runs both waiting PRs', async () => {
		const setup = setUp({ reviewMode: 'manual' });
		const draftGate = createGate();

		for (const number of [7, 8, 9, 10]) {
			setup.github.addPullRequest(number);
		}

		await setup.tickAndSettle();
		setup.claude.reviewGatesByUrl.set(urlOf(8), draftGate.promise);
		setup.claude.reviewGatesByUrl.set(urlOf(9), draftGate.promise);
		setup.claude.reviewOutcomes.push(
			{ kind: 'setup_broken', message: 'Not logged in' },
			...[1, 2, 3, 4].map(() => draftedFor('head-1', 'comment')),
		);

		for (const number of [7, 8, 9, 10]) {
			setup.bot.requestReview(setup.statusOf(number)?.id ?? 0);
		}

		await waitUntil(() => setup.bot.getState().readiness.status === 'checking');

		expect(setup.statusOf(7)?.status).toBe('queued');

		draftGate.open();
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(3);
		expect(setup.statusOf(10)?.status).toBe('queued');

		await setup.tickAndSettle();

		expect(setup.bot.getState().readiness.status).toBe('ready');
		expect(setup.claude.reviewCalls).toHaveLength(5);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(setup.statusOf(10)?.status).toBe('draft_ready');
	});
});

describe('starting queued reviews: resume, failures and stale readiness', () => {
	it('resuming starts reviews that were queued while paused, without a tick', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.bot.setPaused(true);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(0);

		setup.bot.setPaused(false);
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('starting queued reviews throws → logged, and the click still succeeds', async () => {
		const setup = setUp({ reviewMode: 'manual' });
		const errors: string[] = [];

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();

		const id = setup.statusOf(7)?.id ?? 0;

		setup.dependencies.logger.error = (event) => {
			errors.push(event);
		};

		setup.dependencies.store.listPullRequests = () => {
			throw new Error('database locked');
		};

		expect(setup.bot.requestReview(id)).toBe('ok');
		expect(errors).toEqual(['queued_reviews_start_failed']);
		expect(setup.claude.reviewCalls).toHaveLength(0);
	});

	it('a readiness check that started before setup broke cannot mark it ready again', async () => {
		const setup = setUp({ reviewMode: 'manual' });
		const reviewGate = createGate();
		const readinessGate = createGate();
		const runReadinessChecks = setup.dependencies.runReadinessChecks;

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.claude.reviewGatesByUrl.set(urlOf(7), reviewGate.promise);
		setup.claude.reviewOutcomes.push({ kind: 'setup_broken', message: 'Not logged in' });
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);

		setup.dependencies.runReadinessChecks = async () => {
			await readinessGate.promise;

			return runReadinessChecks();
		};

		const staleCheck = setup.bot.recheckReadiness();

		reviewGate.open();
		await setup.settle();

		expect(setup.bot.getState().readiness.status).toBe('checking');

		readinessGate.open();
		await staleCheck;

		expect(setup.bot.getState().readiness.status).toBe('checking');

		setup.dependencies.runReadinessChecks = runReadinessChecks;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.bot.getState().readiness.status).toBe('ready');
		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});
});

describe('parallel reviews', () => {
	it('four queued PRs → three review at once, the fourth starts when a slot frees up', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const gate = createGate();

		for (const number of [7, 8, 9, 10]) {
			setup.github.addPullRequest(number);
		}

		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(...[1, 2, 3, 4].map(() => draftedFor('head-1', 'comment')));
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(3);
		await setup.bot.tick();

		const statuses = [7, 8, 9, 10].map((number) => setup.statusOf(number)?.status);

		expect(setup.claude.reviewCalls).toHaveLength(3);
		expect(statuses.filter((status) => status === 'reviewing')).toHaveLength(3);
		expect(statuses.filter((status) => status === 'queued')).toHaveLength(1);

		gate.open();
		await setup.settle();
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(4);
		expect(new Set(setup.claude.reviewCalls).size).toBe(4);
	});

	it('three in flight, one hits the usage limit → only it is queued again, the others finish, the fourth waits', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const gate = createGate();

		for (const number of [7, 8, 9, 10]) {
			setup.github.addPullRequest(number);
		}

		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(
			{ kind: 'usage_limited', resumeAt: setup.clock.now + 60_000 },
			draftedFor('head-1', 'comment'),
			draftedFor('head-1', 'comment'),
		);
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(3);
		gate.open();
		await setup.settle();
		await setup.tickAndSettle();

		const reviewedNumbers = setup.claude.reviewCalls.map(numberOf);
		const [limited, ...finished] = reviewedNumbers;
		const waiting = [7, 8, 9, 10].find((number) => !reviewedNumbers.includes(number));

		expect(setup.claude.reviewCalls).toHaveLength(3);
		expect(setup.statusOf(limited ?? 0)?.status).toBe('queued');
		expect(finished.map((number) => setup.statusOf(number)?.status)).toEqual([
			'waiting_on_author',
			'waiting_on_author',
		]);
		expect(setup.statusOf(waiting ?? 0)?.status).toBe('queued');

		setup.clock.now += 61_000;
		setup.claude.reviewOutcomes.push(
			draftedFor('head-1', 'comment'),
			draftedFor('head-1', 'comment'),
		);
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(5);
	});

	it('two jobs hit the usage limit → the later resume time wins', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const gate = createGate();
		const start = setup.clock.now;

		setup.github.addPullRequest(7);
		setup.github.addPullRequest(8);
		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(
			{ kind: 'usage_limited', resumeAt: start + 120_000 },
			{ kind: 'usage_limited', resumeAt: start + 60_000 },
		);
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(2);
		gate.open();
		await setup.settle();

		expect(setup.bot.getState().usageLimitedUntil).toBe(start + 120_000);

		setup.clock.now = start + 90_000;
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
	});

	it('review A finishes while B runs → A shows no progress, B keeps its own', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const firstGate = createGate();
		const secondGate = createGate();

		setup.github.addPullRequest(7);
		setup.github.addPullRequest(8);
		setup.claude.reviewGatesByUrl.set(urlOf(7), firstGate.promise);
		setup.claude.reviewGatesByUrl.set(urlOf(8), secondGate.promise);
		setup.claude.reviewOutcomes.push(
			draftedFor('head-1', 'comment'),
			draftedFor('head-1', 'comment'),
		);
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(2);
		firstGate.open();
		await waitUntil(() => setup.statusOf(7)?.status === 'waiting_on_author');
		await letPendingJobsRun();

		expect(setup.statusOf(7)?.progress).toBeNull();
		expect(setup.statusOf(8)?.progress).toMatchObject({ message: 'Starting the review' });

		secondGate.open();
		await setup.settle();
	});
});

describe('history', () => {
	it('Retry records a retry activity that starts a new history cycle', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();

		const id = setup.statusOf(7)?.id ?? 0;

		setup.dependencies.store.updatePullRequest(id, { status: 'needs_you' });

		expect(setup.bot.retry(id)).toBe('ok');
		expect(setup.dependencies.store.listActivity(id).map((entry) => entry.kind)).toContain('retry');
	});

	it('finished PRs are listed newest first with how they ended; open and old ones are left out', async () => {
		const setup = setUp({ reviewMode: 'auto', autoApprove: 'on' });
		const merged = setup.github.addPullRequest(7);
		setup.github.addPullRequest(8);
		setup.github.addPullRequest(9);
		setup.github.addPullRequest(10);
		setup.github.addPullRequest(11);
		setup.claude.reviewOutcomes.push(
			draftedFor('head-1', 'comment'),
			draftedFor('head-1', 'approve'),
			draftedFor('head-1', 'comment'),
			draftedFor('head-1', 'comment'),
			draftedFor('head-1', 'comment'),
		);
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		const gaveUpId = setup.statusOf(11)?.id ?? 0;

		setup.dependencies.store.updatePullRequest(gaveUpId, { status: 'needs_you' });
		setup.dependencies.store.recordActivity(gaveUpId, 'give_up', { kind: 'give_up' });
		merged.live.state = 'closed';
		merged.live.isMerged = true;
		setup.clock.now += 60_000;
		await setup.tickAndSettle();
		setup.clock.now += 60_000;
		setup.bot.stop(setup.statusOf(9)?.id ?? 0);

		const history = setup.bot.getHistory();

		expect(history.map(({ number, outcome }) => ({ number, outcome }))).toEqual([
			{ number: 9, outcome: 'stopped' },
			{ number: 7, outcome: 'merged' },
			{ number: 8, outcome: 'approved_by_bot' },
		]);
		expect(history[0]).toMatchObject({
			owner: 'acme',
			repo: 'api',
			url: 'https://github.com/acme/api/pull/9',
			rounds: 1,
			finishedAt: setup.clock.now,
		});
		expect(setup.statusOf(10)?.status).toBe('waiting_on_author');

		setup.clock.now += 31 * 24 * 60 * 60_000;
		setup.bot.stop(setup.statusOf(10)?.id ?? 0);

		expect(setup.bot.getHistory().map(({ number, outcome }) => ({ number, outcome }))).toEqual([
			{ number: 10, outcome: 'stopped' },
		]);
	});
});

describe('bot replies', () => {
	it('answers a question in its own thread once, and skips "thanks"', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		const botRoot = makeComment({
			databaseId: 1,
			authorLogin: VIEWER_LOGIN,
			body: `Finding\n${createBotMarker('head-1')}`,
		});
		const question = makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why is this wrong?' });

		entry.threads = [makeThread([botRoot, question])];
		setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: 'Because X.' } });
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.github.replies).toHaveLength(1);
		expect(setup.github.replies[0]?.commentId).toBe(2);
		expect(setup.github.replies[0]?.body).toContain('Because X.');

		const thanks = makeComment({ databaseId: 3, authorLogin: 'ana', body: 'thanks' });

		entry.threads = [makeThread([botRoot, question, thanks])];
		setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: null } });
		await setup.tickAndSettle();

		expect(setup.github.replies).toHaveLength(1);
		expect(setup.claude.replyPrompts).toHaveLength(2);
	});

	it('reply in flight + another tick → one reply job, one reply posted', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);
		const gate = createGate();

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.threads = [
			makeThread([
				makeComment({ databaseId: 1, authorLogin: VIEWER_LOGIN, body: createBotMarker('head-1') }),
				makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' }),
			]),
		];
		setup.claude.replyGate = gate.promise;
		setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: 'Because.' } });
		await setup.bot.tick();
		await setup.claude.replyEntered;
		await setup.bot.tick();

		expect(setup.claude.replyPrompts).toHaveLength(1);

		gate.open();
		await setup.settle();

		expect(setup.github.replies).toHaveLength(1);
	});

	it('answerQuestions off → no reply runs', async () => {
		const setup = setUp({ reviewMode: 'auto', answerQuestions: false });
		const entry = setup.github.addPullRequest(7);

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.threads = [
			makeThread([
				makeComment({ databaseId: 1, authorLogin: VIEWER_LOGIN, body: createBotMarker('head-1') }),
				makeComment({ databaseId: 2, authorLogin: 'ana' }),
			]),
		];
		await setup.tickAndSettle();

		expect(setup.claude.replyPrompts).toEqual([]);
	});
});

const createGate = () => {
	const gate = { open: () => {} };
	const promise = new Promise<void>((resolve) => {
		gate.open = resolve;
	});

	return { promise, open: () => gate.open() };
};

const letPendingJobsRun = (): Promise<void> => Bun.sleep(10);

const waitUntil = async (condition: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
		await Bun.sleep(1);
	}
};

const urlOf = (number: number): string => `https://github.com/acme/api/pull/${number}`;

const numberOf = (url: string): number => Number(url.split('/').at(-1));

describe('changes while a review is running', () => {
	const startGatedReview = async (settings = {}) => {
		const setup = setUp({ reviewMode: 'auto', ...settings });
		const entry = setup.github.addPullRequest(7);
		const gate = createGate();

		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.tick();

		expect(setup.statusOf(7)?.status).toBe('reviewing');

		return { ...setup, entry, gate };
	};

	it('Stop during the run → nothing posted, stays stopped', async () => {
		const setup = await startGatedReview();

		expect(setup.bot.stop(setup.statusOf(7)?.id ?? 0)).toBe('ok');
		setup.gate.open();
		await setup.settle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('stopped');
	});

	it('developer reviews by hand during the run → nothing posted, needs you', async () => {
		const setup = await startGatedReview();

		setup.entry.reviews.push({
			id: 50,
			state: 'COMMENTED',
			body: 'My own take',
			submittedAt: new Date(setup.clock.now + 1000).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		await setup.bot.tick();
		setup.gate.open();
		await setup.settle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('needs_you');
	});

	it('merged during the run → nothing posted, done', async () => {
		const setup = await startGatedReview();

		setup.entry.live.state = 'closed';
		setup.entry.live.isMerged = true;
		await setup.bot.tick();
		setup.gate.open();
		await setup.settle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('done');
	});

	it('paused during the run → nothing posted, queued again for after resume', async () => {
		const setup = await startGatedReview();

		setup.bot.setPaused(true);
		setup.gate.open();
		await setup.settle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('queued');
		expect(setup.claude.reviewCalls).toHaveLength(1);
	});

	it('Stop then Review again mid-run → no second run until the first ends, then exactly one review posted', async () => {
		const setup = await startGatedReview();
		const id = setup.statusOf(7)?.id ?? 0;

		expect(setup.bot.stop(id)).toBe('ok');
		expect(setup.bot.requestReview(id)).toBe('ok');
		await setup.bot.tick();

		expect(setup.claude.reviewCalls).toHaveLength(1);

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.gate.open();
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.github.submissions).toHaveLength(1);

		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.github.submissions).toHaveLength(1);
	});

	it('Review and Retry clicks while reviewing → busy', async () => {
		const setup = await startGatedReview();
		const id = setup.statusOf(7)?.id ?? 0;

		expect(setup.bot.requestReview(id)).toBe('busy');
		expect(setup.bot.retry(id)).toBe('busy');
		setup.gate.open();
		await setup.settle();
	});
});

describe('approval edge cases', () => {
	const reachAwaitingApproval = async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'approve'));
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('awaiting_approval');

		return setup;
	};

	it('PR merged before you approve → done, and history shows it as merged', async () => {
		const setup = await reachAwaitingApproval();
		const id = setup.statusOf(7)?.id ?? 0;
		const entry = setup.github.pullRequests.get(7);

		if (entry === undefined) {
			throw new Error('missing PR 7');
		}

		entry.live.state = 'closed';
		entry.live.isMerged = true;

		expect(await setup.bot.approve(id)).toBe('not_awaiting_approval');
		expect(setup.github.submissions).toEqual([]);
		expect(setup.bot.getHistory().map(({ number, outcome }) => ({ number, outcome }))).toEqual([
			{ number: 7, outcome: 'merged' },
		]);
	});

	it('double click → exactly one APPROVE', async () => {
		const setup = await reachAwaitingApproval();
		const id = setup.statusOf(7)?.id ?? 0;
		const results = await Promise.all([setup.bot.approve(id), setup.bot.approve(id)]);

		expect(results.sort()).toEqual(['busy', 'ok']);
		expect(
			setup.github.submissions.filter((submission) => submission.event === 'APPROVE'),
		).toHaveLength(1);
	});

	it('stale head → the new head gets reviewed and the old draft can never post', async () => {
		const setup = await reachAwaitingApproval();
		const id = setup.statusOf(7)?.id ?? 0;

		pushCommit(setup, 7, 'head-2');

		expect(await setup.bot.approve(id)).toBe('head_moved');
		expect(await setup.bot.approve(id)).toBe('not_awaiting_approval');

		setup.clock.now += QUIET_PERIOD_MS;
		setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.github.submissions.map((submission) => submission.event)).toEqual(['COMMENT']);
		expect(setup.github.submissions[0]?.commitId).toBe('head-2');
	});

	it('push while awaiting approval → Approve disappears on the next tick, before the quiet period', async () => {
		const setup = await reachAwaitingApproval();

		pushCommit(setup, 7, 'head-2');
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});
});

describe('failure paths', () => {
	it('422 then a second failure → needs you, rounds unchanged', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.github.failSubmissionsWith = [422, 500];
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)).toMatchObject({ status: 'needs_you', rounds: 0 });
	});

	it('422 then folded post succeeds → waiting on author, round 1', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.github.failSubmissionsWith = [422];
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', rounds: 1 });
	});

	it('Claude reviewed a different commit → counts as a failed attempt, no endless rerun', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);

		for (let attempt = 0; attempt < 4; attempt++) {
			setup.claude.reviewOutcomes.push(draftedFor('short-sha', 'comment'));
			await setup.tickAndSettle();
			setup.clock.now += 11 * 60_000;
		}

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.status).toBe('needs_you');
	});

	it('setup broken mid-run → PR queued again, not failed, readiness re-checked', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push({ kind: 'setup_broken', message: 'Not logged in' });
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({ status: 'queued', reason: null });

		setup.readiness.status = 'setup_needed';
		await setup.tickAndSettle();

		expect(setup.bot.getState().readiness.status).toBe('setup_needed');
		expect(setup.claude.reviewCalls).toHaveLength(1);
	});

	it('setup needed → discovery still lists PRs, but Claude never runs', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.readiness.status = 'setup_needed';
		setup.github.addPullRequest(7);
		await setup.tickAndSettle();

		expect(setup.bot.getState().pullRequests).toHaveLength(1);
		expect(setup.claude.reviewCalls).toEqual([]);
	});

	it('crash mid-review, restart, marker already on GitHub → reviewed again but not posted twice', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);
		const { store } = setup.dependencies;

		await setup.bot.tick();
		await setup.settle();
		store.updatePullRequest(setup.statusOf(7)?.id ?? 0, { status: 'reviewing' });
		entry.reviews.push({
			id: 1,
			state: 'COMMENTED',
			body: `Posted before the crash\n${createBotMarker('head-1')}`,
			submittedAt: new Date(setup.clock.now).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});

		expect(store.resetInterruptedReviews(setup.clock.now)).toBe(1);

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});
});

describe('reopen and retry', () => {
	it('re-requested after you approved → reviewed again, not finished by the old approval', async () => {
		const setup = setUp({ reviewMode: 'manual' });
		const entry = setup.github.addPullRequest(7);

		await setup.tickAndSettle();
		entry.reviews.push({
			id: 1,
			state: 'APPROVED',
			body: '',
			submittedAt: new Date(setup.clock.now + 1000).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		entry.isRequested = false;
		setup.clock.now += 2000;
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('done');

		entry.isRequested = true;
		setup.clock.now += 60_000;
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('needs_review');
	});

	it('Review again on a PR you took over → reviews, does not bounce back to needs you', async () => {
		const setup = setUp({ reviewMode: 'manual' });
		const entry = setup.github.addPullRequest(7);

		await setup.tickAndSettle();
		entry.reviews.push({
			id: 1,
			state: 'COMMENTED',
			body: 'Mine',
			submittedAt: new Date(setup.clock.now + 1000).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		setup.clock.now += 2000;
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('needs_you');

		setup.clock.now += 1000;
		expect(setup.bot.retry(setup.statusOf(7)?.id ?? 0)).toBe('ok');
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});
});

describe('reply consent and failures', () => {
	const withQuestion = async (settings = {}) => {
		const setup = setUp({ reviewMode: 'auto', ...settings });
		const entry = setup.github.addPullRequest(7);

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.threads = [
			makeThread([
				makeComment({ databaseId: 1, authorLogin: VIEWER_LOGIN, body: createBotMarker('head-1') }),
				makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' }),
			]),
		];

		return setup;
	};

	it('stopped PR → no reply job', async () => {
		const setup = await withQuestion();

		setup.bot.stop(setup.statusOf(7)?.id ?? 0);
		await setup.tickAndSettle();

		expect(setup.claude.replyPrompts).toEqual([]);
	});

	it('reply posted → the thread itself prevents a second reply', async () => {
		const setup = await withQuestion();

		setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: 'Because.' } });
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.github.replies).toHaveLength(1);
		expect(setup.claude.replyPrompts).toHaveLength(1);
	});

	it('reply job throws → comment marked handled, no retry loop', async () => {
		const setup = await withQuestion();

		setup.claude.replyError = new Error('clone fetch failed');
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.claude.replyPrompts).toHaveLength(1);
		expect(setup.github.replies).toEqual([]);
	});
});

describe('changes while a reply is running', () => {
	const startGatedReply = async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);
		const gate = createGate();

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.threads = [
			makeThread([
				makeComment({ databaseId: 1, authorLogin: VIEWER_LOGIN, body: createBotMarker('head-1') }),
				makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' }),
			]),
		];
		setup.claude.replyGate = gate.promise;
		setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: 'Because.' } });
		await setup.bot.tick();
		await setup.claude.replyEntered;

		expect(setup.claude.replyPrompts).toHaveLength(1);

		return { ...setup, entry, gate };
	};

	const finish = async (setup: Awaited<ReturnType<typeof startGatedReply>>) => {
		setup.gate.open();
		await setup.settle();

		expect(setup.github.replies).toEqual([]);
		expect(setup.dependencies.store.isCommentHandled(2)).toBe(false);
	};

	it('Stop → no reply, stays stopped', async () => {
		const setup = await startGatedReply();

		setup.bot.stop(setup.statusOf(7)?.id ?? 0);
		await finish(setup);
		expect(setup.statusOf(7)?.status).toBe('stopped');
	});

	it('developer reviews by hand → no reply, needs you', async () => {
		const setup = await startGatedReply();

		setup.entry.reviews.push({
			id: 77,
			state: 'COMMENTED',
			body: 'Taking this one',
			submittedAt: new Date(setup.clock.now + 1000).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		await setup.bot.tick();
		await finish(setup);
		expect(setup.statusOf(7)?.status).toBe('needs_you');
	});

	it('review starts on the same PR → no reply, comment not handled, review progress kept', async () => {
		const setup = await startGatedReply();
		const reviewGate = createGate();

		setup.claude.reviewGate = reviewGate.promise;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		expect(setup.bot.requestReview(setup.statusOf(7)?.id ?? 0)).toBe('ok');

		await setup.bot.tick();
		await setup.claude.waitForReviewCall(2);
		setup.gate.open();
		await letPendingJobsRun();

		expect(setup.github.replies).toEqual([]);
		expect(setup.dependencies.store.isCommentHandled(2)).toBe(false);
		expect(setup.statusOf(7)?.progress).toMatchObject({ message: 'Starting the review' });

		reviewGate.open();
		await setup.settle();
	});

	it('Pause → no reply', async () => {
		const setup = await startGatedReply();

		setup.bot.setPaused(true);
		await finish(setup);
	});

	it('answer questions turned off → no reply', async () => {
		const setup = await startGatedReply();

		setup.dependencies.settingsStore.replace({
			...setup.dependencies.settingsStore.get(),
			answerQuestions: false,
		});
		await finish(setup);
	});
});

describe('failure before the review starts', () => {
	it('PR fetch fails → backoff instead of looping, and replies keep running', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);
		const realGetPullRequest = setup.github.getPullRequest;
		const failure = { remaining: 1, syncCalls: 0 };

		await setup.bot.tick();
		await setup.settle();
		setup.dependencies.store.updatePullRequest(setup.statusOf(7)?.id ?? 0, { status: 'queued' });

		setup.github.getPullRequest = async (reference) => {
			failure.syncCalls += 1;

			if (failure.syncCalls === 2 && failure.remaining > 0) {
				failure.remaining -= 1;
				throw new Error('gh: HTTP 502');
			}

			return realGetPullRequest(reference);
		};

		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({
			status: 'waiting_on_author',
			reason: 'gh: HTTP 502',
		});

		entry.reviews.push({
			id: 3,
			state: 'COMMENTED',
			body: createBotMarker('head-0'),
			submittedAt: new Date(setup.clock.now).toISOString(),
			commitId: 'head-0',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		setup.dependencies.store.updatePullRequest(setup.statusOf(7)?.id ?? 0, { rounds: 1 });
		entry.threads = [
			makeThread([
				makeComment({ databaseId: 1, authorLogin: VIEWER_LOGIN, body: createBotMarker('head-0') }),
				makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' }),
			]),
		];
		await setup.tickAndSettle();

		expect(setup.claude.replyPrompts).toHaveLength(1);
	});
});

describe('live progress in /state', () => {
	it('shows subagents and the status line while reviewing, and clears afterwards', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const gate = createGate();

		setup.github.addPullRequest(7);
		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewProgressLines = [
			JSON.stringify({
				type: 'system',
				subtype: 'task_started',
				tool_use_id: 't1',
				subagent_type: 'proxy:architect',
				description: 'Design review',
			}),
			JSON.stringify({
				type: 'assistant',
				parent_tool_use_id: null,
				message: {
					content: [
						{ type: 'text', text: 'PRB_STATUS {"phase":"review","message":"Waiting on advisors"}' },
					],
				},
			}),
		];
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(1);

		expect(setup.statusOf(7)?.progress).toMatchObject({
			message: 'Waiting on advisors',
			subagents: [{ label: 'Architecture', status: 'running' }],
		});

		gate.open();
		await setup.settle();

		expect(setup.statusOf(7)?.progress).toBeNull();
	});
});

describe('progress lifecycle across jobs', () => {
	it('reply job shows "Answering …" while running and nothing afterwards', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);
		const gate = createGate();

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.threads = [
			makeThread([
				makeComment({ databaseId: 1, authorLogin: VIEWER_LOGIN, body: createBotMarker('head-1') }),
				makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' }),
			]),
		];
		setup.claude.replyGate = gate.promise;
		await setup.bot.tick();
		await setup.claude.replyEntered;

		expect(setup.statusOf(7)?.progress).toMatchObject({
			message: 'Answering @ana on src/retry.ts',
			subagents: [],
		});

		gate.open();
		await setup.settle();

		expect(setup.statusOf(7)?.progress).toBeNull();
	});

	it('reply finishes while a review on another PR runs → that review keeps its progress', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);
		const replyGate = createGate();
		const reviewGate = createGate();

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.threads = [
			makeThread([
				makeComment({ databaseId: 1, authorLogin: VIEWER_LOGIN, body: createBotMarker('head-1') }),
				makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' }),
			]),
		];
		setup.github.addPullRequest(8);
		setup.claude.replyGate = replyGate.promise;
		setup.claude.reviewGate = reviewGate.promise;
		setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: 'Because.' } });
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.tick();
		await setup.claude.replyEntered;
		await setup.claude.waitForReviewCall(2);
		replyGate.open();
		await waitUntil(() => setup.github.replies.length === 1);
		await letPendingJobsRun();

		expect(setup.statusOf(7)?.progress).toBeNull();
		expect(setup.statusOf(8)?.progress).toMatchObject({ message: 'Starting the review' });

		reviewGate.open();
		await setup.settle();
	});

	it('review on a PR ends before the reply on it → the reply progress shows until the reply ends', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);
		const replyGate = createGate();

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.threads = [
			makeThread([
				makeComment({ databaseId: 1, authorLogin: VIEWER_LOGIN, body: createBotMarker('head-1') }),
				makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' }),
			]),
		];
		setup.claude.replyGate = replyGate.promise;
		await setup.bot.tick();
		await setup.claude.replyEntered;
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.tick();
		await waitUntil(() => !['queued', 'reviewing'].includes(setup.statusOf(7)?.status ?? ''));
		await letPendingJobsRun();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.progress).toMatchObject({
			message: 'Answering @ana on src/retry.ts',
		});

		replyGate.open();
		await setup.settle();

		expect(setup.statusOf(7)?.progress).toBeNull();
	});

	it('Stop mid-review clears progress once the job ends', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const gate = createGate();

		setup.github.addPullRequest(7);
		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(1);
		setup.bot.stop(setup.statusOf(7)?.id ?? 0);
		gate.open();
		await setup.settle();

		expect(setup.statusOf(7)?.progress).toBeNull();
	});

	it('the next review starts fresh, with no subagents carried over', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewProgressLines = [
			JSON.stringify({
				type: 'system',
				subtype: 'task_started',
				tool_use_id: 't1',
				subagent_type: 'proxy:product',
				description: 'Scope',
			}),
		];
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		setup.github.addPullRequest(8);

		const gate = createGate();

		setup.claude.reviewProgressLines = [];
		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(2);

		const pullRequests = setup.bot.getState().pullRequests;
		const reviewing = pullRequests.find((pullRequest) => pullRequest.status === 'reviewing');
		const finished = pullRequests.find((pullRequest) => pullRequest.status === 'waiting_on_author');

		expect(finished?.progress).toBeNull();
		expect(reviewing?.progress).toMatchObject({ message: 'Starting the review', subagents: [] });

		gate.open();
		await setup.settle();
	});
});

describe('repairing a review that returned no structured result', () => {
	const missingResult = (sessionId: string) => ({
		kind: 'failed' as const,
		summary: "Claude's result had the wrong shape (result: Required)",
		schemaIssues: ['result: Required'],
		repairSessionId: sessionId,
	});
	const failedRepair = missingResult('session-1');

	const wrongShapeRepairs = (count: number) => {
		return Array.from({ length: count }, (_, index) => missingResult(`session-r${index + 1}`));
	};

	const startManualReview = async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();

		return { setup, id: setup.statusOf(7)?.id ?? 0 };
	};

	const storedRepairFields = (setup: ReturnType<typeof setUp>, id: number) => {
		const tracked = setup.dependencies.store.getPullRequest(id);

		return { sessionId: tracked?.repairSessionId, headSha: tracked?.repairHeadSha };
	};

	it("missing result → resumed in the job's worktree, draft held, no second full review", async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.claude.repairCalls).toEqual([
			{ sessionId: 'session-1', clonePath: setup.clones.prepared[0] ?? '', attempt: 1 },
		]);
		expect(setup.clones.prepared).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('repair fails twice then succeeds → 3 repairs with a pause between, still one full review', async () => {
		const { setup, id } = await startManualReview();
		const pauses: number[] = [];

		setup.dependencies.sleep = async (milliseconds) => {
			pauses.push(milliseconds);
		};

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(failedRepair, failedRepair, draftedFor('head-1', 'comment'));
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls.map((call) => call.attempt)).toEqual([1, 2, 3]);
		expect(pauses).toEqual([REPAIR_PAUSE_MS, REPAIR_PAUSE_MS]);
		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('5 failed repairs → normal failure, the newest session is saved for the next attempt', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(...wrongShapeRepairs(MAX_REPAIR_ATTEMPTS));
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls).toHaveLength(MAX_REPAIR_ATTEMPTS);
		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)).toMatchObject({
			status: 'waiting_on_author',
			reason: UNREPAIRED_RESULT_SUMMARY,
		});
		expect(UNREPAIRED_RESULT_SUMMARY).toBe(
			'Claude finished but never returned the review (5 repair tries failed)',
		);
		expect(setup.claude.repairCalls.map((call) => call.sessionId)).toEqual([
			'session-1',
			'session-r1',
			'session-r2',
			'session-r3',
			'session-r4',
		]);
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: 'session-r5', headSha: 'head-1' });
	});

	it('Review Again on the same head → the saved session is repaired in a fresh worktree, no full review', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.claude.repairOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.claude.repairCalls.at(-1)).toEqual({
			sessionId: 'session-1',
			clonePath: setup.clones.prepared[1] ?? '',
			attempt: 1,
		});
		expect(setup.clones.prepared[1]).not.toBe(setup.clones.prepared[0]);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('saved session repairs all fail → falls back to a full review in the same job', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(...wrongShapeRepairs(MAX_REPAIR_ATTEMPTS));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.claude.repairOutcomes.push(...wrongShapeRepairs(MAX_REPAIR_ATTEMPTS));
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls).toHaveLength(MAX_REPAIR_ATTEMPTS * 2);
		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('the head moved since the failure → a full review on the new head, the old session is dropped', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.bot.requestReview(id);
		await setup.settle();
		pushCommit(setup, 7, 'head-2');
		setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls).toHaveLength(1);
		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('each repair try shows progress, keeping the advisors from the full review', async () => {
		const { setup, id } = await startManualReview();
		const gate = createGate();

		setup.claude.reviewProgressLines = [
			JSON.stringify({
				type: 'system',
				subtype: 'task_started',
				tool_use_id: 't1',
				subagent_type: 'proxy:product',
				description: 'Scope',
			}),
		];
		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(failedRepair);
		setup.claude.repairGate = gate.promise;
		setup.bot.requestReview(id);
		await waitUntil(() => setup.claude.repairCalls.length === 1);

		const progress = setup.statusOf(7)?.progress;

		expect(progress?.message).toBe(repairProgressMessage(1));
		expect(progress?.subagents.map((subagent) => subagent.label)).toEqual(['Product']);

		setup.claude.repairOutcomes.push(draftedFor('head-1', 'comment'));
		gate.open();
		await setup.settle();

		expect(repairProgressMessage(2)).toBe('Collecting the finished review (try 2 of 5)');
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('Review Again repairs show progress too, starting from a fresh progress', async () => {
		const { setup, id } = await startManualReview();
		const gate = createGate();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.claude.repairGate = gate.promise;
		setup.claude.repairOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(id);
		await waitUntil(() => setup.claude.repairCalls.length === MAX_REPAIR_ATTEMPTS + 1);

		expect(setup.statusOf(7)?.progress).toMatchObject({
			message: repairProgressMessage(1),
			subagents: [],
		});

		gate.open();
		await setup.settle();
	});

	it('a repair returning outcome "failed" → a normal failed review, the session is cleared', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push({
			kind: 'result',
			result: { outcome: 'failed', summary: 'Could not read the diff' },
		});
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls).toHaveLength(1);
		expect(setup.statusOf(7)).toMatchObject({
			status: 'waiting_on_author',
			reason: 'Could not read the diff',
		});
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('Stop during repairs → the running repair is aborted, no more tries, worktree released', async () => {
		const { setup, id } = await startManualReview();
		const gate = createGate();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairGate = gate.promise;
		setup.bot.requestReview(id);
		await waitUntil(() => setup.claude.repairCalls.length === 1);
		setup.bot.stop(id);
		await setup.settle();

		expect(setup.claude.abortedRepairs).toBe(1);
		expect(setup.claude.repairCalls).toHaveLength(1);
		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('stopped');
		expect(setup.clones.released).toEqual(setup.clones.prepared);
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('released just as the full review returns a wrong-shape result → no session saved, no repair', async () => {
		const { setup, id } = await startManualReview();
		const gate = createGate();

		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.bot.requestReview(id);
		await setup.claude.waitForReviewCall(1);
		setup.dependencies.store.updatePullRequest(id, { status: 'stopped' });
		gate.open();
		await setup.settle();

		expect(setup.claude.repairCalls).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('stopped');
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('released just as a repair returns another wrong-shape result → that session is not saved', async () => {
		const { setup, id } = await startManualReview();
		const gate = createGate();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(missingResult('session-r1'));
		setup.claude.repairGate = gate.promise;
		setup.bot.requestReview(id);
		await waitUntil(() => setup.claude.repairCalls.length === 1);
		setup.dependencies.store.updatePullRequest(id, {
			status: 'stopped',
			repairSessionId: null,
			repairHeadSha: null,
			repairSavedAt: null,
		});
		gate.open();
		await setup.settle();

		expect(setup.claude.repairCalls).toHaveLength(1);
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('the saved session is gone (no conversation) → one repair, then a full review, session cleared', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(...wrongShapeRepairs(MAX_REPAIR_ATTEMPTS));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.claude.repairOutcomes.push({
			kind: 'failed',
			summary: 'Claude exited 1 without a result: No conversation found with session ID',
		});
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls).toHaveLength(MAX_REPAIR_ATTEMPTS + 1);
		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('a repaired result that fails to apply (GitHub error) → the session is kept for the retry', async () => {
		const { setup, id } = await startManualReview();
		const gate = createGate();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(draftedFor('head-1', 'comment'));
		setup.claude.repairGate = gate.promise;
		setup.bot.requestReview(id);
		await waitUntil(() => setup.claude.repairCalls.length === 1);
		setup.github.failPullRequestFetchesWith.push(502);
		gate.open();
		await setup.settle();

		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: 'session-1', headSha: 'head-1' });
	});

	it('the card shows the current try while a later repair runs', async () => {
		const { setup, id } = await startManualReview();
		const firstGate = createGate();
		const secondGate = createGate();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(failedRepair, draftedFor('head-1', 'comment'));
		setup.claude.repairGate = firstGate.promise;
		setup.bot.requestReview(id);
		await waitUntil(() => setup.claude.repairCalls.length === 1);
		setup.claude.repairGate = secondGate.promise;
		firstGate.open();
		await waitUntil(() => setup.claude.repairCalls.length === 2);

		expect(setup.statusOf(7)?.progress?.message).toBe(repairProgressMessage(2));

		secondGate.open();
		await setup.settle();

		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('after giving up on a commit, Review Again still resumes the saved session first', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(...wrongShapeRepairs(MAX_REPAIR_ATTEMPTS));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.dependencies.store.updatePullRequest(id, {
			status: 'needs_you',
			lastError: 'Review failed 2 times on this commit',
		});
		setup.claude.repairOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.retry(id);
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.claude.repairCalls.at(-1)?.sessionId).toBe('session-r5');
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('the automatic retry after the backoff resumes the saved session, no second full review', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(...wrongShapeRepairs(MAX_REPAIR_ATTEMPTS));
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');

		setup.clock.now += 11 * 60_000;
		setup.claude.repairOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.claude.repairCalls).toHaveLength(MAX_REPAIR_ATTEMPTS + 1);
		expect(setup.github.submissions.map((submission) => submission.event)).toEqual(['COMMENT']);
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});

	it('the session is saved as soon as the wrong-shape result arrives, before the first repair', async () => {
		const { setup, id } = await startManualReview();
		const gate = createGate();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairGate = gate.promise;
		setup.bot.requestReview(id);
		await waitUntil(() => setup.claude.repairCalls.length === 1);

		expect(storedRepairFields(setup, id)).toEqual({ sessionId: 'session-1', headSha: 'head-1' });
		expect(setup.dependencies.store.getPullRequest(id)?.repairSavedAt).toBe(setup.clock.now);

		setup.claude.repairOutcomes.push(draftedFor('head-1', 'comment'));
		gate.open();
		await setup.settle();
	});

	it('usage limit during the in-job repair → requeued, the session is kept', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push({ kind: 'usage_limited', resumeAt: setup.clock.now + 60_000 });
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.statusOf(7)?.status).toBe('queued');
		expect(setup.bot.getState().usageLimitedUntil).toBe(setup.clock.now + 60_000);
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: 'session-1', headSha: 'head-1' });
	});

	it('usage limit during a saved-session repair → requeued, the session is kept, no full review', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.claude.repairOutcomes.push({ kind: 'setup_broken', message: 'Not logged in' });
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('queued');
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: 'session-1', headSha: 'head-1' });
	});

	it('a repair that times out or finds no conversation → stops retrying at once', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push({
			kind: 'failed',
			summary: 'Claude exited 1 without a result: No conversation found with session ID',
		});
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.reason).toBe(
			'Claude finished but never returned the review (repair stopped: Claude exited 1 without a result: No conversation found with session ID)',
		);
	});

	it('Stop during saved-session repairs → no full review is started', async () => {
		const { setup, id } = await startManualReview();
		const gate = createGate();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.claude.repairGate = gate.promise;
		setup.bot.requestReview(id);
		await waitUntil(() => setup.claude.repairCalls.length === 2);
		setup.bot.stop(id);
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.claude.abortedRepairs).toBe(1);
		expect(setup.statusOf(7)?.status).toBe('stopped');
	});

	it('Stop clears the saved session', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.bot.stop(id);

		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('a saved session older than 24 hours → not resumed, a full review runs', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.bot.requestReview(id);
		await setup.settle();
		setup.clock.now += SAVED_SESSION_MAX_AGE_MS + 1;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls).toHaveLength(1);
		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(storedRepairFields(setup, id)).toEqual({ sessionId: null, headSha: null });
	});

	it('auto mode, auto-approve off: a repaired approving result waits for your approval, like any other', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(draftedFor('head-1', 'approve'));
		await setup.tickAndSettle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('awaiting_approval');
	});

	it('auto mode with auto-approve on: a repaired approving result is approved on its own', async () => {
		const setup = setUp({ reviewMode: 'auto', autoApprove: 'on' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(missingResult('session-1'));
		setup.claude.repairOutcomes.push(draftedFor('head-1', 'approve'));
		await setup.tickAndSettle();

		expect(setup.github.submissions.map((submission) => submission.event)).toEqual(['APPROVE']);
		expect(setup.statusOf(7)?.status).toBe('done');
	});

	it('auto mode: a result recovered from the text fallback posts on its own, like any other', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push({ ...draftedFor('head-1', 'comment'), isRecovered: true });
		await setup.tickAndSettle();

		expect(setup.github.submissions.map((submission) => submission.event)).toEqual(['COMMENT']);
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});

	it('a failure with no session to resume (e.g. a timeout) → no repair attempted', async () => {
		const { setup, id } = await startManualReview();

		setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
		setup.bot.requestReview(id);
		await setup.settle();

		expect(setup.claude.repairCalls).toEqual([]);
		expect(setup.statusOf(7)?.reason).toBe('Claude run timed out');
	});
});

describe('manual-mode drafts', () => {
	const reachDraft = async (filing: 'approve' | 'comment' = 'comment') => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push({
			kind: 'result',
			result: makeDraft({
				headRefOid: 'head-1',
				filing,
				comments: [
					{ path: 'src/retry.ts', line: 12, side: 'RIGHT', body: 'No delay between attempts.' },
					{ path: 'src/retry.ts', line: 30, side: 'RIGHT', body: 'Magic number.' },
				],
			}),
		});
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('draft_ready');

		return { ...setup, id: setup.statusOf(7)?.id ?? 0 };
	};

	const editedPost = (overrides: Record<string, unknown> = {}) => ({
		headSha: 'head-1',
		event: 'COMMENT',
		mainReview: 'Edited by you',
		comments: [{ path: 'src/retry.ts', line: 12, side: 'RIGHT', body: 'Please add a backoff.' }],
		fileComments: [],
		...overrides,
	});

	it('getDraft returns the held draft with its head', async () => {
		const setup = await reachDraft();

		expect(setup.bot.getDraft(setup.id)).toMatchObject({
			headSha: 'head-1',
			comments: [{ line: 12 }, { line: 30 }],
		});
		expect(setup.bot.getDraft(999)).toBe('not_found');
	});

	it('posting your edits sends exactly them, with the marker, and counts a round', async () => {
		const setup = await reachDraft();

		expect((await setup.bot.postDraft(setup.id, editedPost())).result).toBe('ok');

		const [submission] = setup.github.submissions;

		expect(submission?.event).toBe('COMMENT');
		expect(submission?.body.startsWith('Edited by you')).toBe(true);
		expect(submission?.comments).toHaveLength(1);
		expect(submission?.comments[0]?.body).toContain('Please add a backoff.');
		expect(submission?.comments[0]?.body).toContain(createBotMarker('head-1'));
		expect(setup.statusOf(7)).toMatchObject({
			status: 'waiting_on_author',
			rounds: 1,
			draft: null,
		});
	});

	it('approve filing can be posted as APPROVE or downgraded to a comment', async () => {
		const approving = await reachDraft('approve');

		expect(
			(await approving.bot.postDraft(approving.id, editedPost({ event: 'APPROVE' }))).result,
		).toBe('ok');
		expect(approving.github.submissions[0]?.event).toBe('APPROVE');
		expect(approving.statusOf(7)?.status).toBe('done');

		const downgraded = await reachDraft('approve');

		expect((await downgraded.bot.postDraft(downgraded.id, editedPost())).result).toBe('ok');
		expect(downgraded.github.submissions[0]?.event).toBe('COMMENT');
	});

	it('invalid edits → invalid_draft and nothing posted', async () => {
		const setup = await reachDraft();
		const invented = editedPost({
			comments: [{ path: 'src/other.ts', line: 1, side: 'RIGHT', body: 'x' }],
		});

		expect((await setup.bot.postDraft(setup.id, invented)).result).toBe('invalid_draft');
		expect(await setup.bot.postDraft(setup.id, editedPost({ event: 'APPROVE' }))).toEqual({
			result: 'invalid_draft',
			reason: 'this draft cannot approve',
		});
		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('new commits before you post → head_moved, nothing posted, and the new head is reviewed', async () => {
		const setup = await reachDraft();

		pushCommit(setup, 7, 'head-2');

		expect((await setup.bot.postDraft(setup.id, editedPost())).result).toBe('head_moved');
		expect(setup.github.submissions).toEqual([]);

		setup.clock.now += QUIET_PERIOD_MS;
		setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(setup.github.submissions).toEqual([]);
	});

	it('a push while the draft waits clears it on the next tick', async () => {
		const setup = await reachDraft();

		pushCommit(setup, 7, 'head-2');
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', draft: null });
	});

	it('discard → no post, no re-review until the author pushes', async () => {
		const setup = await reachDraft();

		expect(setup.bot.discardDraft(setup.id)).toBe('ok');
		expect(setup.bot.discardDraft(setup.id)).toBe('no_draft');
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});

	it('double click on Post → one review', async () => {
		const setup = await reachDraft();
		const results = await Promise.all([
			setup.bot.postDraft(setup.id, editedPost()),
			setup.bot.postDraft(setup.id, editedPost()),
		]);

		expect(results.map((outcome) => outcome.result).sort()).toEqual(['busy', 'ok']);
		expect(setup.github.submissions).toHaveLength(1);
	});
});

describe('manual-mode draft edge cases', () => {
	const reachDraft = async (filing: 'approve' | 'comment' = 'comment') => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push({
			kind: 'result',
			result: makeDraft({
				headRefOid: 'head-1',
				filing,
				comments: [
					{ path: 'src/retry.ts', line: 12, side: 'RIGHT', body: 'A' },
					{ path: 'src/retry.ts', line: 30, side: 'RIGHT', body: 'B' },
				],
				fileComments: [{ path: 'src/old.ts', body: 'C' }],
			}),
		});
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		await setup.tickAndSettle();

		return { ...setup, id: setup.statusOf(7)?.id ?? 0 };
	};

	const post = {
		headSha: 'head-1',
		event: 'COMMENT',
		mainReview: 'Main',
		comments: [],
		fileComments: [],
	};

	it('/state draft summary has the filing, summary and every comment counted', async () => {
		const setup = await reachDraft('approve');

		expect(setup.statusOf(7)?.draft).toEqual({
			filing: 'approve',
			summary: 'Retry loop never backs off',
			commentCount: 3,
		});
	});

	it('Review again on a held draft → old draft gone everywhere, and stays gone if that review fails', async () => {
		const setup = await reachDraft();

		setup.bot.requestReview(setup.id);

		expect(setup.statusOf(7)?.draft).toBeNull();
		expect(setup.bot.getDraft(setup.id)).toBe('no_draft');

		setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.draft).toBeNull();
	});

	it('edits from a window opened on an older draft → head_moved, nothing posted', async () => {
		const setup = await reachDraft();

		expect((await setup.bot.postDraft(setup.id, { ...post, headSha: 'head-0' })).result).toBe(
			'head_moved',
		);
		expect(setup.github.submissions).toEqual([]);
	});

	it('GitHub fails while posting → draft kept, guard released, retry posts once', async () => {
		const setup = await reachDraft();

		setup.github.failSubmissionsWith = [500];

		await expect(setup.bot.postDraft(setup.id, post)).rejects.toThrow();
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(setup.bot.getDraft(setup.id)).not.toBe('no_draft');
		expect((await setup.bot.postDraft(setup.id, post)).result).toBe('ok');
		expect(setup.github.submissions).toHaveLength(1);
	});

	it('Approve on a draft_ready PR: approve filing posts it unedited; comment filing is refused', async () => {
		const approving = await reachDraft('approve');

		expect(await approving.bot.approve(approving.id)).toBe('ok');
		expect(approving.github.submissions[0]?.event).toBe('APPROVE');

		const commenting = await reachDraft('comment');

		expect(await commenting.bot.approve(commenting.id)).toBe('invalid_draft');
		expect(commenting.github.submissions).toEqual([]);
	});

	it('Discard while a post is in flight → busy, then exactly one review', async () => {
		const setup = await reachDraft();
		const gate = createGate();
		const realSubmit = setup.github.submitReview;

		setup.github.submitReview = async (reference, submission) => {
			await gate.promise;
			await realSubmit(reference, submission);
		};

		const posting = setup.bot.postDraft(setup.id, post);

		await Promise.resolve();
		await Promise.resolve();

		expect(setup.bot.discardDraft(setup.id)).toBe('busy');

		gate.open();

		expect((await posting).result).toBe('ok');
		expect(setup.github.submissions).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});

	it('you start reviews, they post on their own: a comment review posts once you click Review', async () => {
		const setup = setUp({ reviewMode: 'manual', postReviews: 'auto' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(0);

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.github.submissions.map((submission) => submission.event)).toEqual(['COMMENT']);
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});

	it('a draft held under Ask me first stays held after switching Post reviews to Automatically', async () => {
		const setup = setUp({ reviewMode: 'auto', postReviews: 'ask' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('draft_ready');

		setup.dependencies.settingsStore.replace({
			...setup.dependencies.settingsStore.get(),
			postReviews: 'auto',
		});
		await setup.tickAndSettle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('reviews start on their own, you post each draft: the result is held', async () => {
		const setup = setUp({ reviewMode: 'auto', postReviews: 'ask' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('Post reviews on Ask me first: a recovered result is held like any other', async () => {
		const setup = setUp({ reviewMode: 'auto', postReviews: 'ask' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push({ ...draftedFor('head-1', 'comment'), isRecovered: true });
		await setup.tickAndSettle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('a review started while posting automatically is held as a draft if you switch Post reviews to Ask me first before it finishes', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const gate = createGate();

		setup.github.addPullRequest(7);
		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(1);
		setup.dependencies.settingsStore.replace({
			...setup.dependencies.settingsStore.get(),
			postReviews: 'ask',
		});
		gate.open();
		await setup.settle();

		expect(setup.statusOf(7)?.status).toBe('draft_ready');
		expect(setup.github.submissions).toEqual([]);
	});

	it('replies still run while a draft waits', async () => {
		const setup = await reachDraft();
		const entry = setup.github.pullRequests.get(7);

		setup.dependencies.store.updatePullRequest(setup.id, { rounds: 1 });

		if (entry !== undefined) {
			entry.threads = [
				makeThread([
					makeComment({
						databaseId: 1,
						authorLogin: VIEWER_LOGIN,
						body: createBotMarker('head-0'),
					}),
					makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' }),
				]),
			];
		}

		setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: 'Because.' } });
		await setup.tickAndSettle();

		expect(setup.github.replies).toHaveLength(1);
	});
});

describe('request changes from a draft', () => {
	it('posts REQUEST_CHANGES and waits on the author; its own review is not a manual takeover', async () => {
		const setup = setUp({ reviewMode: 'manual' });
		const entry = setup.github.addPullRequest(7);

		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		await setup.tickAndSettle();

		const id = setup.statusOf(7)?.id ?? 0;
		const body = {
			headSha: 'head-1',
			event: 'REQUEST_CHANGES',
			mainReview: 'Please fix the backoff',
			comments: [],
			fileComments: [],
		};

		expect((await setup.bot.postDraft(id, body)).result).toBe('ok');
		expect(setup.github.submissions[0]?.event).toBe('REQUEST_CHANGES');
		expect(entry.reviews.at(-1)?.state).toBe('CHANGES_REQUESTED');
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');

		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});

	it('already requested changes for this head (crash after post) → not posted twice', async () => {
		const setup = setUp({ reviewMode: 'manual' });
		const entry = setup.github.addPullRequest(7);

		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		setup.bot.requestReview(setup.statusOf(7)?.id ?? 0);
		await setup.tickAndSettle();
		entry.reviews.push({
			id: 1,
			state: 'CHANGES_REQUESTED',
			body: `Earlier\n${createBotMarker('head-1')}`,
			submittedAt: new Date(setup.clock.now).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});

		const result = await setup.bot.postDraft(setup.statusOf(7)?.id ?? 0, {
			headSha: 'head-1',
			event: 'REQUEST_CHANGES',
			mainReview: 'Please fix the backoff',
			comments: [],
			fileComments: [],
		});

		expect(result.result).toBe('ok');
		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
	});
});

describe('worktree release', () => {
	const reviewOnce = async (setup: ReturnType<typeof setUp>): Promise<void> => {
		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
	};

	const expectReleasedOnce = (setup: ReturnType<typeof setUp>): void => {
		expect(setup.clones.prepared).toHaveLength(1);
		expect(setup.clones.released).toEqual(setup.clones.prepared);
	};

	it('review posted → its worktree released once', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await reviewOnce(setup);

		expectReleasedOnce(setup);
		expect(setup.github.submissions).toHaveLength(1);
	});

	it('review failed → released once, failure recorded', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
		await reviewOnce(setup);

		expectReleasedOnce(setup);
		expect(setup.statusOf(7)?.reason).toBe('Claude run timed out');
	});

	it('usage limited → released once, PR queued again', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.claude.reviewOutcomes.push({ kind: 'usage_limited', resumeAt: setup.clock.now + 60_000 });
		await reviewOnce(setup);

		expectReleasedOnce(setup);
		expect(setup.statusOf(7)?.status).toBe('queued');
	});

	it('setup broken → released once, PR queued again', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.claude.reviewOutcomes.push({ kind: 'setup_broken', message: 'Not logged in' });
		await reviewOnce(setup);

		expectReleasedOnce(setup);
		expect(setup.statusOf(7)?.status).toBe('queued');
	});

	it('runReview rejects → released once, failure recorded', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.claude.reviewError = new Error('spawn failed');
		await reviewOnce(setup);

		expectReleasedOnce(setup);
		expect(setup.statusOf(7)?.reason).toContain('spawn failed');
	});

	it('runReview throws synchronously → released once, failure recorded', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.claude.reviewSyncError = new Error('bad arguments');
		await reviewOnce(setup);

		expectReleasedOnce(setup);
		expect(setup.statusOf(7)?.reason).toContain('bad arguments');
	});

	it('posting the result throws → released once, failure recorded', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.failSubmissionsWith.push(500);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await reviewOnce(setup);

		expectReleasedOnce(setup);
		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.reason).not.toBeNull();
	});

	it('Stop mid-review, then the run ends → released once, nothing posted', async () => {
		const setup = setUp({ reviewMode: 'auto' });
		const gate = createGate();

		setup.github.addPullRequest(7);
		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.tick();
		await setup.claude.waitForReviewCall(1);
		setup.bot.stop(setup.statusOf(7)?.id ?? 0);

		expect(setup.clones.released).toEqual([]);

		gate.open();
		await setup.settle();

		expectReleasedOnce(setup);
		expect(setup.github.submissions).toEqual([]);
	});

	it('three parallel reviews → three distinct worktrees, each released once', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		for (const number of [7, 8, 9]) {
			setup.github.addPullRequest(number);
		}

		setup.claude.reviewOutcomes.push(...[1, 2, 3].map(() => draftedFor('head-1', 'comment')));
		await setup.tickAndSettle();

		expect(new Set(setup.clones.prepared).size).toBe(3);
		expect(setup.clones.released.toSorted()).toEqual(setup.clones.prepared.toSorted());
	});

	it('preparing the clone fails → nothing to release, failure recorded, no Claude run', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.clones.prepareError = new Error('clone failed');
		await reviewOnce(setup);

		expect(setup.clones.released).toEqual([]);
		expect(setup.claude.reviewCalls).toEqual([]);
		expect(setup.statusOf(7)?.reason).toContain('clone failed');
	});

	describe('replies', () => {
		const setUpReply = async () => {
			const setup = setUp({ reviewMode: 'auto' });
			const entry = setup.github.addPullRequest(7);

			setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
			await setup.tickAndSettle();
			entry.threads = [
				makeThread([
					makeComment({
						databaseId: 1,
						authorLogin: VIEWER_LOGIN,
						body: `Finding\n${createBotMarker('head-1')}`,
					}),
					makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why is this wrong?' }),
				]),
			];

			return setup;
		};

		const expectReplyReleased = (setup: ReturnType<typeof setUp>): void => {
			expect(setup.clones.prepared).toHaveLength(2);
			expect(setup.clones.released.toSorted()).toEqual(setup.clones.prepared.toSorted());
		};

		it('reply posted → released once', async () => {
			const setup = await setUpReply();

			setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: 'Because X.' } });
			await setup.tickAndSettle();

			expectReplyReleased(setup);
			expect(setup.github.replies).toHaveLength(1);
		});

		it('reply throws → released once, comment marked handled', async () => {
			const setup = await setUpReply();

			setup.claude.replyError = new Error('reply crashed');
			await setup.tickAndSettle();

			expectReplyReleased(setup);
			expect(setup.dependencies.store.isCommentHandled(2)).toBe(true);
		});

		it('reply usage limited → released once, comment left for later', async () => {
			const setup = await setUpReply();

			setup.claude.replyOutcomes.push({
				kind: 'usage_limited',
				resumeAt: setup.clock.now + 60_000,
			});
			await setup.tickAndSettle();

			expectReplyReleased(setup);
			expect(setup.dependencies.store.isCommentHandled(2)).toBe(false);
		});

		it('paused mid-reply → released once, nothing posted', async () => {
			const setup = await setUpReply();
			const gate = createGate();

			setup.claude.replyGate = gate.promise;
			setup.claude.replyOutcomes.push({ kind: 'result', result: { reply: 'Because X.' } });
			await setup.bot.tick();
			await setup.claude.replyEntered;
			setup.bot.setPaused(true);
			gate.open();
			await setup.settle();

			expectReplyReleased(setup);
			expect(setup.github.replies).toEqual([]);
		});
	});
});

describe('adding a PR by link', () => {
	const linkTo = (number: number) => `https://github.com/acme/api/pull/${number}`;

	const setUpWithViewer = async (settings = {}) => {
		const setup = setUp(settings);

		await setup.tickAndSettle();

		return setup;
	};

	const addOtherPullRequest = (setup: ReturnType<typeof setUp>, number: number, overrides = {}) => {
		const entry = setup.github.addPullRequest(number, overrides);

		entry.isRequested = false;

		return entry;
	};

	it('a PR nobody requested you on → tracked as a link PR and reviewed right away', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'manual' });

		addOtherPullRequest(setup, 7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		const result = await setup.bot.addPullRequest(linkTo(7));

		await setup.settle();

		expect(result).toMatchObject({ kind: 'added', isExisting: false });
		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)).toMatchObject({
			status: 'draft_ready',
			source: 'link',
			isStarted: true,
			isOwn: false,
		});
		expect(setup.dependencies.store.getPullRequest(setup.statusOf(7)?.id ?? 0)?.isRequested).toBe(
			false,
		);
	});

	it('a link PR you are never requested on → kept and re-reviewed when new commits land', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'auto' });

		addOtherPullRequest(setup, 7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.addPullRequest(linkTo(7));
		await setup.settle();
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');

		pushCommit(setup, 7, 'head-2');
		await setup.tickAndSettle();
		setup.clock.now += QUIET_PERIOD_MS;
		setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', rounds: 2 });
	});

	it('a draft PR → started but waits, no review until it is ready', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'manual' });
		const entry = addOtherPullRequest(setup, 7, { isDraft: true });

		await setup.bot.addPullRequest(linkTo(7));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(0);
		expect(setup.statusOf(7)).toMatchObject({
			status: 'needs_review',
			isStarted: true,
			isDraft: true,
		});

		entry.live.isDraft = false;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)).toMatchObject({ status: 'draft_ready', isDraft: false });
	});

	it('a PR already being reviewed → existing, nothing restarts', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'manual' });
		const gate = createGate();

		addOtherPullRequest(setup, 7);
		setup.claude.reviewGate = gate.promise;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.addPullRequest(linkTo(7));

		const again = await setup.bot.addPullRequest(linkTo(7));

		gate.open();
		await setup.settle();

		expect(again).toMatchObject({ kind: 'added', isExisting: true });
		expect(setup.claude.reviewCalls).toHaveLength(1);
	});

	it('a requested PR you have not started → queued like clicking Review', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		const result = await setup.bot.addPullRequest(linkTo(7));

		await setup.settle();

		expect(result).toMatchObject({ kind: 'added', isExisting: false });
		expect(setup.statusOf(7)).toMatchObject({ status: 'draft_ready', source: 'requested' });
	});

	it('a PR you took over, with your old review → restarts cleanly, no instant take-over', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'auto' });
		const entry = setup.github.addPullRequest(7);

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();
		entry.reviews.push({
			id: 99,
			state: 'CHANGES_REQUESTED',
			body: 'Please split this',
			submittedAt: new Date(setup.clock.now + 1000).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		pushCommit(setup, 7, 'head-2');
		setup.clock.now += QUIET_PERIOD_MS * 2;
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('needs_you');

		setup.clock.now += 60_000;
		setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));
		await setup.bot.addPullRequest(linkTo(7));
		await setup.settle();
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
		expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', source: 'link' });
	});

	it('the same PR pasted twice at once → one row, both succeed', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'manual' });

		addOtherPullRequest(setup, 7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		const results = await Promise.all([
			setup.bot.addPullRequest(linkTo(7)),
			setup.bot.addPullRequest(linkTo(7)),
		]);

		await setup.settle();

		expect(results.map((result) => result.kind)).toEqual(['added', 'added']);
		expect(setup.bot.getState().pullRequests).toHaveLength(1);
	});

	it('a link in different case, or to a renamed repo → the same row as the canonical PR', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'manual' });

		setup.github.addPullRequest(7, { owner: 'Acme', repo: 'API' });
		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.addPullRequest('https://github.com/acme/api/pull/7');
		await setup.bot.addPullRequest('https://github.com/old-name/old-api/pull/7');
		await setup.settle();

		expect(setup.bot.getState().pullRequests).toHaveLength(1);
		expect(setup.claude.reviewCalls).toHaveLength(1);
	});

	it.each([
		['not a link', { kind: 'invalid_link' }],
		['https://gitlab.com/acme/api/pull/7', { kind: 'unsupported_host' }],
		['https://github.com/acme/api/pull/404', { kind: 'pr_not_found' }],
	] as const)('%s → %o', async (url, expected) => {
		const setup = await setUpWithViewer();

		expect(await setup.bot.addPullRequest(url)).toEqual(expected);
		expect(setup.bot.getState().pullRequests).toHaveLength(0);
	});

	it.each([
		[403, { kind: 'no_access' }],
		[429, { kind: 'no_access' }],
		[500, { kind: 'github_unavailable' }],
	] as const)('GitHub answers %i → %o', async (status, expected) => {
		const setup = await setUpWithViewer();

		addOtherPullRequest(setup, 7);
		setup.github.failPullRequestFetchesWith.push(status);

		expect(await setup.bot.addPullRequest(linkTo(7))).toEqual(expected);
		expect(setup.bot.getState().pullRequests).toHaveLength(0);
	});

	it.each([
		['stopped', { status: 'stopped', rounds: 1 }],
		['done after the round limit', { status: 'done', rounds: 5 }],
		['blocked', { status: 'blocked', rounds: 2, lastError: 'PR kept changing' }],
	] as const)('re-adding a %s PR → a fresh cycle that starts at once', async (_label, previous) => {
		const setup = await setUpWithViewer({ reviewMode: 'manual' });
		const outcomes: unknown[] = [];
		const logInfo = setup.dependencies.logger.info;

		addOtherPullRequest(setup, 7);
		await setup.bot.addPullRequest(linkTo(7));
		await setup.settle();
		setup.dependencies.store.updatePullRequest(setup.statusOf(7)?.id ?? 0, {
			...previous,
			pendingApproval: null,
		});

		setup.dependencies.logger.info = (event, fields) => {
			if (event === 'pull_request_added_by_link') {
				outcomes.push(fields?.outcome);
			}

			logInfo(event, fields);
		};

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		const callsBefore = setup.claude.reviewCalls.length;
		const result = await setup.bot.addPullRequest(linkTo(7));

		expect(result).toMatchObject({ kind: 'added', isExisting: false });
		expect(setup.statusOf(7)).toMatchObject({ rounds: 0, source: 'link', reason: null });
		expect(
			setup.statusOf(7)?.status === 'queued' || setup.statusOf(7)?.status === 'reviewing',
		).toBe(true);
		expect(outcomes).toEqual(['requeued']);

		await setup.settle();

		expect(setup.claude.reviewCalls).toHaveLength(callsBefore + 1);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it('the skip list does not stop a PR you added by link', async () => {
		const setup = await setUpWithViewer({ reviewMode: 'manual', skip: ['acme'] });

		addOtherPullRequest(setup, 7);
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.addPullRequest(linkTo(7));
		await setup.settle();
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.statusOf(7)?.status).toBe('draft_ready');
	});

	it.each([
		[true, 'merged'],
		[false, 'closed'],
	] as const)('closed PR (merged %s) → pr_closed %s', async (isMerged, reason) => {
		const setup = await setUpWithViewer();

		addOtherPullRequest(setup, 7, { state: 'closed', isMerged });

		expect(await setup.bot.addPullRequest(linkTo(7))).toEqual({ kind: 'pr_closed', reason });
	});
});

describe('your own PR', () => {
	const addOwnPullRequest = async (settings = {}) => {
		const setup = setUp(settings);

		await setup.tickAndSettle();

		const entry = setup.github.addPullRequest(7, { author: 'Luka' });

		entry.isRequested = false;

		return { setup, entry };
	};

	it('auto mode with auto-approve on → the approve filing posts as a COMMENT', async () => {
		const { setup } = await addOwnPullRequest({ reviewMode: 'auto', autoApprove: 'on' });

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'approve'));
		await setup.bot.addPullRequest('https://github.com/acme/api/pull/7');
		await setup.settle();

		expect(setup.github.submissions.map((submission) => submission.event)).toEqual(['COMMENT']);
		expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', isOwn: true });
	});

	it('manual mode → the held draft is a comment, Approve is refused, the draft says it is yours', async () => {
		const { setup } = await addOwnPullRequest({ reviewMode: 'manual' });

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'approve'));
		await setup.bot.addPullRequest('https://github.com/acme/api/pull/7');
		await setup.settle();

		const id = setup.statusOf(7)?.id ?? 0;

		expect(setup.statusOf(7)?.draft?.filing).toBe('comment');
		expect(setup.bot.getDraft(id)).toMatchObject({ filing: 'comment', isOwn: true });
		expect(await setup.bot.approve(id)).toBe('own_pr');
		expect(
			await setup.bot.postDraft(id, {
				headSha: 'head-1',
				event: 'REQUEST_CHANGES',
				mainReview: 'Fix it',
				comments: [],
				fileComments: [],
			}),
		).toEqual({ result: 'invalid_draft', reason: 'you can only comment on your own PR' });
		expect(setup.github.submissions).toEqual([]);
	});

	it('your own comment review on your PR → the bot keeps going, no take-over', async () => {
		const { setup, entry } = await addOwnPullRequest({ reviewMode: 'auto' });

		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.bot.addPullRequest('https://github.com/acme/api/pull/7');
		await setup.settle();
		entry.reviews.push({
			id: 99,
			state: 'COMMENTED',
			body: 'Answering the reviewers',
			submittedAt: new Date(setup.clock.now + 1000).toISOString(),
			commitId: 'head-1',
			authorLogin: VIEWER_LOGIN,
			authorType: 'User',
		});
		pushCommit(setup, 7, 'head-2');
		await setup.tickAndSettle();
		setup.clock.now += QUIET_PERIOD_MS;
		setup.claude.reviewOutcomes.push(draftedFor('head-2', 'comment'));
		await setup.tickAndSettle();

		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
		expect(setup.claude.reviewCalls).toHaveLength(2);
	});
});
