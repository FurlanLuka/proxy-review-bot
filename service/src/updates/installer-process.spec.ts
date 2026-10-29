import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnInstaller } from './installer-process.js';

const waitForFile = async (path: string): Promise<void> => {
	for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) {
		await Bun.sleep(50);
	}
};

const processGroupOf = (processId: number): string => {
	return execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(processId)], {
		encoding: 'utf8',
	}).trim();
};

describe('spawnInstaller', () => {
	it('runs the script in its own process group, with exactly the given env and both streams logged', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'proxy-review-bot-installer-'));
		const scriptPath = join(directory, 'install.sh');
		const logPath = join(directory, 'logs', 'update.log');
		const done = join(directory, 'done');

		writeFileSync(
			scriptPath,
			[
				'echo "pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d " ")"',
				'env | sort',
				'echo "to stderr" >&2',
				`touch "${done}"`,
			].join('\n'),
		);
		spawnInstaller({
			scriptPath,
			env: { PATH: '/usr/bin:/bin', PRB_LOCAL_ZIP: '/tmp/app.zip', INSTALL_DIR: directory },
			logPath,
			cwd: directory,
			onError: (error) => {
				throw error;
			},
		});
		await waitForFile(done);

		const log = readFileSync(logPath, 'utf8');
		const [, processId, processGroup] = /pid=(\d+) pgid=(\d+)/.exec(log) ?? [];
		const environment = log
			.split('\n')
			.filter((line) => /^[A-Z_]+=/.test(line))
			.filter((line) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(line.split('=')[0] ?? ''));

		expect(processGroup).toBe(processId);
		expect(processGroup).not.toBe(processGroupOf(process.pid));
		expect(environment).toEqual([
			`INSTALL_DIR=${directory}`,
			'PATH=/usr/bin:/bin',
			'PRB_LOCAL_ZIP=/tmp/app.zip',
		]);
		expect(log).toContain('to stderr');
	});
});
