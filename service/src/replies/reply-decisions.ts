import type { ReviewThread, ReviewThreadComment } from '../github/github-types.js';
import { hasBotMarker } from '../review/bot-marker.js';

export const MAX_BOT_REPLIES_PER_THREAD = 3;

interface FindUnansweredCommentParams {
	thread: ReviewThread;
	login: string;
	isCommentHandled: (commentId: number) => boolean;
}

export const findUnansweredComment = ({
	thread,
	login,
	isCommentHandled,
}: FindUnansweredCommentParams): ReviewThreadComment | null => {
	const [rootComment] = thread.comments;
	const latestComment = thread.comments.at(-1);

	if (rootComment === undefined || latestComment === undefined || latestComment === rootComment) {
		return null;
	}

	const botReplyCount = thread.comments
		.slice(1)
		.filter((comment) => comment.authorLogin === login && hasBotMarker(comment.body)).length;
	const isEligible =
		hasBotMarker(rootComment.body) &&
		!thread.isResolved &&
		latestComment.authorType !== 'Bot' &&
		latestComment.authorLogin !== login &&
		!isCommentHandled(latestComment.databaseId) &&
		botReplyCount < MAX_BOT_REPLIES_PER_THREAD;

	return isEligible ? latestComment : null;
};
