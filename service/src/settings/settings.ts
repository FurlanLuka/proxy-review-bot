import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const TOOL_PATH_SCHEMA = z.string().min(1).nullable().default(null);

export const SETTINGS_SCHEMA = z
	.object({
		reviewMode: z.enum(['manual', 'auto']).default('manual'),
		postReviews: z.enum(['ask', 'auto']).optional(),
		autoApprove: z.enum(['off', 'on', 'small']).default('off'),
		smallPullRequestLineLimit: z.number().int().min(1).max(100_000).default(200),
		maxRounds: z.number().int().min(1).max(20).default(5),
		pollIntervalSeconds: z.number().int().min(15).max(3600).default(60),
		answerQuestions: z.boolean().default(true),
		watch: z.array(z.string().min(1)).default([]),
		skip: z.array(z.string().min(1)).default([]),
		toolPaths: z
			.object({ claude: TOOL_PATH_SCHEMA, gh: TOOL_PATH_SCHEMA, git: TOOL_PATH_SCHEMA })
			.default({}),
	})
	.strict()
	.transform((settings) => ({
		...settings,
		postReviews:
			settings.postReviews ??
			(settings.reviewMode === 'auto' ? ('auto' as const) : ('ask' as const)),
	}));

export type Settings = z.infer<typeof SETTINGS_SCHEMA>;

export const DEFAULT_SETTINGS: Settings = SETTINGS_SCHEMA.parse({});

export interface SettingsStore {
	get(): Settings;
	replace(candidate: unknown): Settings | null;
}

export const createSettingsStore = (filePath: string): SettingsStore => {
	const readFromDisk = (): Settings => {
		if (!existsSync(filePath)) {
			return DEFAULT_SETTINGS;
		}

		const parsed = SETTINGS_SCHEMA.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));

		return parsed.success ? parsed.data : DEFAULT_SETTINGS;
	};

	const state = { current: readFromDisk() };

	return {
		get: () => state.current,
		replace: (candidate) => {
			const parsed = SETTINGS_SCHEMA.safeParse(candidate);

			if (!parsed.success) {
				return null;
			}

			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(`${filePath}.tmp`, JSON.stringify(parsed.data, null, '\t'));
			renameSync(`${filePath}.tmp`, filePath);
			state.current = parsed.data;

			return parsed.data;
		},
	};
};
