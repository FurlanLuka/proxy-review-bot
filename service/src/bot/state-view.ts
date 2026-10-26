import type { Readiness } from '../readiness/readiness.js';
import type { Settings } from '../settings/settings.js';
import type { TrackedPullRequest } from '../tracking/tracking-types.js';

const DONE_VISIBILITY_MS = 24 * 60 * 60_000;

export interface PullRequestView {
	id: number;
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	author: string;
	status: string;
	rounds: number;
	maxRounds: number;
	additions: number;
	deletions: number;
	headSha: string | null;
	summary: string | null;
	reason: string | null;
	reviewStartedAt: number | null;
	updatedAt: number;
}

export interface BotState {
	viewerLogin: string | null;
	isPaused: boolean;
	usageLimitedUntil: number | null;
	readiness: Readiness;
	settings: Settings;
	pullRequests: PullRequestView[];
}

const toView = (tracked: TrackedPullRequest, maxRounds: number): PullRequestView => ({
	id: tracked.id,
	owner: tracked.owner,
	repo: tracked.repo,
	number: tracked.number,
	title: tracked.title,
	url: tracked.url,
	author: tracked.author,
	status: tracked.status,
	rounds: tracked.rounds,
	maxRounds,
	additions: tracked.additions,
	deletions: tracked.deletions,
	headSha: tracked.headSha,
	summary: tracked.lastSummary,
	reason: tracked.lastError,
	reviewStartedAt: tracked.reviewStartedAt,
	updatedAt: tracked.updatedAt,
});

interface BuildBotStateParams {
	trackedPullRequests: TrackedPullRequest[];
	viewerLogin: string | null;
	isPaused: boolean;
	usageLimitedUntil: number | null;
	readiness: Readiness;
	settings: Settings;
	now: number;
}

export const buildBotState = ({
	trackedPullRequests,
	settings,
	now,
	...status
}: BuildBotStateParams): BotState => {
	const visibleSince = now - DONE_VISIBILITY_MS;

	return {
		...status,
		settings,
		pullRequests: trackedPullRequests
			.filter((tracked) => tracked.status !== 'done' || tracked.updatedAt >= visibleSince)
			.map((tracked) => toView(tracked, settings.maxRounds)),
	};
};
