import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, migrate } from './store.js';

const DISCOVERED = { owner: 'acme', repo: 'api', number: 7, title: 't', url: 'u', author: 'a' };

describe('store', () => {
	it('migrating twice on the same file is a no-op', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'proxy-review-bot-db-')), 'bot.sqlite');
		const first = new Database(path);

		migrate(first);
		first.close();

		const second = new Database(path);

		migrate(second);

		const version = second.query('SELECT MAX(version) AS version FROM schema_migrations').get() as {
			version: number;
		};

		expect(version.version).toBe(13);
	});

	it('upgrading an existing database → every PR is a requested, non-draft PR', () => {
		const database = new Database(':memory:');

		migrate(database);
		database.run('DELETE FROM schema_migrations WHERE version > 11');
		database.run('ALTER TABLE tracked_pull_requests DROP COLUMN source');
		database.run('ALTER TABLE tracked_pull_requests DROP COLUMN is_draft');
		database.run(
			`INSERT INTO tracked_pull_requests (owner, repo, number, url, title, author, status, tracked_since, updated_at)
			VALUES ('acme', 'api', 1, 'u', 't', 'a', 'waiting_on_author', 100, 100)`,
		);

		const [tracked] = createStore(database).listPullRequests();

		expect(tracked).toMatchObject({ source: 'requested', isDraft: false });
	});

	it('finding a PR ignores owner and repo case', () => {
		const store = createStore(new Database(':memory:'));
		const inserted = store.insertDiscovered({
			discovered: { ...DISCOVERED, owner: 'Acme', repo: 'API' },
			status: 'needs_review',
			now: 1,
		});

		expect(store.findPullRequest('acme', 'api', 7)?.id).toBe(inserted.id);
	});

	it('upgrading an existing database marks reviewed PRs as started and leaves new ones alone', () => {
		const database = new Database(':memory:');

		migrate(database);
		database.run('DELETE FROM schema_migrations WHERE version > 6');
		database.run('ALTER TABLE tracked_pull_requests DROP COLUMN first_queued_at');
		database.run('ALTER TABLE tracked_pull_requests DROP COLUMN repair_session_id');
		database.run('ALTER TABLE tracked_pull_requests DROP COLUMN repair_head_sha');
		database.run('ALTER TABLE tracked_pull_requests DROP COLUMN repair_saved_at');
		database.run('ALTER TABLE tracked_pull_requests DROP COLUMN source');
		database.run('ALTER TABLE tracked_pull_requests DROP COLUMN is_draft');

		const insert = (number: number, status: string, rounds: number) => {
			database.run(
				`INSERT INTO tracked_pull_requests (owner, repo, number, url, title, author, status, rounds, tracked_since, updated_at)
				VALUES ('acme', 'api', ?, 'u', 't', 'a', ?, ?, 100, 100)`,
				[number, status, rounds],
			);
		};

		insert(1, 'needs_review', 0);
		insert(2, 'waiting_on_author', 1);
		insert(3, 'needs_review', 1);
		insert(4, 'stopped', 0);
		insert(5, 'done', 0);
		insert(6, 'needs_you', 0);
		insert(7, 'draft_ready', 0);
		insert(8, 'queued', 0);
		insert(9, 'reviewing', 0);
		insert(10, 'awaiting_approval', 0);
		insert(11, 'blocked', 0);
		insert(12, 'done', 1);

		const store = createStore(database);
		const startedByNumber = Object.fromEntries(
			store.listPullRequests().map((tracked) => [tracked.number, tracked.firstQueuedAt]),
		);

		expect(startedByNumber).toEqual({
			1: null,
			2: 100,
			3: 100,
			4: null,
			5: null,
			6: null,
			7: 100,
			8: 100,
			9: 100,
			10: 100,
			11: 100,
			12: 100,
		});
	});

	it('pending approval and flags round-trip', () => {
		const store = createStore(new Database(':memory:'));
		const tracked = store.insertDiscovered({
			discovered: DISCOVERED,
			status: 'needs_review',
			now: 1,
		});
		const draft = {
			outcome: 'drafted' as const,
			filing: 'approve' as const,
			headRefOid: 'h',
			baseRefName: 'main',
			targetTipOid: 't',
			summary: 's',
			mainReview: 'm',
			comments: [],
			fileComments: [],
			coverage: 'c',
		};

		store.updatePullRequest(tracked.id, {
			pendingApproval: { headSha: 'h', draft },
			isRequested: false,
		});

		expect(store.getPullRequest(tracked.id)).toMatchObject({
			pendingApproval: { headSha: 'h', draft },
			isRequested: false,
		});

		store.setFlag('is_paused', 'true');
		expect(store.getFlag('is_paused')).toBe('true');
		store.setFlag('is_paused', null);
		expect(store.getFlag('is_paused')).toBeNull();
	});

	it('handled comments are remembered', () => {
		const store = createStore(new Database(':memory:'));

		expect(store.isCommentHandled(5)).toBe(false);
		store.markCommentHandled(5, 1, 1);
		store.markCommentHandled(5, 1, 2);
		expect(store.isCommentHandled(5)).toBe(true);
	});
});
