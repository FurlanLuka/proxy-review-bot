import { describe, expect, it } from 'bun:test';
import { createBotMarker } from '../review/bot-marker.js';
import { makeComment, makeThread } from '../test-support/factories.js';
import { findUnansweredComment, MAX_BOT_REPLIES_PER_THREAD } from './reply-decisions.js';

const BOT_BODY = `Finding\n${createBotMarker('head-1')}`;
const botRoot = makeComment({ databaseId: 1, authorLogin: 'luka', body: BOT_BODY });
const question = makeComment({ databaseId: 2, authorLogin: 'ana', body: 'Why?' });

const find = (thread = makeThread([botRoot, question]), handled: number[] = []) => {
	return findUnansweredComment({
		thread,
		login: 'luka',
		isCommentHandled: (commentId) => handled.includes(commentId),
	});
};

describe('findUnansweredComment', () => {
	it('question under a bot thread → that comment', () => {
		expect(find()?.databaseId).toBe(2);
	});

	it('root has no bot marker (developer reviewed by hand) → null', () => {
		const manualRoot = makeComment({ databaseId: 1, authorLogin: 'luka', body: 'Mine' });

		expect(find(makeThread([manualRoot, question]))).toBeNull();
	});

	it('latest comment by the developer, with or without marker → null', () => {
		const developerReply = makeComment({ databaseId: 3, authorLogin: 'luka', body: 'Agreed' });
		const botReply = makeComment({ databaseId: 3, authorLogin: 'luka', body: BOT_BODY });

		expect(find(makeThread([botRoot, question, developerReply]))).toBeNull();
		expect(find(makeThread([botRoot, question, botReply]))).toBeNull();
	});

	it('resolved thread → null', () => {
		expect(find(makeThread([botRoot, question], { isResolved: true }))).toBeNull();
	});

	it('latest comment from a bot account → null', () => {
		const botComment = makeComment({ databaseId: 3, authorLogin: 'coderabbit', authorType: 'Bot' });

		expect(find(makeThread([botRoot, botComment]))).toBeNull();
	});

	it('already handled → null; a newer comment after it → that one', () => {
		expect(find(makeThread([botRoot, question]), [2])).toBeNull();

		const followUp = makeComment({ databaseId: 4, authorLogin: 'ana', body: 'And?' });
		const botReply = makeComment({ databaseId: 3, authorLogin: 'luka', body: BOT_BODY });

		expect(find(makeThread([botRoot, question, botReply, followUp]), [2])?.databaseId).toBe(4);
	});

	it('only the root comment → null', () => {
		expect(find(makeThread([botRoot]))).toBeNull();
	});

	it(`bot already replied ${MAX_BOT_REPLIES_PER_THREAD} times → null`, () => {
		const botReplies = Array.from({ length: MAX_BOT_REPLIES_PER_THREAD }, (_, index) =>
			makeComment({ databaseId: 10 + index, authorLogin: 'luka', body: BOT_BODY }),
		);
		const latest = makeComment({ databaseId: 99, authorLogin: 'ana', body: 'Still?' });

		expect(find(makeThread([botRoot, ...botReplies, latest]))).toBeNull();
	});
});
