import { describe, expect, it } from 'bun:test';
import { createBot } from '../bot/bot.js';
import { createSilentLogger } from '../logging/logger.js';
import type { BotState } from '../bot/state-view.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import { makeDraft } from '../test-support/factories.js';
import { createTestHarness, VIEWER_LOGIN } from '../test-support/fakes.js';
import { createUpdaterHarness } from '../test-support/update-fakes.js';
import { createApiHandler } from './api.js';

const TOKEN = 'test-token';

const setUp = (updaterHarness = createUpdaterHarness()) => {
	const harness = createTestHarness();
	const bot = createBot(harness.dependencies);
	const updater = updaterHarness.create();
	const handle = createApiHandler({
		bot,
		updater,
		settingsStore: harness.dependencies.settingsStore,
		token: TOKEN,
		logger: harness.dependencies.logger,
	});

	const call = (method: string, path: string, body?: unknown, token = TOKEN) => {
		return handle(
			new Request(`http://127.0.0.1${path}`, {
				method,
				headers: { authorization: `Bearer ${token}` },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
	};

	const callRaw = (method: string, path: string, body: string) => {
		return handle(
			new Request(`http://127.0.0.1${path}`, {
				method,
				headers: { authorization: `Bearer ${TOKEN}` },
				body,
			}),
		);
	};

	return { ...harness, bot, updater, updaterHarness, call, callRaw };
};

describe('api', () => {
	it('missing or wrong token → 401', async () => {
		const { call } = setUp();

		expect((await call('GET', '/state', undefined, 'wrong')).status).toBe(401);
	});

	it('GET /state → contract shape', async () => {
		const { call, github, bot } = setUp();

		github.addPullRequest(7);
		await bot.tick();

		const state = (await (await call('GET', '/state')).json()) as BotState;

		expect(Object.keys(state).sort()).toEqual([
			'isPaused',
			'pullRequests',
			'readiness',
			'settings',
			'update',
			'usageLimitedUntil',
			'viewerLogin',
		]);
		expect(state.pullRequests[0]).toMatchObject({
			number: 7,
			status: 'needs_review',
			maxRounds: 5,
			isOwn: false,
			isDraft: false,
			source: 'requested',
		});
	});

	it('PUT /settings valid → saved; invalid → 400 and file unchanged', async () => {
		const { call, dependencies } = setUp();
		const saved = await call('PUT', '/settings', { ...DEFAULT_SETTINGS, reviewMode: 'auto' });

		expect(saved.status).toBe(200);
		expect(dependencies.settingsStore.get().reviewMode).toBe('auto');

		const invalid = await call('PUT', '/settings', { ...DEFAULT_SETTINGS, maxRounds: -1 });

		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: 'invalid_settings' });
		expect(dependencies.settingsStore.get().reviewMode).toBe('auto');
	});

	it('PUT /settings without postReviews → derived from the mode and saved', async () => {
		const { call, dependencies } = setUp();
		const body = Object.fromEntries(
			Object.entries({ ...DEFAULT_SETTINGS, reviewMode: 'auto' }).filter(
				([key]) => key !== 'postReviews',
			),
		);

		expect((await call('PUT', '/settings', body)).status).toBe(200);
		expect(dependencies.settingsStore.get().postReviews).toBe('auto');
	});

	it('actions: unknown PR → 404; approve when not awaiting → 409', async () => {
		const { call, github, bot } = setUp();

		expect((await call('POST', '/prs/999/review')).status).toBe(404);

		github.addPullRequest(7);
		await bot.tick();

		const id = bot.getState().pullRequests[0]?.id;
		const approve = await call('POST', `/prs/${id}/approve`);

		expect(approve.status).toBe(409);
		expect(await approve.json()).toEqual({ error: 'not_awaiting_approval' });
		expect((await call('POST', `/prs/${id}/stop`)).status).toBe(200);
		expect(bot.getState().pullRequests[0]?.status).toBe('stopped');
	});

	it('pause and resume', async () => {
		const { call, bot } = setUp();

		await call('POST', '/pause');
		expect(bot.getState().isPaused).toBe(true);
		await call('POST', '/resume');
		expect(bot.getState().isPaused).toBe(false);
	});
});

describe('draft routes', () => {
	it('GET draft: 404 unknown, 409 no draft; POST post with bad body → 400; discard without draft → 409', async () => {
		const { call, github, bot } = setUp();

		expect((await call('GET', '/prs/999/draft')).status).toBe(404);

		github.addPullRequest(7);
		await bot.tick();

		const id = bot.getState().pullRequests[0]?.id;

		expect((await call('GET', `/prs/${id}/draft`)).status).toBe(409);
		expect((await call('POST', `/prs/${id}/discard`)).status).toBe(409);
		expect((await call('POST', `/prs/${id}/post`, { nonsense: true })).status).toBe(409);
	});
});

describe('draft routes with a held draft', () => {
	it('GET draft → 200 with the draft; invalid post body → 400 invalid_draft; discard → 200', async () => {
		const { call, github, bot, claude } = setUp();

		github.addPullRequest(7);
		await bot.tick();

		const id = bot.getState().pullRequests[0]?.id ?? 0;

		claude.reviewOutcomes.push({ kind: 'result', result: makeDraft({ headRefOid: 'head-1' }) });
		bot.requestReview(id);
		await bot.tick();
		await bot.waitForIdle();

		const draftResponse = await call('GET', `/prs/${id}/draft`);

		expect(draftResponse.status).toBe(200);
		expect(await draftResponse.json()).toMatchObject({ headSha: 'head-1', filing: 'comment' });

		const invalid = await call('POST', `/prs/${id}/post`, {
			headSha: 'head-1',
			event: 'APPROVE',
			mainReview: '',
			comments: [],
			fileComments: [],
		});

		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({
			error: 'invalid_draft',
			reason: 'this draft cannot approve',
		});
		expect((await call('POST', `/prs/${id}/discard`)).status).toBe(200);
	});

	it('POST post with a valid edit → 200 ok', async () => {
		const { call, github, bot, claude } = setUp();

		github.addPullRequest(7);
		await bot.tick();

		const id = bot.getState().pullRequests[0]?.id ?? 0;

		claude.reviewOutcomes.push({ kind: 'result', result: makeDraft({ headRefOid: 'head-1' }) });
		bot.requestReview(id);
		await bot.tick();
		await bot.waitForIdle();

		const response = await call('POST', `/prs/${id}/post`, {
			headSha: 'head-1',
			event: 'COMMENT',
			mainReview: 'Edited',
			comments: [],
			fileComments: [],
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(github.submissions).toHaveLength(1);
	});
});

describe('GET /history', () => {
	it('→ 200 with an entries array', async () => {
		const { call, github, bot } = setUp();

		github.addPullRequest(7);
		await bot.tick();
		bot.stop(bot.getState().pullRequests[0]?.id ?? 0);

		const body = (await (await call('GET', '/history')).json()) as {
			entries: { number: number; outcome: string }[];
		};

		expect(body.entries).toEqual([expect.objectContaining({ number: 7, outcome: 'stopped' })]);
	});
});

describe('api: updates', () => {
	it('GET /state carries the update state', async () => {
		const { call } = setUp();
		const state = (await (await call('GET', '/state')).json()) as { update: unknown };

		expect(state.update).toMatchObject({
			currentVersion: '0.6.0',
			latestVersion: null,
			isUpdateAvailable: false,
			canInstall: true,
			phase: 'idle',
		});
	});

	it('POST /update/check → 202 and the check runs', async () => {
		const { call, updater } = setUp();
		const response = await call('POST', '/update/check');

		expect(response.status).toBe(202);

		await updater.check();

		expect(updater.getState().latestVersion).toBe('0.6.1');
	});

	it('POST /update/install: nothing to install → 409 no_update; available → 202', async () => {
		const { call, updater } = setUp();
		const early = await call('POST', '/update/install');

		expect(early.status).toBe(409);
		expect(await early.json()).toEqual({ error: 'no_update' });

		await updater.check();

		const response = await call('POST', '/update/install');

		expect(response.status).toBe(202);

		await updater.waitForIdle();
	});

	it('POST /update/install in a dev run → 409 cannot_install', async () => {
		const { call } = setUp(
			createUpdaterHarness({
				installLocation: { canInstall: false, reason: 'Updates work only in the installed app' },
			}),
		);
		const response = await call('POST', '/update/install');

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'cannot_install' });
	});
});

describe('api request logging', () => {
	it('routine GET /state polls are not logged; other requests are', async () => {
		const harness = createTestHarness();
		const events: string[] = [];
		const handle = createApiHandler({
			bot: createBot(harness.dependencies),
			updater: createUpdaterHarness().create(),
			settingsStore: harness.dependencies.settingsStore,
			token: TOKEN,
			logger: {
				...createSilentLogger(),
				info: (event, fields) => {
					events.push(`${event} ${fields?.method} ${fields?.path}`);
				},
			},
		});

		const call = (method: string, path: string) => {
			return handle(
				new Request(`http://127.0.0.1${path}`, {
					method,
					headers: { authorization: `Bearer ${TOKEN}` },
				}),
			);
		};

		await call('GET', '/state');
		await call('POST', '/pause');

		expect(events).toEqual(['api_request POST /pause']);
	});
});

describe('POST /prs', () => {
	it('a valid link → 200 with the id; again → isExisting', async () => {
		const { call, github, bot } = setUp();

		await bot.tick();
		bot.setPaused(true);
		github.addPullRequest(7).isRequested = false;

		const first = await call('POST', '/prs', { url: 'https://github.com/acme/api/pull/7' });
		const second = await call('POST', '/prs', { url: 'https://github.com/acme/api/pull/7' });

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ id: expect.any(Number), isExisting: false });
		expect(await second.json()).toMatchObject({ isExisting: true });
	});

	it.each([
		[{ url: 'not a link' }, 400, { error: 'invalid_link' }],
		[{}, 400, { error: 'invalid_link' }],
		[{ url: 'https://gitlab.com/acme/api/pull/7' }, 400, { error: 'unsupported_host' }],
		[{ url: 'https://github.com/acme/api/pull/404' }, 404, { error: 'pr_not_found' }],
	])('%o → %i', async (body, status, expected) => {
		const { call } = setUp();
		const response = await call('POST', '/prs', body);

		expect(response.status).toBe(status);
		expect(await response.json()).toEqual(expected);
	});

	it('while paused → queued, and no review runs', async () => {
		const { call, github, bot, claude } = setUp();

		await bot.tick();
		bot.setPaused(true);
		github.addPullRequest(7).isRequested = false;

		const response = await call('POST', '/prs', { url: 'https://github.com/acme/api/pull/7' });

		await bot.waitForIdle();

		expect(response.status).toBe(200);
		expect(bot.getState().pullRequests[0]?.status).toBe('queued');
		expect(claude.reviewCalls).toHaveLength(0);
	});

	it('a body that is not JSON → 400 invalid_link', async () => {
		const { callRaw } = setUp();
		const response = await callRaw('POST', '/prs', 'not json at all');

		expect([response.status, await response.json()]).toEqual([400, { error: 'invalid_link' }]);
	});

	it('approving your own PR → 409 own_pr', async () => {
		const { call, github, bot } = setUp();

		await bot.tick();
		bot.setPaused(true);
		github.addPullRequest(7, { author: VIEWER_LOGIN }).isRequested = false;

		const added = (await (
			await call('POST', '/prs', { url: 'https://github.com/acme/api/pull/7' })
		).json()) as { id: number };
		const response = await call('POST', `/prs/${added.id}/approve`);

		expect([response.status, await response.json()]).toEqual([409, { error: 'own_pr' }]);
	});

	it('GitHub refuses or is down → 403 no_access / 502 github_unavailable', async () => {
		const { call, github } = setUp();

		github.addPullRequest(7);
		github.failPullRequestFetchesWith.push(403, 500);

		const refused = await call('POST', '/prs', { url: 'https://github.com/acme/api/pull/7' });
		const down = await call('POST', '/prs', { url: 'https://github.com/acme/api/pull/7' });

		expect([refused.status, await refused.json()]).toEqual([403, { error: 'no_access' }]);
		expect([down.status, await down.json()]).toEqual([502, { error: 'github_unavailable' }]);
	});

	it('a merged PR → 409 pr_closed with the reason', async () => {
		const { call, github } = setUp();

		github.addPullRequest(7, { state: 'closed', isMerged: true });

		const response = await call('POST', '/prs', { url: 'https://github.com/acme/api/pull/7' });

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'pr_closed', reason: 'merged' });
	});
});
