import { describe, expect, it } from 'bun:test';
import { makeDraft } from '../test-support/factories.js';
import {
	describeUnrepairedResult,
	findUsableSavedSession,
	isWrongShapeResult,
	repairProgressMessage,
	SAVED_SESSION_MAX_AGE_MS,
	toReviewRun,
	UNREPAIRED_RESULT_SUMMARY,
} from './review-repair-rules.js';
import type { SavedRepairSession } from './review-repair-rules.js';

const NOW = 1_000_000_000;

const saved = (overrides: Partial<SavedRepairSession> = {}): SavedRepairSession => ({
	repairSessionId: 'session-1',
	repairHeadSha: 'head-1',
	repairSavedAt: NOW - 1,
	...overrides,
});

describe('findUsableSavedSession', () => {
	const cases: [string, SavedRepairSession, string, number, string | null][] = [
		['fresh session on the same head → the session', saved(), 'head-1', NOW, 'session-1'],
		['another head → none', saved(), 'head-2', NOW, null],
		['no session saved → none', saved({ repairSessionId: null }), 'head-1', NOW, null],
		['no saved time → none', saved({ repairSavedAt: null }), 'head-1', NOW, null],
		[
			'just under 24 hours old → the session',
			saved({ repairSavedAt: NOW - SAVED_SESSION_MAX_AGE_MS + 1 }),
			'head-1',
			NOW,
			'session-1',
		],
		[
			'exactly 24 hours old → none',
			saved({ repairSavedAt: NOW - SAVED_SESSION_MAX_AGE_MS }),
			'head-1',
			NOW,
			null,
		],
	];

	for (const [name, savedSession, headSha, now, expected] of cases) {
		it(name, () => {
			expect(findUsableSavedSession({ saved: savedSession, headSha, now })).toBe(expected);
		});
	}
});

describe('describeUnrepairedResult', () => {
	it('all tries used → the exhausted summary', () => {
		expect(describeUnrepairedResult({ reason: 'exhausted' })).toBe(UNREPAIRED_RESULT_SUMMARY);
		expect(UNREPAIRED_RESULT_SUMMARY).toBe(
			'Claude finished but never returned the review (5 repair tries failed)',
		);
	});

	it('repair stopped early → says why, not "5 tries"', () => {
		expect(describeUnrepairedResult({ reason: 'stopped', summary: 'Claude run timed out' })).toBe(
			'Claude finished but never returned the review (repair stopped: Claude run timed out)',
		);
	});
});

describe('isWrongShapeResult', () => {
	it('a failure with schema issues and a session → repairable', () => {
		expect(
			isWrongShapeResult({
				kind: 'failed',
				summary: 'wrong shape',
				schemaIssues: ['result: Required'],
				repairSessionId: 'session-1',
			}),
		).toBe(true);
	});

	it('no session, no schema issues, or not a failure → not repairable', () => {
		expect(
			isWrongShapeResult({ kind: 'failed', summary: 'x', schemaIssues: ['result: Required'] }),
		).toBe(false);
		expect(isWrongShapeResult({ kind: 'failed', summary: 'x', repairSessionId: 'session-1' })).toBe(
			false,
		);
		expect(isWrongShapeResult({ kind: 'result', result: makeDraft() })).toBe(false);
	});
});

describe('toReviewRun', () => {
	it('a repaired result, or one recovered from text → recovered', () => {
		expect(toReviewRun({ kind: 'result', result: makeDraft() }, true).isRecovered).toBe(true);
		expect(
			toReviewRun({ kind: 'result', result: makeDraft(), isRecovered: true }, false).isRecovered,
		).toBe(true);
	});

	it('a normal result or a failure → not recovered', () => {
		expect(toReviewRun({ kind: 'result', result: makeDraft() }, false).isRecovered).toBe(false);
		expect(toReviewRun({ kind: 'failed', summary: 'x' }, true).isRecovered).toBe(false);
	});
});

describe('repairProgressMessage', () => {
	it('shows the try out of the maximum', () => {
		expect(repairProgressMessage(2)).toBe('Collecting the finished review (try 2 of 5)');
	});
});
