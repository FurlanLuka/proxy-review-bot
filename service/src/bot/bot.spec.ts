import { describe, expect, it } from 'bun:test';
import { createBotMarker } from '../review/bot-marker.js';
import { QUIET_PERIOD_MS } from '../review/review-decisions.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import { makeComment, makeDraft, makeThread } from '../test-support/factories.js';
import { createTestHarness, VIEWER_LOGIN } from '../test-support/fakes.js';
import type { TestHarness } from '../test-support/fakes.js';
import { createBot } from './bot.js';

const setUp = (settings = {}) => {
	const harness = createTestHarness();

	harness.dependencies.settingsStore.replace({ ...DEFAULT_SETTINGS, ...settings });

	const bot = createBot(harness.dependencies);

	const tickAndSettle = async (): Promise<void> => {
		await bot.tick();
		await bot.waitForIdle();
	};

	const statusOf = (number: number) => {
		return bot.getState().pullRequests.find((pullRequest) => pullRequest.number === number);
	};

	return { ...harness, bot, tickAndSettle, statusOf };
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

	it('Review click → one review posted as COMMENT with the marker', async () => {
		const setup = setUp({ reviewMode: 'manual' });

		setup.github.addPullRequest(7);
		await setup.tickAndSettle();
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));

		expect(setup.bot.requestReview(setup.statusOf(7)?.id ?? 0)).toBe('ok');
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.github.submissions).toHaveLength(1);
		expect(setup.github.submissions[0]?.event).toBe('COMMENT');
		expect(setup.github.submissions[0]?.body).toContain(createBotMarker('head-1'));
		expect(setup.statusOf(7)).toMatchObject({ status: 'waiting_on_author', rounds: 1 });
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

	it('failed run backs off, then gives up after two attempts on the same head', async () => {
		const setup = setUp({ reviewMode: 'auto' });

		setup.github.addPullRequest(7);
		setup.claude.reviewOutcomes.push({ kind: 'failed', summary: 'Claude run timed out' });
		await setup.tickAndSettle();

		expect(setup.statusOf(7)).toMatchObject({
			status: 'waiting_on_author',
			reason: 'Claude run timed out',
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
		setup.github.addPullRequest(8);
		setup.claude.reviewOutcomes.push({ kind: 'usage_limited', resumeAt: setup.clock.now + 60_000 });
		await setup.tickAndSettle();
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(1);
		expect(setup.bot.getState().usageLimitedUntil).toBe(setup.clock.now + 60_000);
		expect(setup.statusOf(7)?.status).toBe('queued');

		setup.clock.now += 61_000;
		setup.claude.reviewOutcomes.push(draftedFor('head-1', 'comment'));
		await setup.tickAndSettle();

		expect(setup.claude.reviewCalls).toHaveLength(2);
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
		await setup.bot.waitForIdle();

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
		await setup.bot.waitForIdle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('needs_you');
	});

	it('merged during the run → nothing posted, done', async () => {
		const setup = await startGatedReview();

		setup.entry.live.state = 'closed';
		setup.entry.live.isMerged = true;
		await setup.bot.tick();
		setup.gate.open();
		await setup.bot.waitForIdle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('done');
	});

	it('paused during the run → nothing posted, queued again for after resume', async () => {
		const setup = await startGatedReview();

		setup.bot.setPaused(true);
		setup.gate.open();
		await setup.bot.waitForIdle();

		expect(setup.github.submissions).toEqual([]);
		expect(setup.statusOf(7)?.status).toBe('queued');
	});

	it('Review and Retry clicks while reviewing → busy', async () => {
		const setup = await startGatedReview();
		const id = setup.statusOf(7)?.id ?? 0;

		expect(setup.bot.requestReview(id)).toBe('busy');
		expect(setup.bot.retry(id)).toBe('busy');
		setup.gate.open();
		await setup.bot.waitForIdle();
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
		await setup.bot.waitForIdle();
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
		expect(setup.statusOf(7)?.status).toBe('waiting_on_author');
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
		await Bun.sleep(5);

		expect(setup.claude.replyPrompts).toHaveLength(1);

		return { ...setup, entry, gate };
	};

	const finish = async (setup: Awaited<ReturnType<typeof startGatedReply>>) => {
		setup.gate.open();
		await setup.bot.waitForIdle();

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
		await setup.bot.waitForIdle();
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
