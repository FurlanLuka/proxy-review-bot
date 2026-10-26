import type { ActivityEntry, Store } from '../tracking/store.js';
import type { TrackedPullRequest } from '../tracking/tracking-types.js';

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60_000;
const MAX_HISTORY_ENTRIES = 200;
const CYCLE_START_KINDS = new Set(['reopen', 'retry']);
const POSTING_KINDS = new Set(['review_posted', 'draft_posted_by_click']);
const HISTORY_STATUSES: ReadonlySet<TrackedPullRequest['status']> = new Set([
	'done',
	'stopped',
	'needs_you',
]);

export type HistoryOutcome =
	| 'approved_by_bot'
	| 'approved_by_you'
	| 'merged'
	| 'closed'
	| 'taken_over'
	| 'stopped';

export interface HistoryEntry {
	id: number;
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	author: string;
	outcome: HistoryOutcome;
	rounds: number;
	finishedAt: number;
}

const readField = (detail: unknown, field: string): unknown => {
	return typeof detail === 'object' && detail !== null
		? (detail as Record<string, unknown>)[field]
		: undefined;
};

const currentCycle = (activities: ActivityEntry[]): ActivityEntry[] => {
	const cycleStartIndex = activities.findLastIndex((activity) =>
		CYCLE_START_KINDS.has(activity.kind),
	);

	return activities.slice(cycleStartIndex + 1);
};

const outcomeForFinish = (activity: ActivityEntry | undefined): HistoryOutcome => {
	const reason = readField(activity?.detail, 'reason');

	return reason === 'approved' ? 'approved_by_you' : reason === 'merged' ? 'merged' : 'closed';
};

interface DeriveHistoryOutcomeParams {
	status: TrackedPullRequest['status'];
	activities: ActivityEntry[];
}

export const deriveHistoryOutcome = ({
	status,
	activities,
}: DeriveHistoryOutcomeParams): HistoryOutcome | null => {
	if (!HISTORY_STATUSES.has(status)) {
		return null;
	}

	const cycle = currentCycle(activities);
	const hasBotApproved = cycle.some(
		(activity) =>
			POSTING_KINDS.has(activity.kind) && readField(activity.detail, 'event') === 'APPROVE',
	);

	if (hasBotApproved) {
		return 'approved_by_bot';
	}

	if (status === 'stopped') {
		return 'stopped';
	}

	if (cycle.some((activity) => activity.kind === 'take_over')) {
		return 'taken_over';
	}

	if (status === 'needs_you') {
		return null;
	}

	return outcomeForFinish(cycle.findLast((activity) => activity.kind === 'finish'));
};

interface BuildHistoryParams {
	store: Store;
	now: number;
}

export const buildHistory = ({ store, now }: BuildHistoryParams): HistoryEntry[] => {
	const since = now - HISTORY_WINDOW_MS;
	const entries: HistoryEntry[] = [];

	for (const tracked of store.listPullRequests()) {
		if (tracked.updatedAt < since || !HISTORY_STATUSES.has(tracked.status)) {
			continue;
		}

		const outcome = deriveHistoryOutcome({
			status: tracked.status,
			activities: store.listActivity(tracked.id),
		});

		if (outcome !== null) {
			entries.push({
				id: tracked.id,
				owner: tracked.owner,
				repo: tracked.repo,
				number: tracked.number,
				title: tracked.title,
				url: tracked.url,
				author: tracked.author,
				outcome,
				rounds: tracked.rounds,
				finishedAt: tracked.updatedAt,
			});
		}
	}

	return entries
		.sort((left, right) => right.finishedAt - left.finishedAt)
		.slice(0, MAX_HISTORY_ENTRIES);
};
