import type { TrackedPullRequest } from '../tracking/tracking-types.js';
import type { ClaudeRunOutcome, ReviewResult } from './review-result.js';

export const MAX_REPAIR_ATTEMPTS = 5;
export const REPAIR_PAUSE_MS = 3_000;
export const SAVED_SESSION_MAX_AGE_MS = 24 * 60 * 60_000;
export const UNREPAIRED_RESULT_SUMMARY = `Claude finished but never returned the review (${MAX_REPAIR_ATTEMPTS} repair tries failed)`;

export type ReviewOutcome = ClaudeRunOutcome<ReviewResult>;

export type FailedReviewOutcome = Extract<ReviewOutcome, { kind: 'failed' }>;

export type WrongShapeOutcome = FailedReviewOutcome & {
	schemaIssues: string[];
	repairSessionId: string;
};

export type RepairStop = { reason: 'exhausted' } | { reason: 'stopped'; summary: string };

export interface ReviewRun {
	outcome: ReviewOutcome;
	isRecovered: boolean;
}

export type SavedRepairSession = Pick<
	TrackedPullRequest,
	'repairSessionId' | 'repairHeadSha' | 'repairSavedAt'
>;

export const repairProgressMessage = (attempt: number): string => {
	return `Collecting the finished review (try ${attempt} of ${MAX_REPAIR_ATTEMPTS})`;
};

export const describeUnrepairedResult = (stop: RepairStop): string => {
	return stop.reason === 'exhausted'
		? UNREPAIRED_RESULT_SUMMARY
		: `Claude finished but never returned the review (repair stopped: ${stop.summary})`;
};

export const isWrongShapeResult = (outcome: ReviewOutcome): outcome is WrongShapeOutcome => {
	return (
		outcome.kind === 'failed' &&
		outcome.schemaIssues !== undefined &&
		outcome.repairSessionId !== undefined
	);
};

interface FindUsableSavedSessionParams {
	saved: SavedRepairSession;
	headSha: string;
	now: number;
}

export const findUsableSavedSession = ({
	saved,
	headSha,
	now,
}: FindUsableSavedSessionParams): string | null => {
	const isUsable =
		saved.repairSessionId !== null &&
		saved.repairHeadSha === headSha &&
		saved.repairSavedAt !== null &&
		now - saved.repairSavedAt < SAVED_SESSION_MAX_AGE_MS;

	return isUsable ? saved.repairSessionId : null;
};

export const toReviewRun = (outcome: ReviewOutcome, isRepaired: boolean): ReviewRun => {
	return {
		outcome,
		isRecovered: outcome.kind === 'result' && (isRepaired || outcome.isRecovered === true),
	};
};
