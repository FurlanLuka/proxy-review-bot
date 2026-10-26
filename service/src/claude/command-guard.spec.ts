import { describe, expect, it } from 'bun:test';
import { buildClaudeArgs, buildClaudeEnv } from './claude-args.js';
import {
	hasDangerousGitEnvironment,
	isGhWriteCommand,
	isGitWriteCommand,
} from './command-guard.js';

const split = (command: string): string[] => command.split(' ');

describe('isGhWriteCommand', () => {
	it.each([
		'api repos/a/b/pulls/1',
		'api -X GET search/issues -f q=x',
		'api --method=GET repos/a/b',
		'api graphql -f query=query{viewer{login}}',
		'pr view 1 --json title',
		'pr diff 1',
		'search prs --review-requested=@me',
		'auth status',
		'repo view a/b',
	])('read: gh %s → allowed', (command) => {
		expect(isGhWriteCommand(split(command))).toBe(false);
	});

	it.each([
		'api -X POST repos/a/b/pulls/1/reviews --input -',
		'api -XPOST repos/a/b/pulls/1/reviews',
		'api --method PATCH repos/a/b/pulls/1',
		'api repos/a/b/issues/1/comments -f body=hi',
		'api repos/a/b/pulls/1/reviews --input review.json',
		'api graphql -f query=mutation{resolveReviewThread}',
		'api graphql --input query.json',
		'pr review 1 --approve',
		'pr comment 1 -b hi',
		'pr merge 1',
		'pr close 1',
		'pr edit 1',
		'issue comment 1',
		'auth login',
		'repo delete a/b',
		'api repos/a/b/issues/1/comments --field=body=hi',
		'api repos/a/b/issues/1/comments -fbody=hi',
		'api repos/a/b/issues/1/comments --raw-field=body=hi',
		'api graphql -F query=@mutation.graphql',
		'api graphql --input=q.json',
		'api -X GET repos/a/b --input body.json',
		'api /graphql -X GET -f query=mutation{x}',
	])('write: gh %s → blocked', (command) => {
		expect(isGhWriteCommand(split(command))).toBe(true);
	});
});

describe('isGitWriteCommand', () => {
	it.each([
		'-C /clone show abc:src/a.ts',
		'-C /clone fetch origin refs/pull/1/head',
		'-C /clone diff a...b',
		'-C /clone merge-tree --write-tree a b',
		'-C /clone remote -v',
		'-C /clone config --get remote.origin.url',
		'-C /clone log --format=%H -1',
		'-C /clone grep -n retry',
		'--no-pager -C /clone log --oneline',
		'--version',
		'--help',
	])('read: git %s → allowed', (command) => {
		expect(isGitWriteCommand(split(command))).toBe(false);
	});

	it.each([
		'-C /clone push origin main',
		'push',
		'-c credential.helper= -C /clone push',
		'-C /clone remote set-url origin x',
		'-C /clone config user.name x',
		'--no-pager push',
		'-P push',
		'--git-dir /x push',
		'--work-tree /x push',
		'-C /clone checkout main',
		'-C /clone switch other',
		'-C /clone reset --hard',
		'-C /clone stash',
		'-C /clone commit -m x',
		'-C /clone clean -fd',
		'-C /clone worktree add /tmp/x',
		'-c core.fsmonitor=/opt/homebrew/bin/gh -C /clone status',
		'-c diff.external=/x/sh -C /clone diff a b',
		'-c core.sshCommand=x -C /clone fetch',
		'-c protocol.ext.allow=always -C /clone fetch ext::sh',
		'-C /clone fetch ext::sh-c-x',
		'-c alias.x=!cmd x',
		'--config-env=core.pager=X -C /clone log',
		'--exec-path=/x -C /clone log',
		'-C /clone fetch --upload-pack=cmd /path',
		'-C /clone fetch --upload-pack cmd /path',
		'-C /clone grep -O cmd x',
		'-C /clone grep --open-files-in-pager=cmd x',
		'-C /clone log -1 --output=/Users/x/.gitconfig',
		'-C /clone diff a b --output /tmp/x',
		'-C /clone show HEAD --output=/tmp/x',
		'-C /clone diff --ext-diff a b',
		'--namespace x -C /clone log',
		'-ccore.pager=x log',
		'--version --exec-path=/x',
	])('write: git %s → blocked', (command) => {
		expect(isGitWriteCommand(split(command))).toBe(true);
	});
});

describe('buildClaudeArgs', () => {
	const reviewArgs = buildClaudeArgs({
		kind: 'review',
		prompt: '/proxy:pr-review https://github.com/a/b/pull/1',
		systemPrompt: 'contract',
		jsonSchema: { type: 'object' },
	});

	const valueAfter = (args: string[], flag: string): string | undefined => {
		return args[args.indexOf(flag) + 1];
	};

	it('runs headless with JSON output, the schema and no session persistence', () => {
		expect(reviewArgs[0]).toBe('-p');
		expect(valueAfter(reviewArgs, '--output-format')).toBe('stream-json');
		expect(reviewArgs).toContain('--verbose');
		expect(valueAfter(reviewArgs, '--json-schema')).toBe('{"type":"object"}');
		expect(reviewArgs).toContain('--no-session-persistence');
	});

	it('loads only user settings so PR-author hooks never run', () => {
		expect(valueAfter(reviewArgs, '--setting-sources')).toBe('user');
	});

	it('review tools are exactly the read tools plus subagents and skills', () => {
		expect(valueAfter(reviewArgs, '--allowedTools')).toBe(
			'Read,Grep,Glob,Bash(git:*),Bash(gh:*),Task,Agent,Skill',
		);
	});

	it('review tools allow subagents and skills but no write tools', () => {
		const allowed = valueAfter(reviewArgs, '--allowedTools') ?? '';
		const disallowed = valueAfter(reviewArgs, '--disallowedTools') ?? '';

		expect(allowed).toContain('Skill');
		expect(allowed).toContain('Task');
		expect(allowed).not.toContain('Edit');
		expect(allowed).not.toContain('Write');
		expect(disallowed).toContain('Edit');
		expect(disallowed).toContain('Write');
	});

	it('reply tools are read-only, without subagents or skills', () => {
		const replyArgs = buildClaudeArgs({
			kind: 'reply',
			prompt: 'thread',
			systemPrompt: 'contract',
			jsonSchema: {},
		});
		const allowed = valueAfter(replyArgs, '--allowedTools') ?? '';

		expect(allowed).not.toContain('Skill');
		expect(allowed).not.toContain('Task');
	});
});

describe('buildClaudeEnv', () => {
	it('strips ANTHROPIC_API_KEY and puts the shims first on PATH', () => {
		const environment = buildClaudeEnv({
			baseEnv: {
				ANTHROPIC_API_KEY: 'secret',
				PATH: '/usr/bin',
				HOME: '/Users/x',
				GIT_PAGER: 'delta',
				GIT_SSH_COMMAND: 'ssh -i key',
				GIT_EDITOR: 'vim',
			},
			shimDirectory: '/shims',
		});

		expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
		expect(hasDangerousGitEnvironment(environment)).toBe(false);
		expect(environment.PATH).toBe('/shims:/usr/bin');
		expect(environment.HOME).toBe('/Users/x');
		expect(environment.GIT_EDITOR).toBe('vim');
	});
});

describe('hasDangerousGitEnvironment', () => {
	it.each([
		'GIT_CONFIG_PARAMETERS',
		'GIT_CONFIG_COUNT',
		'GIT_EXTERNAL_DIFF',
		'GIT_SSH_COMMAND',
		'GIT_PAGER',
		'GIT_DIR',
		'GIT_TRACE',
		'GIT_TRACE_PACKET',
	])('%s set → dangerous', (name) => {
		expect(hasDangerousGitEnvironment({ PATH: '/bin', [name]: 'x' })).toBe(true);
	});

	it('ordinary environment → fine', () => {
		expect(
			hasDangerousGitEnvironment({ PATH: '/bin', HOME: '/Users/x', GIT_TERMINAL_PROMPT: '0' }),
		).toBe(false);
	});
});
