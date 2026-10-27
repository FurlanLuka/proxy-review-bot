import type { PullRequestReference } from './github-types.js';

export type PullRequestLink =
	| { kind: 'link'; reference: PullRequestReference }
	| { kind: 'invalid_link' }
	| { kind: 'unsupported_host' };

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const OWNER_PATTERN = /^[A-Za-z0-9-]+$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;
const NUMBER_PATTERN = /^\d+$/;
const INVALID_LINK: PullRequestLink = { kind: 'invalid_link' };

const parseUrl = (text: string): URL | null => {
	const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;

	try {
		return new URL(withScheme);
	} catch {
		return null;
	}
};

const isRepoName = (repo: string): boolean => {
	return REPO_PATTERN.test(repo) && repo !== '.' && repo !== '..';
};

export const parsePullRequestLink = (text: string): PullRequestLink => {
	const url = parseUrl(text.trim());

	if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
		return INVALID_LINK;
	}

	if (!url.hostname.includes('.')) {
		return INVALID_LINK;
	}

	if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
		return { kind: 'unsupported_host' };
	}

	const [owner = '', repo = '', kind = '', numberText = ''] = url.pathname.split('/').slice(1);
	const number = Number(numberText);

	if (
		!OWNER_PATTERN.test(owner) ||
		!isRepoName(repo) ||
		kind !== 'pull' ||
		!NUMBER_PATTERN.test(numberText) ||
		!Number.isSafeInteger(number) ||
		number < 1
	) {
		return INVALID_LINK;
	}

	return { kind: 'link', reference: { owner, repo, number } };
};
