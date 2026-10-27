import type { Logger } from '../logging/logger.js';
import { createReviewProgress } from '../review/review-progress.js';
import type { ReviewProgress } from '../review/review-progress.js';
import {
	describeUnrepairedResult,
	isWrongShapeResult,
	MAX_REPAIR_ATTEMPTS,
	REPAIR_PAUSE_MS,
	repairProgressMessage,
	toReviewRun,
} from '../review/review-repair-rules.js';
import type { RepairStop, ReviewOutcome, ReviewRun } from '../review/review-repair-rules.js';
import type { BotDependencies } from './bot-context.js';

export interface RepairContext {
	claude: BotDependencies['claude'];
	sleep: BotDependencies['sleep'];
	now: () => number;
	logger: Logger;
	pullRequestUrl: string;
	clonePath: string;
	signal?: AbortSignal;
	onProgress?: (progress: ReviewProgress) => void;
	isReleased: () => boolean;
	saveSession: (sessionId: string) => void;
	clearSession: () => void;
}

type RepairResult =
	| { kind: 'released' }
	| { kind: 'finished'; outcome: ReviewOutcome }
	| { kind: 'gave_up'; stop: RepairStop };

interface RepairReviewParams {
	context: RepairContext;
	sessionId: string;
	lastProgress: ReviewProgress | null;
}

const repairReview = async ({
	context,
	sessionId,
	lastProgress,
}: RepairReviewParams): Promise<RepairResult> => {
	const { claude, sleep, now, logger, clonePath, signal } = context;
	const attempts = Array.from({ length: MAX_REPAIR_ATTEMPTS }, (_, index) => index + 1);
	const current = { sessionId };

	for (const attempt of attempts) {
		if (context.isReleased()) {
			return { kind: 'released' };
		}

		logger.info('repair_started', { sessionId: current.sessionId, attempt });
		context.onProgress?.({
			...(lastProgress ?? createReviewProgress(now())),
			message: repairProgressMessage(attempt),
			updatedAt: now(),
		});

		const outcome = await claude.runRepair({
			sessionId: current.sessionId,
			clonePath,
			attempt,
			signal,
		});

		logger.info('repair_finished', {
			sessionId: current.sessionId,
			attempt,
			outcome: outcome.kind,
		});

		if (outcome.kind !== 'failed') {
			return { kind: 'finished', outcome };
		}

		if (!isWrongShapeResult(outcome)) {
			logger.warn('repair_stopped', { attempt, summary: outcome.summary });

			return context.isReleased()
				? { kind: 'released' }
				: { kind: 'gave_up', stop: { reason: 'stopped', summary: outcome.summary } };
		}

		current.sessionId = outcome.repairSessionId;
		context.saveSession(current.sessionId);

		if (attempt < MAX_REPAIR_ATTEMPTS) {
			await sleep(REPAIR_PAUSE_MS);
		}
	}

	return { kind: 'gave_up', stop: { reason: 'exhausted' } };
};

const repairSavedSession = async (
	context: RepairContext,
	savedSessionId: string,
): Promise<ReviewRun | 'released' | 'fall_back'> => {
	const repaired = await repairReview({ context, sessionId: savedSessionId, lastProgress: null });

	if (repaired.kind === 'released') {
		return 'released';
	}

	if (repaired.kind === 'finished') {
		return toReviewRun(repaired.outcome, true);
	}

	context.logger.warn('saved_session_repair_failed', { sessionId: savedSessionId });
	context.clearSession();

	return context.isReleased() ? 'released' : 'fall_back';
};

interface ReviewWithRepairParams {
	context: RepairContext;
	savedSessionId: string | null;
}

export const reviewWithRepair = async ({
	context,
	savedSessionId,
}: ReviewWithRepairParams): Promise<ReviewRun | null> => {
	if (savedSessionId !== null) {
		const savedRun = await repairSavedSession(context, savedSessionId);

		if (savedRun === 'released') {
			return null;
		}

		if (savedRun !== 'fall_back') {
			return savedRun;
		}
	}

	const latest: { progress: ReviewProgress | null } = { progress: null };
	const reviewed = await context.claude.runReview({
		pullRequestUrl: context.pullRequestUrl,
		clonePath: context.clonePath,
		onProgress: (progress) => {
			latest.progress = progress;
			context.onProgress?.(progress);
		},
		signal: context.signal,
	});

	if (!isWrongShapeResult(reviewed)) {
		return toReviewRun(reviewed, false);
	}

	context.saveSession(reviewed.repairSessionId);

	const repaired = await repairReview({
		context,
		sessionId: reviewed.repairSessionId,
		lastProgress: latest.progress,
	});

	if (repaired.kind === 'released') {
		return null;
	}

	return repaired.kind === 'finished'
		? toReviewRun(repaired.outcome, true)
		: toReviewRun({ ...reviewed, summary: describeUnrepairedResult(repaired.stop) }, false);
};
