import type {
	FileCommentSubmission,
	ReviewEvent,
	ReviewSubmission,
} from '../github/github-types.js';
import { appendBotFooter } from './bot-marker.js';
import type { DraftedReviewResult } from './review-result.js';

const EMPTY_REVIEW_BODY = 'Reviewed, no further comments.';

export interface ReviewPayload {
	review: ReviewSubmission;
	fileComments: FileCommentSubmission[];
}

interface BuildReviewPayloadParams {
	draft: DraftedReviewResult;
	event: ReviewEvent;
	headSha: string;
	shouldFoldInlineComments: boolean;
}

const formatFoldedComment = (comment: DraftedReviewResult['comments'][number]): string => {
	return `**${comment.path}:${comment.line}**\n\n${comment.body}`;
};

const buildMainBody = ({
	draft,
	event,
	shouldFoldInlineComments,
}: Omit<BuildReviewPayloadParams, 'headSha'>): string => {
	const mainText =
		event === 'APPROVE' && draft.mainReview.trim().length === 0
			? draft.summary
			: draft.mainReview.trim();
	const foldedComments = shouldFoldInlineComments ? draft.comments.map(formatFoldedComment) : [];
	const sections = [mainText, ...foldedComments].filter((section) => section.length > 0);

	return sections.length > 0 ? sections.join('\n\n---\n\n') : EMPTY_REVIEW_BODY;
};

export const buildReviewPayload = ({
	draft,
	event,
	headSha,
	shouldFoldInlineComments,
}: BuildReviewPayloadParams): ReviewPayload => {
	return {
		review: {
			commitId: headSha,
			event,
			body: appendBotFooter(buildMainBody({ draft, event, shouldFoldInlineComments }), headSha),
			comments: shouldFoldInlineComments
				? []
				: draft.comments.map((comment) => ({
						path: comment.path,
						line: comment.line,
						side: comment.side,
						body: appendBotFooter(comment.body, headSha),
					})),
		},
		fileComments: draft.fileComments.map((comment) => ({
			commitId: headSha,
			path: comment.path,
			body: appendBotFooter(comment.body, headSha),
		})),
	};
};
