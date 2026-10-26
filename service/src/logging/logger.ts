import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

type LogFields = Record<string, unknown>;

type LogLevel = 'info' | 'warn' | 'error';

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface Logger {
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
	child(fields: LogFields): Logger;
}

interface LogFile {
	append(line: string): void;
}

interface OpenLogFileParams {
	filePath: string;
	maxFileBytes: number;
}

const openLogFile = ({ filePath, maxFileBytes }: OpenLogFileParams): LogFile => {
	mkdirSync(dirname(filePath), { recursive: true });

	const size = { bytes: existsSync(filePath) ? statSync(filePath).size : 0 };

	const rotate = (): void => {
		try {
			renameSync(filePath, `${filePath}.1`);
		} catch (error) {
			process.stderr.write(`Log rotation failed: ${String(error)}\n`);
		}

		size.bytes = 0;
	};

	return {
		append: (line) => {
			const lineBytes = Buffer.byteLength(line);

			if (size.bytes > 0 && size.bytes + lineBytes > maxFileBytes) {
				rotate();
			}

			appendFileSync(filePath, line);
			size.bytes += lineBytes;
		},
	};
};

const serializeError = (value: unknown): unknown => {
	return value instanceof Error
		? { name: value.name, message: value.message, stack: value.stack }
		: value;
};

interface BuildLoggerParams {
	logFile: LogFile | null;
	baseFields: LogFields;
	shouldEcho: boolean;
}

const buildLogger = ({ logFile, baseFields, shouldEcho }: BuildLoggerParams): Logger => {
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

		logFile?.append(line);

		if (shouldEcho) {
			process.stderr.write(line);
		}
	};

	return {
		info: (event, fields) => write('info', event, fields),
		warn: (event, fields) => write('warn', event, fields),
		error: (event, fields) => write('error', event, fields),
		child: (fields) =>
			buildLogger({ logFile, baseFields: { ...baseFields, ...fields }, shouldEcho }),
	};
};

interface CreateLoggerParams {
	filePath: string | null;
	baseFields?: LogFields;
	shouldEcho?: boolean;
	maxFileBytes?: number;
}

export const createLogger = ({
	filePath,
	baseFields = {},
	shouldEcho = true,
	maxFileBytes = DEFAULT_MAX_FILE_BYTES,
}: CreateLoggerParams): Logger => {
	const logFile = filePath === null ? null : openLogFile({ filePath, maxFileBytes });

	return buildLogger({ logFile, baseFields, shouldEcho });
};

export const createSilentLogger = (): Logger => {
	return createLogger({ filePath: null, shouldEcho: false });
};
