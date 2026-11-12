import { describe, expect, it } from 'bun:test';
import { REVIEW_SYSTEM_PROMPT, withReviewInstructions } from './prompts.js';

describe('withReviewInstructions', () => {
	it('no instructions → the system prompt unchanged', () => {
		expect(withReviewInstructions(REVIEW_SYSTEM_PROMPT, '')).toBe(REVIEW_SYSTEM_PROMPT);
	});

	it('instructions → their own section after the rules, with the precedence spelled out', () => {
		const prompt = withReviewInstructions(REVIEW_SYSTEM_PROMPT, 'Keep comments short.');

		expect(prompt.startsWith(REVIEW_SYSTEM_PROMPT)).toBe(true);
		expect(prompt.endsWith('\n\nKeep comments short.')).toBe(true);
		expect(prompt).toContain(
			"The developer's own preferences for this review (tone, how to write comments, what to focus on). Follow them unless they conflict with the rules above.",
		);
	});
});
