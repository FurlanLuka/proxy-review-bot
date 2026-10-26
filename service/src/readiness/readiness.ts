import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCommand } from '../commands/run-command.js';

export interface ReadinessFacts {
	claudePath: string | null;
	ghPath: string | null;
	gitPath: string | null;
	claudeAuth: { isLoggedIn: boolean; authMethod: string | null; subscriptionType: string | null };
	proxyPlugin: { isInstalled: boolean; version: string | null; hasPullRequestReviewSkill: boolean };
	ghLogin: string | null;
}

export interface ReadinessCheck {
	name: string;
	isOk: boolean;
	label: string;
	fix: string | null;
}

export interface Readiness {
	status: 'ready' | 'setup_needed' | 'checking';
	checks: ReadinessCheck[];
}

const SUBSCRIPTION_AUTH_METHOD = 'claude.ai';

export const checkReadiness = (facts: ReadinessFacts): Readiness => {
	const isClaudeLoggedIn =
		facts.claudeAuth.isLoggedIn && facts.claudeAuth.authMethod === SUBSCRIPTION_AUTH_METHOD;
	const isProxyReady = facts.proxyPlugin.isInstalled && facts.proxyPlugin.hasPullRequestReviewSkill;
	const checks: ReadinessCheck[] = [
		{
			name: 'claude_installed',
			isOk: facts.claudePath !== null,
			label: facts.claudePath === null ? 'Claude Code not found' : 'Claude Code found',
			fix: facts.claudePath === null ? 'Install Claude Code or set its path in Settings' : null,
		},
		{
			name: 'claude_logged_in',
			isOk: isClaudeLoggedIn,
			label: isClaudeLoggedIn
				? `Claude logged in (${facts.claudeAuth.subscriptionType ?? 'subscription'})`
				: facts.claudeAuth.isLoggedIn
					? 'Claude is using an API key, not your subscription'
					: "Claude isn't logged in",
			fix: isClaudeLoggedIn ? null : 'claude auth login',
		},
		{
			name: 'proxy_pr_review',
			isOk: isProxyReady,
			label: isProxyReady
				? `proxy ${facts.proxyPlugin.version ?? ''} with pr-review`.replace('  ', ' ')
				: 'proxy pr-review skill not found',
			fix: isProxyReady ? null : 'claude plugin update proxy@proxy-marketplace',
		},
		{
			name: 'gh_logged_in',
			isOk: facts.ghLogin !== null,
			label: facts.ghLogin === null ? "gh isn't logged in" : `gh logged in as ${facts.ghLogin}`,
			fix: facts.ghLogin === null ? 'gh auth login' : null,
		},
		{
			name: 'git_installed',
			isOk: facts.gitPath !== null,
			label: facts.gitPath === null ? 'git not found' : 'git found',
			fix: facts.gitPath === null ? 'xcode-select --install' : null,
		},
	];

	return { status: checks.every((check) => check.isOk) ? 'ready' : 'setup_needed', checks };
};

interface GatherReadinessFactsParams {
	runCommand: RunCommand;
	claudePath: string | null;
	ghPath: string | null;
	gitPath: string | null;
	env: Record<string, string | undefined>;
}

const readJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

interface PluginEntry {
	id?: string;
	scope?: string;
	enabled?: boolean;
	version?: string;
	installPath?: string;
}

const gatherClaudeAuth = async (
	params: GatherReadinessFactsParams,
): Promise<ReadinessFacts['claudeAuth']> => {
	const loggedOut = { isLoggedIn: false, authMethod: null, subscriptionType: null };

	if (params.claudePath === null) {
		return loggedOut;
	}

	const result = await params.runCommand({
		command: params.claudePath,
		args: ['auth', 'status', '--json'],
		env: params.env,
		timeoutMs: 30_000,
	});
	const status = readJson(result.stdout) as {
		loggedIn?: boolean;
		authMethod?: string;
		subscriptionType?: string;
	} | null;

	return status === null
		? loggedOut
		: {
				isLoggedIn: status.loggedIn === true,
				authMethod: status.authMethod ?? null,
				subscriptionType: status.subscriptionType ?? null,
			};
};

const gatherProxyPlugin = async (
	params: GatherReadinessFactsParams,
): Promise<ReadinessFacts['proxyPlugin']> => {
	const missing = { isInstalled: false, version: null, hasPullRequestReviewSkill: false };

	if (params.claudePath === null) {
		return missing;
	}

	const result = await params.runCommand({
		command: params.claudePath,
		args: ['plugin', 'list', '--json'],
		env: params.env,
		timeoutMs: 30_000,
	});
	const plugins = readJson(result.stdout);
	const proxyPlugin = Array.isArray(plugins)
		? (plugins as PluginEntry[]).find(
				(plugin) =>
					plugin.id === 'proxy@proxy-marketplace' && plugin.scope === 'user' && plugin.enabled,
			)
		: undefined;

	if (proxyPlugin === undefined) {
		return missing;
	}

	return {
		isInstalled: true,
		version: proxyPlugin.version ?? null,
		hasPullRequestReviewSkill:
			proxyPlugin.installPath !== undefined &&
			existsSync(join(proxyPlugin.installPath, 'skills', 'pr-review', 'SKILL.md')),
	};
};

const gatherGhLogin = async (params: GatherReadinessFactsParams): Promise<string | null> => {
	if (params.ghPath === null) {
		return null;
	}

	const result = await params.runCommand({
		command: params.ghPath,
		args: ['api', 'user', '--jq', '.login'],
		env: params.env,
		timeoutMs: 30_000,
	});
	const login = result.stdout.trim();

	return result.exitCode === 0 && login.length > 0 ? login : null;
};

export const gatherReadinessFacts = async (
	params: GatherReadinessFactsParams,
): Promise<ReadinessFacts> => {
	const [claudeAuth, proxyPlugin, ghLogin] = await Promise.all([
		gatherClaudeAuth(params),
		gatherProxyPlugin(params),
		gatherGhLogin(params),
	]);

	return {
		claudePath: params.claudePath,
		ghPath: params.ghPath,
		gitPath: params.gitPath,
		claudeAuth,
		proxyPlugin,
		ghLogin,
	};
};
