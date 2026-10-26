import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { createStore } from '../tracking/store.js';
import type { ActivityEntry } from '../tracking/store.js';
import { buildHistory, deriveHistoryOutcome } from './history.js';

const activity = (kind: string, detail: unknown = {}): ActivityEntry => ({
	kind,
	detail,
	emittedAt: 0,
});

describe('deriveHistoryOutcome', () => {
	it('stopped status → stopped, unless the bot already approved on GitHub', () => {
		expect(
			deriveHistoryOutcome({
				status: 'stopped',
				activities: [activity('review_posted', { event: 'COMMENT' }), activity('take_over')],
			}),
		).toBe('stopped');
		expect(
			deriveHistoryOutcome({
				status: 'stopped',
				activities: [activity('review_posted', { event: 'APPROVE' })],
			}),
		).toBe('approved_by_bot');
	});

	it('taken over → taken_over, even if the PR is merged or closed later in the same cycle', () => {
		expect(
			deriveHistoryOutcome({
				status: 'done',
				activities: [
					activity('take_over'),
					activity('finish', { kind: 'finish', reason: 'merged' }),
				],
			}),
		).toBe('taken_over');
	});

	it('taken over, then reopened → the old take-over no longer counts', () => {
		expect(
			deriveHistoryOutcome({
				status: 'needs_you',
				activities: [activity('take_over'), activity('reopen'), activity('give_up')],
			}),
		).toBeNull();
		expect(
			deriveHistoryOutcome({
				status: 'done',
				activities: [
					activity('take_over'),
					activity('reopen'),
					activity('finish', { kind: 'finish', reason: 'merged' }),
				],
			}),
		).toBe('merged');
	});

	it('Retry starts a new cycle, like a reopen', () => {
		expect(
			deriveHistoryOutcome({
				status: 'needs_you',
				activities: [activity('take_over'), activity('retry'), activity('give_up')],
			}),
		).toBeNull();
		expect(
			deriveHistoryOutcome({
				status: 'done',
				activities: [
					activity('review_posted', { event: 'APPROVE' }),
					activity('retry'),
					activity('review_posted', { event: 'COMMENT' }),
					activity('finish', { kind: 'finish', reason: 'merged' }),
				],
			}),
		).toBe('merged');
	});

	it('the bot posted an approval → approved_by_bot, even if the PR merged after', () => {
		for (const kind of ['review_posted', 'draft_posted_by_click']) {
			expect(
				deriveHistoryOutcome({
					status: 'done',
					activities: [
						activity(kind, { event: 'APPROVE' }),
						activity('finish', { kind: 'finish', reason: 'merged' }),
					],
				}),
			).toBe('approved_by_bot');
		}
	});

	it('finished by someone approving → approved_by_you', () => {
		expect(
			deriveHistoryOutcome({
				status: 'done',
				activities: [
					activity('review_posted', { event: 'COMMENT' }),
					activity('finish', { kind: 'finish', reason: 'approved' }),
				],
			}),
		).toBe('approved_by_you');
	});

	it('merged or closed → merged or closed', () => {
		expect(
			deriveHistoryOutcome({
				status: 'done',
				activities: [activity('finish', { kind: 'finish', reason: 'merged' })],
			}),
		).toBe('merged');
		expect(
			deriveHistoryOutcome({
				status: 'done',
				activities: [activity('finish', { kind: 'finish', reason: 'closed' })],
			}),
		).toBe('closed');
	});

	it('you reviewed it yourself → taken_over; a give-up is still open, not history', () => {
		expect(deriveHistoryOutcome({ status: 'needs_you', activities: [activity('take_over')] })).toBe(
			'taken_over',
		);
		expect(
			deriveHistoryOutcome({
				status: 'needs_you',
				activities: [activity('give_up', { reason: 'Gave up after 5 rounds' })],
			}),
		).toBeNull();
	});

	it('only the latest review cycle counts after a reopen', () => {
		expect(
			deriveHistoryOutcome({
				status: 'done',
				activities: [
					activity('review_posted', { event: 'APPROVE' }),
					activity('reopen'),
					activity('finish', { kind: 'finish', reason: 'merged' }),
				],
			}),
		).toBe('merged');
	});

	it('done with no finishing activity → closed; open statuses → not history', () => {
		expect(deriveHistoryOutcome({ status: 'done', activities: [] })).toBe('closed');
		expect(deriveHistoryOutcome({ status: 'waiting_on_author', activities: [] })).toBeNull();
	});
});

describe('buildHistory', () => {
	it('more than 200 finished PRs → the newest 200', () => {
		const store = createStore(new Database(':memory:'));
		const now = 1_793_000_000_000;

		for (const number of Array.from({ length: 205 }, (_, index) => index + 1)) {
			const tracked = store.insertDiscovered({
				discovered: {
					owner: 'acme',
					repo: 'api',
					number,
					title: `PR ${number}`,
					url: `https://github.com/acme/api/pull/${number}`,
					author: 'ana',
				},
				status: 'stopped',
				now,
			});

			store.updatePullRequest(tracked.id, { updatedAt: now - (205 - number) * 1000 });
		}

		const history = buildHistory({ store, now });

		expect(history).toHaveLength(200);
		expect(history[0]?.number).toBe(205);
		expect(history.at(-1)?.number).toBe(6);
	});
});
