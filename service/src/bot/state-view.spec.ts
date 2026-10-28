import { describe, expect, it } from 'bun:test';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import { ANCHOR_TIME, makeTracked } from '../test-support/factories.js';
import type { TrackedPullRequest } from '../tracking/tracking-types.js';
import { buildBotState } from './state-view.js';

const viewOf = (tracked: TrackedPullRequest, settings = DEFAULT_SETTINGS) => {
	const [view] = buildBotState({
		trackedPullRequests: [tracked],
		viewerLogin: 'luka',
		isPaused: false,
		usageLimitedUntil: null,
		readiness: { status: 'ready', checks: [] },
		settings,
		progressById: new Map(),
		now: ANCHOR_TIME,
	}).pullRequests;

	return view;
};

const RELEASE = { headRefName: 'develop', baseRefName: 'master' };

describe('PR view: Start manually', () => {
	it('a waiting release PR is flagged and shows its branches', () => {
		expect(viewOf(makeTracked(RELEASE))).toMatchObject({ ...RELEASE, isManualStart: true });
	});

	it('not flagged once it left Ready to review, without a head branch, or outside the list', () => {
		expect(viewOf(makeTracked({ ...RELEASE, status: 'queued' }))?.isManualStart).toBe(false);
		expect(viewOf(makeTracked({ ...RELEASE, headRefName: null }))?.isManualStart).toBe(false);
		expect(viewOf(makeTracked())?.isManualStart).toBe(false);
	});

	it('retry time only when the bot would retry on its own', () => {
		const failed = {
			status: 'waiting_on_author' as const,
			lastError: 'timed out',
			nextEligibleAt: ANCHOR_TIME + 60_000,
			firstQueuedAt: ANCHOR_TIME - 60_000,
		};

		expect(viewOf(makeTracked(failed))?.retryAt).toBe(ANCHOR_TIME + 60_000);
		expect(viewOf(makeTracked({ ...failed, ...RELEASE }))?.retryAt).toBeNull();
	});
});
