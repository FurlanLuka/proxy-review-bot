import { z } from 'zod';

export const STATUS_LINE_PREFIX = 'PRB_STATUS ';

export type SubagentStatus = 'running' | 'completed' | 'failed';

export interface SubagentProgress {
	id: string;
	agentType: string;
	label: string;
	description: string;
	status: SubagentStatus;
	currentStep: string | null;
	startedAt: number;
	finishedAt: number | null;
}

export interface ReviewProgress {
	phase: string | null;
	message: string | null;
	subagents: SubagentProgress[];
	updatedAt: number;
}

const AGENT_LABELS: Record<string, string> = {
	'proxy:product': 'Product',
	'proxy:architect': 'Architecture',
	'proxy:clean-code-architect': 'Clean code',
	'proxy:test-architect': 'Tests',
};

const GENERIC_AGENT_TYPES = new Set(['general-purpose', 'fork']);

const STATUS_PAYLOAD_SCHEMA = z.object({
	phase: z.string().max(40).optional(),
	message: z.string().min(1).max(200),
});

const STREAM_EVENT_SCHEMA = z.object({
	type: z.string(),
	subtype: z.string().optional(),
	parent_tool_use_id: z.string().nullable().optional(),
	tool_use_id: z.string().optional(),
	description: z.string().optional(),
	subagent_type: z.string().optional(),
	task_type: z.string().optional(),
	status: z.string().optional(),
	message: z
		.object({ content: z.union([z.string(), z.array(z.record(z.unknown()))]).optional() })
		.optional(),
});

type StreamEvent = z.infer<typeof STREAM_EVENT_SCHEMA>;

export const createReviewProgress = (
	now: number,
	message: string | null = null,
): ReviewProgress => ({
	phase: null,
	message,
	subagents: [],
	updatedAt: now,
});

export const labelForAgentType = (agentType: string): string => {
	return AGENT_LABELS[agentType] ?? agentType.replace(/^[\w-]+:/, '');
};

interface SubagentNaming {
	label: string;
	description: string;
}

export const nameSubagent = (
	agentType: string | undefined,
	description: string,
): SubagentNaming => {
	if (agentType !== undefined && !GENERIC_AGENT_TYPES.has(agentType)) {
		return { label: labelForAgentType(agentType), description };
	}

	return { label: description.trim() || 'Helper', description: '' };
};

const parseEvent = (line: string): StreamEvent | null => {
	try {
		const parsed = STREAM_EVENT_SCHEMA.safeParse(JSON.parse(line));

		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

const findStatusUpdate = (event: StreamEvent): z.infer<typeof STATUS_PAYLOAD_SCHEMA> | null => {
	const content = event.message?.content;

	if (event.type !== 'assistant' || event.parent_tool_use_id || !Array.isArray(content)) {
		return null;
	}

	const statusLines = content
		.flatMap((block) =>
			block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
		)
		.flatMap((text) => text.split('\n'))
		.map((line) => line.trim().replace(/^[`*-]+\s*|`+$/g, ''))
		.filter((line) => line.startsWith(STATUS_LINE_PREFIX));
	const lastStatusLine = statusLines.at(-1);

	if (lastStatusLine === undefined) {
		return null;
	}

	try {
		const parsed = STATUS_PAYLOAD_SCHEMA.safeParse(
			JSON.parse(lastStatusLine.slice(STATUS_LINE_PREFIX.length)),
		);

		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

const updateSubagent = (
	progress: ReviewProgress,
	id: string,
	update: Partial<SubagentProgress>,
): SubagentProgress[] => {
	return progress.subagents.map((subagent) =>
		subagent.id === id ? { ...subagent, ...update } : subagent,
	);
};

const applyTaskEvent = (
	progress: ReviewProgress,
	event: StreamEvent,
	now: number,
): ReviewProgress | null => {
	const id = event.tool_use_id;

	if (id === undefined) {
		return null;
	}

	const isKnown = progress.subagents.some((subagent) => subagent.id === id);
	const isShellTask = event.task_type !== undefined && event.task_type !== 'local_agent';

	if (event.subtype === 'task_started' && !isKnown && !isShellTask) {
		const naming = nameSubagent(event.subagent_type, event.description ?? '');

		return {
			...progress,
			subagents: [
				...progress.subagents,
				{
					id,
					agentType: event.subagent_type ?? 'general-purpose',
					...naming,
					status: 'running',
					currentStep: null,
					startedAt: now,
					finishedAt: null,
				},
			],
		};
	}

	if (event.subtype === 'task_progress' && isKnown) {
		return {
			...progress,
			subagents: updateSubagent(progress, id, { currentStep: event.description ?? null }),
		};
	}

	if (event.subtype === 'task_notification' && isKnown) {
		const status: SubagentStatus = event.status === 'completed' ? 'completed' : 'failed';

		return {
			...progress,
			subagents: updateSubagent(progress, id, { status, currentStep: null, finishedAt: now }),
		};
	}

	return null;
};

export const applyStreamLine = (
	progress: ReviewProgress,
	line: string,
	now: number,
): ReviewProgress => {
	const event = parseEvent(line);

	if (event === null) {
		return progress;
	}

	const next = event.type === 'system' ? applyTaskEvent(progress, event, now) : null;

	if (next !== null) {
		return { ...next, updatedAt: now };
	}

	const statusUpdate = findStatusUpdate(event);

	return statusUpdate === null
		? progress
		: {
				...progress,
				phase: statusUpdate.phase ?? progress.phase,
				message: statusUpdate.message,
				updatedAt: now,
			};
};
