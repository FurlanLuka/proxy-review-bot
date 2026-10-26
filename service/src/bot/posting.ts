import type { GitHubClient, PullRequestReference } from '../github/github-types.js';
import { GitHubRequestError } from '../github/github-types.js';
import type { Logger } from '../logging/logger.js';
import { hasBotMarkerForHead } from '../review/bot-marker.js';
import { buildReviewPayload } from '../review/review-payload.js';
import type { DraftedReviewResult } from '../review/review-result.js';

const REVIEW_STATE_BY_EVENT = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED' } as const;

export type PostReviewOutcome = 'posted' | 'posted_folded' | 'already_posted';

interface PostReviewParams {
	github: GitHubClient;
	logger: Logger;
	reference: PullRequestReference;
	draft: DraftedReviewResult;
	event: 'COMMENT' | 'APPROVE';
	headSha: string;
	viewerLogin: string;
}

const isAnchorRejection = (error: unknown): boolean => {
	return error instanceof GitHubRequestError && error.status === 422;
};

export const postReview = async ({
	github,
	logger,
	reference,
	draft,
	event,
	headSha,
	viewerLogin,
}: PostReviewParams): Promise<PostReviewOutcome> => {
	const existingReviews = await github.listReviews(reference);
	const isAlreadyPosted = existingReviews.some(
		(review) =>
			review.authorLogin === viewerLogin &&
			review.state === REVIEW_STATE_BY_EVENT[event] &&
			hasBotMarkerForHead(review.body, headSha),
	);

	if (isAlreadyPosted) {
		logger.warn('review_already_posted', { ...reference, headSha, event });

		return 'already_posted';
	}

	const payload = buildReviewPayload({ draft, event, headSha, shouldFoldInlineComments: false });
	const outcome = await github
		.submitReview(reference, payload.review)
		.then((): PostReviewOutcome => 'posted')
		.catch(async (error: unknown): Promise<PostReviewOutcome> => {
			if (!isAnchorRejection(error)) {
				throw error;
			}

			logger.warn('review_anchor_rejected', { ...reference, headSha, error });
			const folded = buildReviewPayload({ draft, event, headSha, shouldFoldInlineComments: true });

			await github.submitReview(reference, folded.review);

			return 'posted_folded';
		});

	for (const fileComment of payload.fileComments) {
		try {
			await github.postFileComment(reference, fileComment);
		} catch (error) {
			logger.error('file_comment_failed', { ...reference, path: fileComment.path, error });
		}
	}

	logger.info('review_posted', {
		...reference,
		headSha,
		event,
		outcome,
		inlineCount: draft.comments.length,
		fileCount: draft.fileComments.length,
	});

	return outcome;
};
