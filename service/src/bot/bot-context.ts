import type { ClaudeClient } from '../claude/claude-client.js';
import type { CloneManager } from '../clones/clones.js';
import type { GitHubClient } from '../github/github-types.js';
import type { Logger } from '../logging/logger.js';
import type { Readiness } from '../readiness/readiness.js';
import type { SettingsStore } from '../settings/settings.js';
import type { Store } from '../tracking/store.js';

export interface ReadinessReport {
	readiness: Readiness;
	viewerLogin: string | null;
}

export interface BotDependencies {
	store: Store;
	settingsStore: SettingsStore;
	github: GitHubClient;
	claude: ClaudeClient;
	clones: CloneManager;
	runReadinessChecks: () => Promise<ReadinessReport>;
	logger: Logger;
	now: () => number;
	sleep: (milliseconds: number) => Promise<void>;
}

export interface BotRuntime {
	readiness: Readiness;
	viewerLogin: string | null;
	readinessCheckedAt: number | null;
	isReplyJobRunning: boolean;
	isSyncing: boolean;
}
