import { describe, expect, it } from 'bun:test';
import { createBot } from '../bot/bot.js';
import type { BotState } from '../bot/state-view.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import { makeDraft } from '../test-support/factories.js';
import { createTestHarness } from '../test-support/fakes.js';
import { createApiHandler } from './api.js';

const TOKEN = 'test-token';

const setUp = () => {
	const harness = createTestHarness();
	const bot = createBot(harness.dependencies);
	const handle = createApiHandler({
		bot,
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

	return { ...harness, bot, call };
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
			'usageLimitedUntil',
			'viewerLogin',
		]);
		expect(state.pullRequests[0]).toMatchObject({
			number: 7,
			status: 'needs_review',
			maxRounds: 5,
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
