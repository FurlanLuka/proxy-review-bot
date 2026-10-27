import { describe, expect, it } from 'bun:test';
import type { PullRequestLink } from './pull-request-link.js';
import { parsePullRequestLink } from './pull-request-link.js';

const linkTo = (owner: string, repo: string, number: number): PullRequestLink => ({
	kind: 'link',
	reference: { owner, repo, number },
});

describe('parsePullRequestLink', () => {
	it.each([
		['https://github.com/acme/api/pull/42', linkTo('acme', 'api', 42)],
		['  https://github.com/acme/api/pull/42  ', linkTo('acme', 'api', 42)],
		['http://www.github.com/acme/api/pull/42', linkTo('acme', 'api', 42)],
		['github.com/acme/api/pull/42', linkTo('acme', 'api', 42)],
		['https://github.com/acme/api/pull/42/files', linkTo('acme', 'api', 42)],
		['https://github.com/acme/api/pull/42/commits/abc123', linkTo('acme', 'api', 42)],
		['https://github.com/acme/api/pull/42?w=1#discussion_r1', linkTo('acme', 'api', 42)],
		['https://github.com/Acme-Co/my.repo_2/pull/7', linkTo('Acme-Co', 'my.repo_2', 7)],
	])('%s → the PR', (text, expected) => {
		expect(parsePullRequestLink(text)).toEqual(expected);
	});

	it.each([
		'',
		'not a link',
		'nope',
		'pull/42',
		'https://github.com/acme/api/pulls/42',
		'https://github.com/acme/api/issues/42',
		'https://github.com/acme/api',
		'https://github.com/acme/api/pull/0',
		'https://github.com/acme/api/pull/-1',
		'https://github.com/acme/api/pull/4.2',
		'https://github.com/acme/api/pull/99999999999999999999',
		'https://github.com/acme/../pull/1',
		'https://github.com/acme/./pull/1',
		'https://github.com/ac_me/api/pull/1',
		'ftp://github.com/acme/api/pull/1',
	])('%p → invalid_link', (text) => {
		expect(parsePullRequestLink(text)).toEqual({ kind: 'invalid_link' });
	});

	it.each([
		'https://gitlab.com/acme/api/pull/1',
		'https://github.example.com/acme/api/pull/1',
		'https://api.github.com/repos/acme/api/pulls/1',
	])('%s → unsupported_host', (text) => {
		expect(parsePullRequestLink(text)).toEqual({ kind: 'unsupported_host' });
	});
});
