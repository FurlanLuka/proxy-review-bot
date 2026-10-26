import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCommandShims } from './claude-client.js';

const setUpShims = () => {
	const directory = mkdtempSync(join(tmpdir(), 'proxy-review-bot-shim-'));
	const callLog = join(directory, 'calls.log');
	const fakeRealTool = join(directory, 'real-tool');

	writeFileSync(fakeRealTool, `#!/bin/sh\necho "$@" >> "${callLog}"\nexit 7\n`);
	chmodSync(fakeRealTool, 0o755);
	installCommandShims({
		shimDirectory: join(directory, 'bin'),
		bunPath: process.execPath,
		shimScriptPath: join(import.meta.dir, 'command-shim.ts'),
		realGhPath: fakeRealTool,
		realGitPath: fakeRealTool,
	});

	const run = (tool: 'gh' | 'git', args: string[], extraEnv: Record<string, string> = {}) => {
		return spawnSync(join(directory, 'bin', tool), args, {
			encoding: 'utf8',
			env: { ...process.env, ...extraEnv },
		});
	};

	const calls = (): string[] => {
		return existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : [];
	};

	return { run, calls };
};

describe('installed command shims', () => {
	it('gh write → exit 1, real gh never invoked', () => {
		const { run, calls } = setUpShims();
		const result = run('gh', ['pr', 'review', '1', '--approve']);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Blocked by proxy-review-bot');
		expect(calls()).toEqual([]);
	});

	it('gh read → forwarded with args intact and its exit code kept', () => {
		const { run, calls } = setUpShims();
		const result = run('gh', ['pr', 'view', '1', '--json', 'title']);

		expect(result.status).toBe(7);
		expect(calls()).toEqual(['pr view 1 --json title']);
	});

	it('git push → blocked; git show → forwarded', () => {
		const { run, calls } = setUpShims();

		expect(run('git', ['-C', '/clone', 'push']).status).toBe(1);
		expect(run('git', ['-C', '/clone', 'show', 'abc:src/a.ts']).status).toBe(7);
		expect(calls()).toEqual(['-C /clone show abc:src/a.ts']);
	});

	it('git -c config injection → blocked, never forwarded', () => {
		const { run, calls } = setUpShims();

		expect(run('git', ['-c', 'core.fsmonitor=/bin/sh', '-C', '/clone', 'status']).status).toBe(1);
		expect(
			run('git', ['-C', '/clone', 'status'], { GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/bin/sh'" })
				.status,
		).toBe(1);
		expect(calls()).toEqual([]);
	});
});
