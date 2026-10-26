import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type LogFields = Record<string, unknown>;

type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
	child(fields: LogFields): Logger;
}

interface CreateLoggerParams {
	filePath: string | null;
	baseFields?: LogFields;
	shouldEcho?: boolean;
}

const serializeError = (value: unknown): unknown => {
	return value instanceof Error
		? { name: value.name, message: value.message, stack: value.stack }
		: value;
};

export const createLogger = ({
	filePath,
	baseFields = {},
	shouldEcho = true,
}: CreateLoggerParams): Logger => {
	if (filePath !== null) {
		mkdirSync(dirname(filePath), { recursive: true });
	}

	const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
		const entry = {
			emitted_at_ms: Date.now(),
			level,
			event,
			...baseFields,
			...Object.fromEntries(
				Object.entries(fields).map(([key, value]) => [key, serializeError(value)]),
			),
		};
		const line = `${JSON.stringify(entry)}\n`;

		if (filePath !== null) {
			appendFileSync(filePath, line);
		}

		if (shouldEcho) {
			process.stderr.write(line);
		}
	};

	return {
		info: (event, fields) => write('info', event, fields),
		warn: (event, fields) => write('warn', event, fields),
		error: (event, fields) => write('error', event, fields),
		child: (fields) =>
			createLogger({ filePath, baseFields: { ...baseFields, ...fields }, shouldEcho }),
	};
};

export const createSilentLogger = (): Logger => {
	return createLogger({ filePath: null, shouldEcho: false });
};
