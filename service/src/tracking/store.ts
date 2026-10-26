import type { Database } from 'bun:sqlite';
import type { DiscoveredPullRequest } from '../github/github-types.js';
import type {
	PendingApproval,
	PullRequestStatus,
	PullRequestUpdate,
	TrackedPullRequest,
} from './tracking-types.js';

const MIGRATIONS = [
	`CREATE TABLE tracked_pull_requests (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		owner TEXT NOT NULL,
		repo TEXT NOT NULL,
		number INTEGER NOT NULL,
		url TEXT NOT NULL,
		title TEXT NOT NULL,
		author TEXT NOT NULL,
		status TEXT NOT NULL,
		rounds INTEGER NOT NULL DEFAULT 0,
		head_sha TEXT,
		base_ref_name TEXT,
		additions INTEGER NOT NULL DEFAULT 0,
		deletions INTEGER NOT NULL DEFAULT 0,
		is_requested INTEGER NOT NULL DEFAULT 1,
		last_reviewed_head TEXT,
		last_attempted_head TEXT,
		attempts_for_head INTEGER NOT NULL DEFAULT 0,
		next_eligible_at INTEGER,
		head_changed_at INTEGER,
		pending_approval_json TEXT,
		last_summary TEXT,
		last_error TEXT,
		review_started_at INTEGER,
		tracked_since INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE (owner, repo, number)
	)`,
	'CREATE INDEX tracked_pull_requests_status ON tracked_pull_requests (status)',
	`CREATE TABLE handled_comments (
		comment_id INTEGER PRIMARY KEY,
		pull_request_id INTEGER NOT NULL,
		handled_at INTEGER NOT NULL
	)`,
	`CREATE TABLE activity (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		pull_request_id INTEGER,
		kind TEXT NOT NULL,
		detail_json TEXT NOT NULL,
		emitted_at_ms INTEGER NOT NULL
	)`,
	'CREATE INDEX activity_pull_request ON activity (pull_request_id)',
	'CREATE TABLE runtime_flags (name TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

const COLUMN_NAMES: Record<keyof PullRequestUpdate, string> = {
	url: 'url',
	title: 'title',
	author: 'author',
	status: 'status',
	rounds: 'rounds',
	headSha: 'head_sha',
	baseRefName: 'base_ref_name',
	additions: 'additions',
	deletions: 'deletions',
	isRequested: 'is_requested',
	lastReviewedHead: 'last_reviewed_head',
	lastAttemptedHead: 'last_attempted_head',
	attemptsForHead: 'attempts_for_head',
	nextEligibleAt: 'next_eligible_at',
	headChangedAt: 'head_changed_at',
	pendingApproval: 'pending_approval_json',
	lastSummary: 'last_summary',
	lastError: 'last_error',
	reviewStartedAt: 'review_started_at',
	trackedSince: 'tracked_since',
	updatedAt: 'updated_at',
};

interface PullRequestRow {
	id: number;
	owner: string;
	repo: string;
	number: number;
	url: string;
	title: string;
	author: string;
	status: string;
	rounds: number;
	head_sha: string | null;
	base_ref_name: string | null;
	additions: number;
	deletions: number;
	is_requested: number;
	last_reviewed_head: string | null;
	last_attempted_head: string | null;
	attempts_for_head: number;
	next_eligible_at: number | null;
	head_changed_at: number | null;
	pending_approval_json: string | null;
	last_summary: string | null;
	last_error: string | null;
	review_started_at: number | null;
	tracked_since: number;
	updated_at: number;
}

const toTrackedPullRequest = (row: PullRequestRow): TrackedPullRequest => ({
	id: row.id,
	owner: row.owner,
	repo: row.repo,
	number: row.number,
	url: row.url,
	title: row.title,
	author: row.author,
	status: row.status as PullRequestStatus,
	rounds: row.rounds,
	headSha: row.head_sha,
	baseRefName: row.base_ref_name,
	additions: row.additions,
	deletions: row.deletions,
	isRequested: row.is_requested === 1,
	lastReviewedHead: row.last_reviewed_head,
	lastAttemptedHead: row.last_attempted_head,
	attemptsForHead: row.attempts_for_head,
	nextEligibleAt: row.next_eligible_at,
	headChangedAt: row.head_changed_at,
	pendingApproval:
		row.pending_approval_json === null
			? null
			: (JSON.parse(row.pending_approval_json) as PendingApproval),
	lastSummary: row.last_summary,
	lastError: row.last_error,
	reviewStartedAt: row.review_started_at,
	trackedSince: row.tracked_since,
	updatedAt: row.updated_at,
});

const toColumnValue = (key: keyof PullRequestUpdate, value: unknown): unknown => {
	if (key === 'pendingApproval') {
		return value === null ? null : JSON.stringify(value);
	}

	if (key === 'isRequested') {
		return value ? 1 : 0;
	}

	return value;
};

interface InsertDiscoveredParams {
	discovered: DiscoveredPullRequest;
	status: PullRequestStatus;
	now: number;
}

export interface Store {
	getPullRequest(id: number): TrackedPullRequest | null;
	findPullRequest(owner: string, repo: string, number: number): TrackedPullRequest | null;
	listPullRequests(): TrackedPullRequest[];
	insertDiscovered(params: InsertDiscoveredParams): TrackedPullRequest;
	updatePullRequest(id: number, update: PullRequestUpdate): TrackedPullRequest;
	resetInterruptedReviews(now: number): number;
	isCommentHandled(commentId: number): boolean;
	markCommentHandled(commentId: number, pullRequestId: number, now: number): void;
	recordActivity(pullRequestId: number | null, kind: string, detail: unknown): void;
	getFlag(name: string): string | null;
	setFlag(name: string, value: string | null): void;
}

export const migrate = (database: Database): void => {
	database.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
	const applied = database.query('SELECT MAX(version) AS version FROM schema_migrations').get() as {
		version: number | null;
	};
	const currentVersion = applied.version ?? 0;

	for (const [index, statement] of MIGRATIONS.entries()) {
		const version = index + 1;

		if (version <= currentVersion) {
			continue;
		}

		database.transaction(() => {
			database.run(statement);
			database.run('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
		})();
	}
};

export const createStore = (database: Database): Store => {
	migrate(database);

	const getPullRequest = (id: number): TrackedPullRequest | null => {
		const row = database
			.query('SELECT * FROM tracked_pull_requests WHERE id = ?')
			.get(id) as PullRequestRow | null;

		return row === null ? null : toTrackedPullRequest(row);
	};

	return {
		getPullRequest,
		findPullRequest: (owner, repo, number) => {
			const row = database
				.query('SELECT * FROM tracked_pull_requests WHERE owner = ? AND repo = ? AND number = ?')
				.get(owner, repo, number) as PullRequestRow | null;

			return row === null ? null : toTrackedPullRequest(row);
		},
		listPullRequests: () => {
			const rows = database
				.query('SELECT * FROM tracked_pull_requests ORDER BY updated_at DESC')
				.all() as PullRequestRow[];

			return rows.map(toTrackedPullRequest);
		},
		insertDiscovered: ({ discovered, status, now }) => {
			const row = database
				.query(
					`INSERT INTO tracked_pull_requests
						(owner, repo, number, url, title, author, status, head_changed_at, tracked_since, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					RETURNING *`,
				)
				.get(
					discovered.owner,
					discovered.repo,
					discovered.number,
					discovered.url,
					discovered.title,
					discovered.author,
					status,
					now,
					now,
					now,
				) as PullRequestRow;

			return toTrackedPullRequest(row);
		},
		updatePullRequest: (id, update) => {
			const entries = Object.entries(update) as [keyof PullRequestUpdate, unknown][];

			if (entries.length > 0) {
				const assignments = entries.map(([key]) => `${COLUMN_NAMES[key]} = ?`).join(', ');
				const values = entries.map(([key, value]) => toColumnValue(key, value));

				database.run(`UPDATE tracked_pull_requests SET ${assignments} WHERE id = ?`, [
					...(values as string[]),
					id,
				]);
			}

			const updated = getPullRequest(id);

			if (updated === null) {
				throw new Error(`Tracked pull request ${id} disappeared during update`);
			}

			return updated;
		},
		resetInterruptedReviews: (now) => {
			const result = database.run(
				`UPDATE tracked_pull_requests
				SET status = 'queued', review_started_at = NULL, updated_at = ?
				WHERE status = 'reviewing'`,
				[now],
			);

			return result.changes;
		},
		isCommentHandled: (commentId) => {
			return (
				database.query('SELECT 1 FROM handled_comments WHERE comment_id = ?').get(commentId) !==
				null
			);
		},
		markCommentHandled: (commentId, pullRequestId, now) => {
			database.run(
				'INSERT OR IGNORE INTO handled_comments (comment_id, pull_request_id, handled_at) VALUES (?, ?, ?)',
				[commentId, pullRequestId, now],
			);
		},
		recordActivity: (pullRequestId, kind, detail) => {
			database.run(
				'INSERT INTO activity (pull_request_id, kind, detail_json, emitted_at_ms) VALUES (?, ?, ?, ?)',
				[pullRequestId, kind, JSON.stringify(detail), Date.now()],
			);
		},
		getFlag: (name) => {
			const row = database.query('SELECT value FROM runtime_flags WHERE name = ?').get(name) as {
				value: string;
			} | null;

			return row?.value ?? null;
		},
		setFlag: (name, value) => {
			if (value === null) {
				database.run('DELETE FROM runtime_flags WHERE name = ?', [name]);

				return;
			}

			database.run(
				'INSERT INTO runtime_flags (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value',
				[name, value],
			);
		},
	};
};
