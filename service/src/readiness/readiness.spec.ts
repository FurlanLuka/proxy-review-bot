import { describe, expect, it } from 'bun:test';
import { checkReadiness } from './readiness.js';
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
