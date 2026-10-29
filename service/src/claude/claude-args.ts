import { isDangerousGitVariable } from './command-guard.js';

export type ClaudeJobKind = 'review' | 'reply';

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git:*)', 'Bash(gh:*)'];
const REVIEW_ONLY_TOOLS = ['Task', 'Agent', 'Skill'];
const DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'];

interface BuildClaudeArgsParams {
	kind: ClaudeJobKind;
	prompt: string;
	systemPrompt: string;
	jsonSchema: object;
	model: string | null;
	resumeSessionId?: string;
}

export const buildClaudeArgs = ({
	kind,
	prompt,
	systemPrompt,
	jsonSchema,
	model,
	resumeSessionId,
}: BuildClaudeArgsParams): string[] => {
	const isRepair = resumeSessionId !== undefined;
	const allowedTools =
		kind === 'review' && !isRepair ? [...READ_TOOLS, ...REVIEW_ONLY_TOOLS] : READ_TOOLS;
	const disallowedTools = isRepair ? [...DISALLOWED_TOOLS, ...REVIEW_ONLY_TOOLS] : DISALLOWED_TOOLS;
	const sessionArgs = kind === 'review' ? [] : ['--no-session-persistence'];
	const resumeArgs = resumeSessionId === undefined ? [] : ['--resume', resumeSessionId];
	const modelArgs = model === null ? [] : ['--model', model];

	return [
		'-p',
		prompt,
		...resumeArgs,
		...modelArgs,
		'--output-format',
		'stream-json',
		'--verbose',
		'--json-schema',
		JSON.stringify(jsonSchema),
		'--append-system-prompt',
		systemPrompt,
		'--setting-sources',
		'user',
		...sessionArgs,
		'--allowedTools',
		allowedTools.join(','),
		'--disallowedTools',
		disallowedTools.join(','),
	];
};

interface BuildClaudeEnvParams {
	baseEnv: Record<string, string | undefined>;
	shimDirectory: string;
}

export const buildClaudeEnv = ({
	baseEnv,
	shimDirectory,
}: BuildClaudeEnvParams): Record<string, string | undefined> => {
	const environment = Object.fromEntries(
		Object.entries(baseEnv).filter(
			([name]) =>
				name !== 'ANTHROPIC_API_KEY' &&
				name !== 'NODE_OPTIONS' &&
				!name.startsWith('BUN_') &&
				!isDangerousGitVariable(name),
		),
	);

	return { ...environment, PATH: `${shimDirectory}:${environment.PATH ?? ''}` };
};
