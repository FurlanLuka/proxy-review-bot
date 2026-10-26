import { buildReplyPrompt } from '../claude/prompts.js';
import type { ReviewThread, ReviewThreadComment } from '../github/github-types.js';
import { findUnansweredComment } from '../replies/reply-decisions.js';
import { appendBotFooter } from '../review/bot-marker.js';
import type { TrackedPullRequest } from '../tracking/tracking-types.js';
import type { BotDependencies } from './bot-context.js';
import type { JobOutcome } from './review-job.js';

const REPLY_STATUSES = new Set([
	'waiting_on_author',
	'awaiting_approval',
	'blocked',
	'needs_review',
]);

interface PendingReply {
	tracked: TrackedPullRequest;
	thread: ReviewThread;
	comment: ReviewThreadComment;
}

interface ReplyJobParams {
	dependencies: BotDependencies;
	viewerLogin: string;
	isPaused: () => boolean;
}

const isReplyStillWanted = ({ dependencies, isPaused }: ReplyJobParams, id: number): boolean => {
	const current = dependencies.store.getPullRequest(id);

	return (
		current !== null &&
		REPLY_STATUSES.has(current.status) &&
		!isPaused() &&
		dependencies.settingsStore.get().answerQuestions
	);
};

const findPendingReply = async ({
	dependencies,
	viewerLogin,
}: ReplyJobParams): Promise<PendingReply | null> => {
	const { store, github, logger } = dependencies;
	const candidates = store
		.listPullRequests()
		.filter((tracked) => REPLY_STATUSES.has(tracked.status) && tracked.rounds > 0);

	for (const tracked of candidates) {
		try {
			const threads = await github.listReviewThreads(tracked);

			for (const thread of threads) {
				const comment = findUnansweredComment({
					thread,
					login: viewerLogin,
					isCommentHandled: store.isCommentHandled,
				});

				if (comment !== null) {
					return { tracked, thread, comment };
				}
			}
		} catch (error) {
			logger.error('reply_scan_failed', { id: tracked.id, error });
		}
	}

	return null;
};

export const runNextReplyJob = async (params: ReplyJobParams): Promise<JobOutcome | null> => {
	const { store, github, claude, clones, logger, now } = params.dependencies;
	const pending = await findPendingReply(params);

	if (pending === null) {
		return null;
	}

	const { tracked, thread, comment } = pending;
	const headSha = tracked.headSha ?? '';

	logger.info('reply_job_started', { id: tracked.id, commentId: comment.databaseId });

	try {
		const clonePath = await clones.prepareClone(tracked);
		const outcome = await claude.runReply({
			clonePath,
			prompt: buildReplyPrompt({
				reference: tracked,
				clonePath,
				headSha,
				path: thread.path,
				line: thread.line,
				comments: thread.comments,
			}),
		});

		if (outcome.kind === 'usage_limited' || outcome.kind === 'setup_broken') {
			return outcome;
		}

		if (!isReplyStillWanted(params, tracked.id)) {
			logger.warn('reply_not_posted', { id: tracked.id, commentId: comment.databaseId });

			return { kind: 'completed' };
		}

		if (outcome.kind === 'result' && outcome.result.reply !== null) {
			await github.replyToComment(
				tracked,
				comment.databaseId,
				appendBotFooter(outcome.result.reply, headSha),
			);
			store.recordActivity(tracked.id, 'reply_posted', { commentId: comment.databaseId });
		}

		store.markCommentHandled(comment.databaseId, tracked.id, now());
		logger.info('reply_job_finished', {
			id: tracked.id,
			commentId: comment.databaseId,
			outcome: outcome.kind,
			hasReplied: outcome.kind === 'result' && outcome.result.reply !== null,
		});
	} catch (error) {
		store.markCommentHandled(comment.databaseId, tracked.id, now());
		logger.error('reply_job_failed', { id: tracked.id, commentId: comment.databaseId, error });
	}

	return { kind: 'completed' };
};
