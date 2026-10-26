import { describe, expect, it } from 'bun:test';
import { createSilentLogger } from '../logging/logger.js';
import { checkReadiness, gatherReadinessFacts } from './readiness.js';
import type { ReadinessFacts } from './readiness.js';

const READY_FACTS: ReadinessFacts = {
	claudePath: '/bin/claude',
	ghPath: '/bin/gh',
	gitPath: '/bin/git',
	claudeAuth: { isLoggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
	proxyPlugin: { isInstalled: true, version: '1.6.1', hasPullRequestReviewSkill: true },
	ghLogin: 'luka',
};

const failingFixes = (facts: ReadinessFacts): (string | null)[] => {
	return checkReadiness(facts)
		.checks.filter((check) => !check.isOk)
		.map((check) => check.fix);
};

describe('checkReadiness', () => {
	it('everything OK → ready', () => {
		const readiness = checkReadiness(READY_FACTS);

		expect(readiness.status).toBe('ready');
		expect(readiness.checks.find((check) => check.name === 'claude_logged_in')?.label).toBe(
			'Claude logged in (max)',
		);
	});

	it('logged out → setup_needed with the login fix', () => {
		const facts = {
			...READY_FACTS,
			claudeAuth: { isLoggedIn: false, authMethod: null, subscriptionType: null },
		};

		expect(checkReadiness(facts).status).toBe('setup_needed');
		expect(failingFixes(facts)).toEqual(['claude auth login']);
	});

	it('API key auth → setup_needed (would bill the API, not the subscription)', () => {
		const facts = {
			...READY_FACTS,
			claudeAuth: { isLoggedIn: true, authMethod: 'api_key', subscriptionType: null },
		};

		expect(checkReadiness(facts).checks.find((check) => !check.isOk)?.label).toBe(
			'Claude is using an API key, not your subscription',
		);
	});

	it('proxy missing, or skill file missing → plugin update fix', () => {
		const missingPlugin = {
			...READY_FACTS,
			proxyPlugin: { isInstalled: false, version: null, hasPullRequestReviewSkill: false },
		};
		const missingSkill = {
			...READY_FACTS,
			proxyPlugin: { isInstalled: true, version: '1.3.2', hasPullRequestReviewSkill: false },
		};

		expect(failingFixes(missingPlugin)).toEqual(['claude plugin update proxy@proxy-marketplace']);
		expect(failingFixes(missingSkill)).toEqual(['claude plugin update proxy@proxy-marketplace']);
	});

	it('several problems → all listed', () => {
		const facts = {
			...READY_FACTS,
			claudePath: null,
			ghLogin: null,
			claudeAuth: { isLoggedIn: false, authMethod: null, subscriptionType: null },
		};

		expect(checkReadiness(facts).checks.filter((check) => !check.isOk)).toHaveLength(3);
	});
});

describe('gatherReadinessFacts with broken tool paths', () => {
	it('missing or non-executable paths → reported as missing, never thrown', async () => {
		const facts = await gatherReadinessFacts({
			runCommand: async () => {
				throw new Error('should not spawn a missing tool');
			},
			claudePath: '/nonexistent/claude',
			ghPath: '/etc/hosts',
			gitPath: null,
			env: {},
			logger: createSilentLogger(),
		});

		expect(facts).toMatchObject({ claudePath: null, ghPath: null, gitPath: null, ghLogin: null });
		expect(checkReadiness(facts).status).toBe('setup_needed');
	});

	it('a tool that fails to run → that check fails and is logged, the rest still gathered', async () => {
		const warnings: unknown[] = [];
		const facts = await gatherReadinessFacts({
			runCommand: async ({ args }) => {
				if (args[0] === 'auth') {
					throw new Error('spawn failed');
				}

				return {
					exitCode: 0,
					stdout: args[0] === 'api' ? 'luka\n' : '[]',
					stderr: '',
					isTimedOut: false,
					durationMs: 1,
				};
			},
			claudePath: '/bin/sh',
			ghPath: '/bin/sh',
			gitPath: '/bin/sh',
			env: {},
			logger: {
				...createSilentLogger(),
				warn: (event, fields) => {
					warnings.push({ event, check: fields?.check });
				},
			},
		});

		expect(facts.claudeAuth.isLoggedIn).toBe(false);
		expect(facts.ghLogin).toBe('luka');
		expect(warnings).toEqual([{ event: 'readiness_check_failed', check: 'claude_auth' }]);
	});
});
