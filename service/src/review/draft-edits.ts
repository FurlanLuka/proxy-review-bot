import { z } from 'zod';
import type { ReviewEvent } from '../github/github-types.js';
import type { DraftedReviewResult } from './review-result.js';

export const DRAFT_EDIT_SCHEMA = z
	.object({
		headSha: z.string().min(1),
		event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
		mainReview: z.string().max(65_000),
		comments: z.array(
			z.object({
				path: z.string().min(1),
				line: z.number().int().positive(),
				side: z.enum(['LEFT', 'RIGHT']),
				body: z.string().trim().min(1).max(65_000),
			}),
		),
		fileComments: z.array(
			z.object({ path: z.string().min(1), body: z.string().trim().min(1).max(65_000) }),
		),
	})
	.strict();

export type DraftEdit = z.infer<typeof DRAFT_EDIT_SCHEMA>;

export type DraftEditResult =
	| { kind: 'valid'; event: ReviewEvent; draft: DraftedReviewResult }
	| { kind: 'stale' }
	| { kind: 'invalid'; reason: string };

const describeSchemaError = (error: z.ZodError): string => {
	const bodyIssue = error.issues.find((issue) => issue.path.at(-1) === 'body');

	return bodyIssue?.code === 'too_small'
		? 'a comment is empty'
		: bodyIssue?.code === 'too_big'
			? 'a comment is too long'
			: 'malformed edit';
};

interface CommentAnchor {
	path: string;
	line: number;
	side: string;
}

const anchorKey = (comment: CommentAnchor): string => {
	return `${comment.side}:${comment.line}:${comment.path}`;
};

interface ApplyDraftEditsParams {
	draft: DraftedReviewResult;
	draftHeadSha: string;
	candidate: unknown;
	isOwn: boolean;
}

export const OWN_PULL_REQUEST_REASON = 'you can only comment on your own PR';

export const applyDraftEdits = ({
	draft,
	draftHeadSha,
	candidate,
	isOwn,
}: ApplyDraftEditsParams): DraftEditResult => {
	const parsed = DRAFT_EDIT_SCHEMA.safeParse(candidate);

	if (!parsed.success) {
		return { kind: 'invalid', reason: describeSchemaError(parsed.error) };
	}

	const edit = parsed.data;

	if (edit.headSha !== draftHeadSha) {
		return { kind: 'stale' };
	}

	const knownAnchors = new Set(draft.comments.map(anchorKey));
	const knownFilePaths = new Set(draft.fileComments.map((comment) => comment.path));

	if (isOwn && edit.event !== 'COMMENT') {
		return { kind: 'invalid', reason: OWN_PULL_REQUEST_REASON };
	}

	if (edit.event === 'APPROVE' && draft.filing !== 'approve') {
		return { kind: 'invalid', reason: 'this draft cannot approve' };
	}

	const hasFeedback =
		edit.mainReview.trim().length > 0 || edit.comments.length > 0 || edit.fileComments.length > 0;

	if (edit.event === 'REQUEST_CHANGES' && !hasFeedback) {
		return { kind: 'invalid', reason: 'requesting changes needs a comment' };
	}

	if (!edit.comments.every((comment) => knownAnchors.has(anchorKey(comment)))) {
		return { kind: 'invalid', reason: 'unknown inline comment anchor' };
	}

	if (!edit.fileComments.every((comment) => knownFilePaths.has(comment.path))) {
		return { kind: 'invalid', reason: 'unknown file comment path' };
	}

	return {
		kind: 'valid',
		event: edit.event,
		draft: {
			...draft,
			mainReview: edit.mainReview,
			comments: edit.comments,
			fileComments: edit.fileComments,
		},
	};
};
