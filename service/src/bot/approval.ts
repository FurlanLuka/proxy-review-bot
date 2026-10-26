import { decideApprovalAction } from '../review/review-decisions.js';
import type { BotDependencies } from './bot-context.js';
import { postReview } from './posting.js';

export type ActionResult = 'ok' | 'not_found' | 'busy' | 'head_moved' | 'not_awaiting_approval';

interface ApprovePullRequestParams {
	dependencies: BotDependencies;
	id: number;
	viewerLogin: string | null;
}

export const approvePullRequest = async ({
	dependencies,
	id,
	viewerLogin,
}: ApprovePullRequestParams): Promise<ActionResult> => {
	const { store, github, logger, now } = dependencies;
	const tracked = store.getPullRequest(id);

	if (tracked === null) {
		return 'not_found';
	}

	if (tracked.status !== 'awaiting_approval') {
		return 'not_awaiting_approval';
	}

	const live = await github.getPullRequest(tracked);
	const action = decideApprovalAction({ tracked, live, viewerLogin });

	logger.info('approval_decided', { id, action: action.kind });

	switch (action.kind) {
		case 'not_awaiting_approval':
			return 'not_awaiting_approval';
		case 'not_ready':
			return 'busy';
		case 'closed':
			store.updatePullRequest(id, { status: 'done', pendingApproval: null, updatedAt: now() });

			return 'not_awaiting_approval';
		case 'head_moved':
			store.updatePullRequest(id, {
				status: 'waiting_on_author',
				pendingApproval: null,
				updatedAt: now(),
			});

			return 'head_moved';

		case 'post': {
			const postOutcome = await postReview({
				github,
				logger,
				reference: tracked,
				draft: action.draft,
				event: 'APPROVE',
				headSha: action.headSha,
				viewerLogin: action.viewerLogin,
			});

			store.updatePullRequest(id, {
				status: 'done',
				rounds: tracked.rounds + 1,
				pendingApproval: null,
				updatedAt: now(),
			});
			store.recordActivity(id, 'approved_by_click', { headSha: action.headSha, postOutcome });

			return 'ok';
		}
	}
};
