import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	applyStreamLine,
	createReviewProgress,
	labelForAgentType,
	nameSubagent,
} from './review-progress.js';

const RECORDED_STREAM = readFileSync(
	new URL('./fixtures/claude-stream-subagents.ndjson', import.meta.url),
	'utf8',
)
	.trim()
	.split('\n');

const replay = (lines: string[]) => {
	return lines.reduce(
		(progress, line, index) => applyStreamLine(progress, line, 1000 + index),
		createReviewProgress(0),
	);
};

const assistantText = (text: string, parentToolUseId: string | null = null): string => {
	return JSON.stringify({
		type: 'assistant',
		parent_tool_use_id: parentToolUseId,
		message: { content: [{ type: 'text', text }] },
	});
};

describe('applyStreamLine on a recorded Claude Code stream', () => {
	it('tracks both subagents from start to completion', () => {
		const progress = replay(RECORDED_STREAM);

		expect(
			progress.subagents.map(({ agentType, label, description, status }) => ({
				agentType,
				label,
				description,
				status,
			})),
		).toEqual([
			{ agentType: 'Explore', label: 'Explore', description: 'List files', status: 'completed' },
			{ agentType: 'general-purpose', label: 'Say hello', description: '', status: 'completed' },
		]);
		expect(progress.subagents.every((subagent) => subagent.finishedAt !== null)).toBe(true);
	});

	it('the last status line wins', () => {
		expect(replay(RECORDED_STREAM)).toMatchObject({
			phase: 'draft',
			message: 'Returning structured output',
		});
	});

	it('mid-stream: one subagent still running, its current step shown', () => {
		const untilProgress = RECORDED_STREAM.findIndex((line) => line.includes('"task_progress"'));
		const progress = replay(RECORDED_STREAM.slice(0, untilProgress + 1));
		const explore = progress.subagents.find((subagent) => subagent.agentType === 'Explore');

		expect(explore).toMatchObject({
			status: 'running',
			currentStep: 'Running List files in current folder',
		});
		expect(progress.message).toBe('Spawning two subagents in parallel');
	});
});

describe('applyStreamLine edge cases', () => {
	it('status line inside a longer text block → parsed', () => {
		const line = assistantText(
			'Thinking about it\nPRB_STATUS {"phase":"review","message":"Checking tests"}\nmore',
		);

		expect(applyStreamLine(createReviewProgress(0), line, 5)).toMatchObject({
			phase: 'review',
			message: 'Checking tests',
			updatedAt: 5,
		});
	});

	it('status line from inside a subagent → ignored', () => {
		const line = assistantText('PRB_STATUS {"message":"subagent noise"}', 'toolu_1');
		const before = createReviewProgress(0, 'Starting');

		expect(applyStreamLine(before, line, 5)).toBe(before);
	});

	it('malformed status JSON, overlong message or non-JSON line → progress unchanged', () => {
		const before = createReviewProgress(0, 'Starting');

		expect(applyStreamLine(before, assistantText('PRB_STATUS {oops'), 5)).toBe(before);
		expect(
			applyStreamLine(before, assistantText(`PRB_STATUS {"message":"${'x'.repeat(300)}"}`), 5),
		).toBe(before);
		expect(applyStreamLine(before, 'not json at all', 5)).toBe(before);
	});

	it('failed subagent → failed with a finish time; duplicate start ignored', () => {
		const started = JSON.stringify({
			type: 'system',
			subtype: 'task_started',
			tool_use_id: 't1',
			subagent_type: 'proxy:architect',
			description: 'Design',
		});
		const failed = JSON.stringify({
			type: 'system',
			subtype: 'task_notification',
			tool_use_id: 't1',
			status: 'failed',
		});
		const progress = [started, started, failed].reduce(
			(current, line, index) => applyStreamLine(current, line, index + 1),
			createReviewProgress(0),
		);

		expect(progress.subagents).toHaveLength(1);
		expect(progress.subagents[0]).toMatchObject({
			label: 'Architecture',
			status: 'failed',
			finishedAt: 3,
		});
	});
});

describe('labelForAgentType', () => {
	it('maps proxy advisors to short labels and strips other plugin prefixes', () => {
		expect(labelForAgentType('proxy:clean-code-architect')).toBe('Clean code');
		expect(labelForAgentType('proxy:test-architect')).toBe('Tests');
		expect(labelForAgentType('other-plugin:security')).toBe('security');
		expect(labelForAgentType('Explore')).toBe('Explore');
	});
});

describe('background shell tasks', () => {
	it('a background Bash command → not listed as a subagent; a local agent task still is', () => {
		const lines = [
			{
				subtype: 'task_started',
				tool_use_id: 'b1',
				task_type: 'local_bash',
				description: 'Pin snapshot',
			},
			{ subtype: 'task_notification', tool_use_id: 'b1', status: 'completed' },
			{
				subtype: 'task_started',
				tool_use_id: 'a1',
				task_type: 'local_agent',
				subagent_type: 'proxy:architect',
				description: 'Design',
			},
		].map((event) => JSON.stringify({ type: 'system', ...event }));
		const progress = lines.reduce(
			(current, line) => applyStreamLine(current, line, 1),
			createReviewProgress(0),
		);

		expect(progress.subagents.map((subagent) => subagent.label)).toEqual(['Architecture']);
	});
});

describe('nameSubagent', () => {
	it('a named agent type → its label, with the description kept as detail', () => {
		expect(nameSubagent('proxy:architect', 'Module boundaries')).toEqual({
			label: 'Architecture',
			description: 'Module boundaries',
		});
	});

	it('no type or a generic type → the task description becomes the name', () => {
		expect(nameSubagent(undefined, 'Correctness pass')).toEqual({
			label: 'Correctness pass',
			description: '',
		});
		expect(nameSubagent('general-purpose', 'Security pass').label).toBe('Security pass');
		expect(nameSubagent('fork', '  ').label).toBe('Helper');
	});
});

describe('applyStreamLine more edge cases', () => {
	const system = (value: Record<string, unknown>): string =>
		JSON.stringify({ type: 'system', ...value });

	it('progress or completion for an unknown subagent → same object', () => {
		const before = createReviewProgress(0);

		expect(
			applyStreamLine(
				before,
				system({ subtype: 'task_progress', tool_use_id: 'nope', description: 'x' }),
				1,
			),
		).toBe(before);
		expect(
			applyStreamLine(
				before,
				system({ subtype: 'task_notification', tool_use_id: 'nope', status: 'completed' }),
				1,
			),
		).toBe(before);
	});

	it('a status without phase keeps the previous phase; two lines in one block → last wins', () => {
		const first = applyStreamLine(
			createReviewProgress(0),
			assistantText('PRB_STATUS {"phase":"review","message":"A"}'),
			1,
		);
		const second = applyStreamLine(
			first,
			assistantText('PRB_STATUS {"message":"B"}\nPRB_STATUS {"message":"C"}'),
			2,
		);

		expect(second).toMatchObject({ phase: 'review', message: 'C' });
	});

	it('indented, bulleted or backticked status lines are still read', () => {
		for (const text of [
			'   PRB_STATUS {"message":"Indented"}',
			'- PRB_STATUS {"message":"Indented"}',
			'`PRB_STATUS {"message":"Indented"}`',
		]) {
			expect(applyStreamLine(createReviewProgress(0), assistantText(text), 1).message).toBe(
				'Indented',
			);
		}
	});

	it('a subagent that ends with any status other than completed → failed', () => {
		const progress = [
			system({
				subtype: 'task_started',
				tool_use_id: 't1',
				subagent_type: 'proxy:product',
				description: 'Scope',
			}),
			system({ subtype: 'task_notification', tool_use_id: 't1', status: 'stopped' }),
		].reduce(
			(current, line, index) => applyStreamLine(current, line, index + 1),
			createReviewProgress(0),
		);

		expect(progress.subagents[0]).toMatchObject({ status: 'failed', finishedAt: 2 });
	});
});
