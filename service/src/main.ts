import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApiHandler } from './api/api.js';
import { createBot } from './bot/bot.js';
import { createClaudeClient, installCommandShims } from './claude/claude-client.js';
import { createCloneManager } from './clones/clones.js';
import { killRunningCommands, runCommand } from './commands/run-command.js';
import { createGitHubClient } from './github/github-client.js';
import { createLogger } from './logging/logger.js';
import { checkReadiness, gatherReadinessFacts } from './readiness/readiness.js';
import { createSettingsStore } from './settings/settings.js';
import { createStore } from './tracking/store.js';

const dataDirectory =
	process.env.PRB_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'ProxyReviewBot');
const logFilePath =
	process.env.PRB_LOG_FILE ?? join(homedir(), 'Library', 'Logs', 'ProxyReviewBot', 'service.log');
const lockFilePath = join(dataDirectory, 'service.pid');

const logger = createLogger({ filePath: logFilePath, baseFields: { pid: process.pid } });

const isProcessAlive = (processId: number): boolean => {
	try {
		process.kill(processId, 0);

		return true;
	} catch {
		return false;
	}
};

const acquireLock = (): boolean => {
	if (existsSync(lockFilePath)) {
		const existingProcessId = Number(readFileSync(lockFilePath, 'utf8'));

		if (existingProcessId !== process.pid && isProcessAlive(existingProcessId)) {
			return false;
		}
	}

	writeFileSync(lockFilePath, String(process.pid));

	return true;
};

const resolveTool = (override: string | null, name: string): string | null => {
	return override ?? Bun.which(name, { PATH: process.env.PATH ?? '' });
};

mkdirSync(dataDirectory, { recursive: true });

if (!acquireLock()) {
	logger.error('service_already_running', { lockFilePath });
	process.exit(1);
}

const settingsStore = createSettingsStore(join(dataDirectory, 'settings.json'));
const store = createStore(new Database(join(dataDirectory, 'bot.sqlite'), { create: true }));
const toolPaths = settingsStore.get().toolPaths;
const claudePath = resolveTool(toolPaths.claude, 'claude');
const ghPath = resolveTool(toolPaths.gh, 'gh');
const gitPath = resolveTool(toolPaths.git, 'git');
const shimDirectory = join(dataDirectory, 'bin');
const baseEnv = { ...process.env };
const token = process.env.PRB_TOKEN ?? randomUUID();

if (ghPath !== null && gitPath !== null) {
	installCommandShims({
		shimDirectory,
		bunPath: process.execPath,
		shimScriptPath: join(import.meta.dir, 'claude', 'command-shim.ts'),
		realGhPath: ghPath,
		realGitPath: gitPath,
	});
}

const bot = createBot({
	store,
	settingsStore,
	github: createGitHubClient({ ghPath: ghPath ?? 'gh', runCommand, logger, env: baseEnv }),
	claude: createClaudeClient({
		claudePath: claudePath ?? 'claude',
		shimDirectory,
		runCommand,
		logger,
		baseEnv,
	}),
	clones: createCloneManager({
		clonesDirectory: join(dataDirectory, 'repos'),
		ghPath: ghPath ?? 'gh',
		gitPath: gitPath ?? 'git',
		runCommand,
		logger,
		env: baseEnv,
	}),
	runReadinessChecks: async () => {
		const facts = await gatherReadinessFacts({
			runCommand,
			claudePath,
			ghPath,
			gitPath,
			env: baseEnv,
		});

		return { readiness: checkReadiness(facts), viewerLogin: facts.ghLogin };
	},
	logger,
	now: Date.now,
});

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch: createApiHandler({ bot, settingsStore, token, logger }),
});

const scheduleTick = (): void => {
	setTimeout(async () => {
		await bot.tick();
		scheduleTick();
	}, settingsStore.get().pollIntervalSeconds * 1000);
};

const shutdown = (reason: string): void => {
	logger.info('service_stopping', { reason });
	killRunningCommands();
	server.stop(true);
	rmSync(lockFilePath, { force: true });
	process.exit(0);
};

const resetCount = store.resetInterruptedReviews(Date.now());

logger.info('service_started', {
	port: server.port,
	dataDirectory,
	claudePath,
	ghPath,
	gitPath,
	resetCount,
	hasProvidedToken: process.env.PRB_TOKEN !== undefined,
});
process.stdout.write(`${JSON.stringify({ event: 'listening', port: server.port })}\n`);

if (!process.stdin.isTTY) {
	process.stdin.on('end', () => shutdown('stdin_closed'));
	process.stdin.resume();
}

process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));

await bot.tick();
scheduleTick();
