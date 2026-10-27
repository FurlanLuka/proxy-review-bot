import type { ReviewEvent } from '../github/github-types.js';
import { applyDraftEdits } from '../review/draft-edits.js';
import { decideApprovalAction } from '../review/review-decisions.js';
import type { DraftedReviewResult } from '../review/review-result.js';
import { DRAFT_HOLDING_STATUSES } from '../tracking/tracking-types.js';
import type { BotDependencies } from './bot-context.js';
import { postReview } from './posting.js';

export type ActionResult =
	| 'ok'
	| 'not_found'
	| 'busy'
	| 'head_moved'
	| 'not_awaiting_approval'
	| 'no_draft'
	| 'invalid_draft';

type DraftChoice =
	| { kind: 'post'; event: ReviewEvent; draft: DraftedReviewResult }
	| { kind: 'stale' }
	| { kind: 'invalid'; reason: string };

export interface DraftPostResult {
	result: ActionResult;
	reason?: string;
}

interface PostHeldDraftParams {
	dependencies: BotDependencies;
	id: number;
	viewerLogin: string | null;
	chooseDraft: (heldDraft: DraftedReviewResult, heldHeadSha: string) => DraftChoice;
	missingDraftResult: ActionResult;
}

const postHeldDraft = async ({
	dependencies,
	id,
	viewerLogin,
	chooseDraft,
	missingDraftResult,
}: PostHeldDraftParams): Promise<DraftPostResult> => {
	const { store, github, logger, now } = dependencies;
	const tracked = store.getPullRequest(id);

	if (tracked === null) {
		return { result: 'not_found' };
	}

	if (!DRAFT_HOLDING_STATUSES.has(tracked.status) || tracked.pendingApproval === null) {
		return { result: missingDraftResult };
	}

	const choice = chooseDraft(tracked.pendingApproval.draft, tracked.pendingApproval.headSha);

	if (choice.kind === 'stale') {
		return { result: 'head_moved' };
	}

	if (choice.kind === 'invalid') {
		return { result: 'invalid_draft', reason: choice.reason };
	}

	const live = await github.getPullRequest(tracked);
	const action = decideApprovalAction({ tracked, live, viewerLogin });

	logger.info('draft_post_decided', { id, action: action.kind, event: choice.event });

	switch (action.kind) {
		case 'not_awaiting_approval':
			return { result: missingDraftResult };
		case 'not_ready':
			return { result: 'busy' };
		case 'closed':
			store.updatePullRequest(id, { status: 'done', pendingApproval: null, updatedAt: now() });
			store.recordActivity(id, 'finish', {
				kind: 'finish',
				reason: live.isMerged ? 'merged' : 'closed',
			});

			return { result: missingDraftResult };
		case 'head_moved':
			store.updatePullRequest(id, {
				status: 'waiting_on_author',
				pendingApproval: null,
				updatedAt: now(),
			});

			return { result: 'head_moved' };

		case 'post': {
			const postOutcome = await postReview({
				github,
				logger,
				reference: tracked,
				draft: choice.draft,
				event: choice.event,
				headSha: action.headSha,
				viewerLogin: action.viewerLogin,
			});

			store.updatePullRequest(id, {
				status: choice.event === 'APPROVE' ? 'done' : 'waiting_on_author',
				rounds: tracked.rounds + 1,
				isRequested: false,
				pendingApproval: null,
				lastSummary: choice.draft.summary,
				updatedAt: now(),
			});
			store.recordActivity(id, 'draft_posted_by_click', {
				headSha: action.headSha,
				event: choice.event,
				commentCount: choice.draft.comments.length,
				postOutcome,
			});

			return { result: 'ok' };
		}
	}
};

interface DraftActionParams {
	dependencies: BotDependencies;
	id: number;
	viewerLogin: string | null;
}

export const approvePullRequest = async (params: DraftActionParams): Promise<ActionResult> => {
	const outcome = await postHeldDraft({
		...params,
		missingDraftResult: 'not_awaiting_approval',
		chooseDraft: (heldDraft) =>
			heldDraft.filing === 'approve'
				? { kind: 'post', event: 'APPROVE', draft: heldDraft }
				: { kind: 'invalid', reason: 'this draft cannot approve' },
	});

	return outcome.result;
};

interface PostEditedDraftParams extends DraftActionParams {
	edit: unknown;
}

export const postEditedDraft = ({
	edit,
	...params
}: PostEditedDraftParams): Promise<DraftPostResult> => {
	return postHeldDraft({
		...params,
		missingDraftResult: 'no_draft',
		chooseDraft: (heldDraft, heldHeadSha) => {
			const result = applyDraftEdits({
				draft: heldDraft,
				draftHeadSha: heldHeadSha,
				candidate: edit,
			});

			return result.kind === 'valid'
				? { kind: 'post', event: result.event, draft: result.draft }
				: result;
		},
	});
};

interface DiscardDraftParams {
	dependencies: BotDependencies;
	id: number;
}

export const discardDraft = ({ dependencies, id }: DiscardDraftParams): ActionResult => {
	const { store, logger, now } = dependencies;
	const tracked = store.getPullRequest(id);

	if (tracked === null) {
		return 'not_found';
	}

	if (!DRAFT_HOLDING_STATUSES.has(tracked.status) || tracked.pendingApproval === null) {
		return 'no_draft';
	}

	store.updatePullRequest(id, {
		status: 'waiting_on_author',
		pendingApproval: null,
		updatedAt: now(),
	});
	store.recordActivity(id, 'draft_discarded', { headSha: tracked.pendingApproval.headSha });
	logger.info('draft_discarded', { id });

	return 'ok';
};

export type HeldDraft = DraftedReviewResult & { headSha: string };

export const findHeldDraft = (
	dependencies: BotDependencies,
	id: number,
): HeldDraft | 'not_found' | 'no_draft' => {
	const tracked = dependencies.store.getPullRequest(id);

	if (tracked === null) {
		return 'not_found';
	}

	if (!DRAFT_HOLDING_STATUSES.has(tracked.status) || tracked.pendingApproval === null) {
		return 'no_draft';
	}

	return { ...tracked.pendingApproval.draft, headSha: tracked.pendingApproval.headSha };
};
