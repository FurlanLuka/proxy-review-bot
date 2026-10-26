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

		expect(version.version).toBe(6);
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
