import type { RunCommand } from '../commands/run-command.js';
import type { Logger } from '../logging/logger.js';
import {
	parsePullRequest,
	parseReviewPages,
	parseReviewThreads,
	parseSearchResults,
} from './github-parsers.js';
import { GitHubRequestError } from './github-types.js';
import type { GitHubClient, PullRequestReference } from './github-types.js';

const SEARCH_QUERY = 'is:pr is:open draft:false user-review-requested:@me';

const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
	repository(owner:$owner,name:$repo){pullRequest(number:$number){
		reviewThreads(first:100){nodes{id isResolved path line
			comments(first:50){nodes{databaseId body createdAt author{login __typename}}}}}}}}`;

interface CreateGitHubClientParams {
	ghPath: string;
	runCommand: RunCommand;
	logger: Logger;
	env: Record<string, string | undefined>;
}

const parseHttpStatus = (stderr: string): number | null => {
	const match = /HTTP (\d{3})/.exec(stderr);

	return match?.[1] === undefined ? null : Number(match[1]);
};

export const createGitHubClient = ({
	ghPath,
	runCommand,
	logger,
	env,
}: CreateGitHubClientParams): GitHubClient => {
	const runGh = async (args: string[], input?: string): Promise<string> => {
		const result = await runCommand({ command: ghPath, args, input, env, timeoutMs: 60_000 });

		logger.info('gh_call', {
			args: args.slice(0, 4),
			exitCode: result.exitCode,
			durationMs: result.durationMs,
		});

		if (result.exitCode !== 0) {
			throw new GitHubRequestError(
				`gh ${args[0]} ${args[1] ?? ''} failed: ${result.stderr.trim()}`,
				parseHttpStatus(result.stderr),
			);
		}

		return result.stdout;
	};

	const runGhJson = async (args: string[], input?: string): Promise<unknown> => {
		return JSON.parse(await runGh(args, input));
	};

	const pullRequestPath = ({ owner, repo, number }: PullRequestReference): string => {
		return `repos/${owner}/${repo}/pulls/${number}`;
	};

	return {
		searchRequestedPullRequests: async () => {
			const json = await runGhJson([
				'api',
				'-X',
				'GET',
				'search/issues',
				'-f',
				`q=${SEARCH_QUERY}`,
				'-f',
				'per_page=100',
			]);

			return parseSearchResults(json);
		},
		getPullRequest: async (reference) => {
			const json = await runGhJson(['api', pullRequestPath(reference)]);

			return parsePullRequest({ json, owner: reference.owner, repo: reference.repo });
		},
		listReviews: async (reference) => {
			const json = await runGhJson([
				'api',
				'--paginate',
				'--slurp',
				`${pullRequestPath(reference)}/reviews`,
			]);

			return parseReviewPages(json);
		},
		listReviewThreads: async (reference) => {
			const json = await runGhJson([
				'api',
				'graphql',
				'-f',
				`owner=${reference.owner}`,
				'-f',
				`repo=${reference.repo}`,
				'-F',
				`number=${reference.number}`,
				'-f',
				`query=${REVIEW_THREADS_QUERY}`,
			]);

			return parseReviewThreads(json);
		},
		submitReview: async (reference, submission) => {
			const payload = {
				commit_id: submission.commitId,
				event: submission.event,
				body: submission.body,
				comments: submission.comments,
			};

			await runGh(
				['api', '-X', 'POST', `${pullRequestPath(reference)}/reviews`, '--input', '-'],
				JSON.stringify(payload),
			);
		},
		postFileComment: async (reference, submission) => {
			const payload = {
				commit_id: submission.commitId,
				path: submission.path,
				body: submission.body,
				subject_type: 'file',
			};

			await runGh(
				['api', '-X', 'POST', `${pullRequestPath(reference)}/comments`, '--input', '-'],
				JSON.stringify(payload),
			);
		},
		replyToComment: async (reference, commentId, body) => {
			await runGh(
				[
					'api',
					'-X',
					'POST',
					`${pullRequestPath(reference)}/comments/${commentId}/replies`,
					'--input',
					'-',
				],
				JSON.stringify({ body }),
			);
		},
	};
};
