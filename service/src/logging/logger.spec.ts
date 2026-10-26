import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const readLines = (path: string): string[] => {
	return readFileSync(path, 'utf8').trim().split('\n');
};

describe('createLogger file rotation', () => {
	it('over the size limit → the log moves to .1 and a fresh file starts; children share the limit', () => {
		const filePath = join(mkdtempSync(join(tmpdir(), 'prb-log-')), 'service.log');
		const logger = createLogger({ filePath, shouldEcho: false, maxFileBytes: 300 });
		const child = logger.child({ jobPullRequestId: 7 });

		for (const index of [1, 2, 3, 4]) {
			logger.info('parent_event', { index });
			child.info('child_event', { index });
		}

		const current = readLines(filePath);
		const rotated = readLines(`${filePath}.1`);

		expect(current.length).toBeGreaterThan(0);
		expect(rotated.length).toBeGreaterThan(0);
		expect(current.length + rotated.length).toBeLessThanOrEqual(8);
		expect(readFileSync(filePath, 'utf8').length).toBeLessThanOrEqual(300);
		expect(JSON.parse(current.at(-1) ?? '{}')).toMatchObject({ event: 'child_event', index: 4 });
	});

	it('one rotation → .1 then the current file hold every line once, in order', () => {
		const filePath = join(mkdtempSync(join(tmpdir(), 'prb-log-')), 'service.log');
		const logger = createLogger({ filePath, shouldEcho: false, maxFileBytes: 600 });
		const indexes = [1, 2, 3, 4, 5, 6, 7, 8];

		for (const index of indexes) {
			logger.info('ordered_event', { index });
		}

		const lines = [...readLines(`${filePath}.1`), ...readLines(filePath)];

		expect(lines.map((line) => JSON.parse(line).index)).toEqual(indexes);
	});

	it('an existing large log is rotated on the first write; the previous .1 is replaced', () => {
		const directory = mkdtempSync(join(tmpdir(), 'prb-log-'));
		const filePath = join(directory, 'service.log');

		writeFileSync(filePath, 'x'.repeat(400));
		writeFileSync(`${filePath}.1`, 'old');

		createLogger({ filePath, shouldEcho: false, maxFileBytes: 300 }).info('started');

		expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('x'.repeat(400));
		expect(readLines(filePath)).toHaveLength(1);
	});

	it('under the limit → nothing rotates', () => {
		const filePath = join(mkdtempSync(join(tmpdir(), 'prb-log-')), 'service.log');

		createLogger({ filePath, shouldEcho: false }).info('started');

		expect(existsSync(`${filePath}.1`)).toBe(false);
	});
});
