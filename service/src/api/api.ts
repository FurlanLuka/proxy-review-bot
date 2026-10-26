import type { Bot } from '../bot/bot.js';
import type { Logger } from '../logging/logger.js';
import type { SettingsStore } from '../settings/settings.js';

interface CreateApiHandlerParams {
	bot: Bot;
	settingsStore: SettingsStore;
	token: string;
	logger: Logger;
}

const PULL_REQUEST_ACTION_PATTERN = /^\/prs\/(\d+)\/(review|approve|stop|retry|post|discard)$/;
const DRAFT_PATTERN = /^\/prs\/(\d+)\/draft$/;

const json = (body: unknown, status = 200): Response => {
	return Response.json(body, { status });
};

const actionResponse = (outcome: string | { result: string; reason?: string }): Response => {
	const result = typeof outcome === 'string' ? outcome : outcome.result;

	if (result === 'invalid_draft') {
		const reason = typeof outcome === 'string' ? undefined : outcome.reason;

		return json({ error: result, ...(reason !== undefined && { reason }) }, 400);
	}

	return result === 'ok'
		? json({ ok: true })
		: result === 'not_found'
			? json({ error: 'not_found' }, 404)
			: json({ error: result }, 409);
};

export const createApiHandler = ({ bot, settingsStore, token, logger }: CreateApiHandlerParams) => {
	const route = async (request: Request, path: string): Promise<Response> => {
		const method = request.method;

		if (method === 'GET' && path === '/state') {
			return json(bot.getState());
		}

		const draftMatch = DRAFT_PATTERN.exec(path);

		if (method === 'GET' && draftMatch !== null) {
			const draft = bot.getDraft(Number(draftMatch[1]));

			return draft === 'not_found'
				? json({ error: 'not_found' }, 404)
				: draft === 'no_draft'
					? json({ error: 'no_draft' }, 409)
					: json(draft);
		}

		if (method === 'GET' && path === '/settings') {
			return json(settingsStore.get());
		}

		if (method === 'PUT' && path === '/settings') {
			const candidate = await request.json().catch(() => null);
			const saved = settingsStore.replace(candidate);

			return saved === null ? json({ error: 'invalid_settings' }, 400) : json(saved);
		}

		if (method !== 'POST') {
			return json({ error: 'not_found' }, 404);
		}

		if (path === '/pause' || path === '/resume') {
			bot.setPaused(path === '/pause');

			return json({ ok: true });
		}

		if (path === '/readiness/check') {
			await bot.recheckReadiness();

			return json({ ok: true });
		}

		const match = PULL_REQUEST_ACTION_PATTERN.exec(path);

		if (match === null) {
			return json({ error: 'not_found' }, 404);
		}

		const id = Number(match[1]);
		const actions = {
			review: async () => bot.requestReview(id),
			stop: async () => bot.stop(id),
			retry: async () => bot.retry(id),
			approve: () => bot.approve(id),
			post: async () => bot.postDraft(id, await request.json().catch(() => null)),
			discard: async () => bot.discardDraft(id),
		};
		const result = await actions[match[2] as keyof typeof actions]();

		return actionResponse(result);
	};

	return async (request: Request): Promise<Response> => {
		const path = new URL(request.url).pathname;

		if (request.headers.get('authorization') !== `Bearer ${token}`) {
			logger.warn('api_unauthorized', { path });

			return json({ error: 'unauthorized' }, 401);
		}

		try {
			const response = await route(request, path);

			logger.info('api_request', { method: request.method, path, status: response.status });

			return response;
		} catch (error) {
			logger.error('api_request_failed', { method: request.method, path, error });

			return json({ error: 'internal_error' }, 500);
		}
	};
};
