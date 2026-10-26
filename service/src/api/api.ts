import type { Bot } from '../bot/bot.js';
import type { Logger } from '../logging/logger.js';
import type { SettingsStore } from '../settings/settings.js';

interface CreateApiHandlerParams {
	bot: Bot;
	settingsStore: SettingsStore;
	token: string;
	logger: Logger;
}

const PULL_REQUEST_ACTION_PATTERN = /^\/prs\/(\d+)\/(review|approve|stop|retry)$/;

const json = (body: unknown, status = 200): Response => {
	return Response.json(body, { status });
};

const actionResponse = (result: string): Response => {
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
