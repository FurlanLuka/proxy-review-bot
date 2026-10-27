import { GitHubRequestError } from '../github/github-types.js';
import type { LivePullRequest } from '../github/github-types.js';
import { parsePullRequestLink } from '../github/pull-request-link.js';
import { planLinkedAdd, statusForLinkedPullRequest } from '../review/pull-request-updates.js';
import type { LinkedAddPlan } from '../review/pull-request-updates.js';
import { isOwnPullRequest, isViewerRequested } from '../review/review-decisions.js';
import type { TrackedPullRequest } from '../tracking/tracking-types.js';
import type { BotDependencies } from './bot-context.js';

export type AddPullRequestResult =
	| { kind: 'added'; id: number; isExisting: boolean }
	| { kind: 'invalid_link' }
	| { kind: 'unsupported_host' }
	| { kind: 'pr_not_found' }
	| { kind: 'no_access' }
	| { kind: 'pr_closed'; reason: 'merged' | 'closed' }
	| { kind: 'github_unavailable' };

type FetchResult =
	| { kind: 'live'; live: LivePullRequest }
	| Extract<AddPullRequestResult, { kind: 'pr_not_found' | 'no_access' | 'github_unavailable' }>;

const describeFetchFailure = (error: unknown): FetchResult => {
	if (error instanceof GitHubRequestError && error.status === 404) {
		return { kind: 'pr_not_found' };
	}

	if (error instanceof GitHubRequestError && (error.status === 403 || error.status === 429)) {
		return { kind: 'no_access' };
	}

	return { kind: 'github_unavailable' };
};

interface ApplyLinkedAddParams {
	dependencies: BotDependencies;
	existing: TrackedPullRequest | null;
	live: LivePullRequest;
	isRequested: boolean;
	now: number;
	plan: LinkedAddPlan;
}

const applyLinkedAdd = ({
	dependencies,
	existing,
	live,
	isRequested,
	now,
	plan,
}: ApplyLinkedAddParams): TrackedPullRequest => {
	const { store } = dependencies;

	if (existing === null) {
		return store.insertLinked({ live, status: statusForLinkedPullRequest(live), isRequested, now });
	}

	return plan.update === null ? existing : store.updatePullRequest(existing.id, plan.update);
};

interface AddPullRequestParams {
	dependencies: BotDependencies;
	url: string;
	viewerLogin: string | null;
}

export const addPullRequest = async ({
	dependencies,
	url,
	viewerLogin,
}: AddPullRequestParams): Promise<AddPullRequestResult> => {
	const { store, github, logger, now } = dependencies;
	const link = parsePullRequestLink(url);

	if (link.kind !== 'link') {
		logger.info('pull_request_add_rejected', { reason: link.kind });

		return link;
	}

	const fetched: FetchResult = await github
		.getPullRequest(link.reference)
		.then((live): FetchResult => ({ kind: 'live', live }))
		.catch((error: unknown) => {
			logger.warn('pull_request_add_fetch_failed', { reference: link.reference, error });

			return describeFetchFailure(error);
		});

	if (fetched.kind !== 'live') {
		return fetched;
	}

	const { live } = fetched;

	if (live.state === 'closed') {
		logger.info('pull_request_add_rejected', { reason: 'pr_closed', url: live.url });

		return { kind: 'pr_closed', reason: live.isMerged ? 'merged' : 'closed' };
	}

	// Everything below runs without an await, so two adds of the same PR can't both insert.
	const currentNow = now();
	const isRequested = viewerLogin !== null && isViewerRequested({ live, viewerLogin });
	const existing = store.findPullRequest(live.owner, live.repo, live.number);
	const plan = planLinkedAdd({ existing, live, isRequested, now: currentNow });
	const tracked = applyLinkedAdd({
		dependencies,
		existing,
		live,
		isRequested,
		now: currentNow,
		plan,
	});

	store.recordActivity(tracked.id, 'added_by_link', { outcome: plan.outcome, url: live.url });
	logger.info('pull_request_added_by_link', {
		id: tracked.id,
		outcome: plan.outcome,
		url: live.url,
		isDraft: live.isDraft,
		isOwn: isOwnPullRequest({ author: live.author, viewerLogin }),
	});

	return { kind: 'added', id: tracked.id, isExisting: plan.outcome === 'existing' };
};
