import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCommandShims } from './claude-client.js';
import {
	buildShimScript,
	decideShimAction,
	isCompiledEntry,
	resolveShimCommand,
	SHIM_CWD_VARIABLE,
} from './command-shim.js';

const ENTRY_PATH = join(import.meta.dir, '..', 'entry.ts');
const DEV_SHIM_COMMAND = resolveShimCommand({
	bunMain: ENTRY_PATH,
	execPath: process.execPath,
	entryPath: ENTRY_PATH,
});

interface MaliciousRepository {
	marker: string;
	bunOptionsMarker: string;
	bunOptionsPreload: string;
}

const plantMaliciousRepository = (repository: string): MaliciousRepository => {
	const marker = join(repository, 'preload-ran');
	const optionsDirectory = mkdtempSync(join(tmpdir(), 'prb-options-'));
	const bunOptionsMarker = join(optionsDirectory, 'bun-options-preload-ran');
	const bunOptionsPreload = join(optionsDirectory, 'options-pre.ts');

	writeFileSync(join(repository, '.env'), 'PRB_LEAK=from-dotenv\n');
	writeFileSync(join(repository, 'pre.ts'), `await Bun.write(${JSON.stringify(marker)}, 'yes');\n`);
	writeFileSync(join(repository, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
	writeFileSync(
		bunOptionsPreload,
		`await Bun.write(${JSON.stringify(bunOptionsMarker)}, 'yes');\n`,
	);
	writeFileSync(
		join(repository, 'probe.ts'),
		`await Bun.write(${JSON.stringify(join(repository, 'probe-leak'))}, process.env.PRB_LEAK ?? '');\n`,
	);

	return { marker, bunOptionsMarker, bunOptionsPreload };
};

const setUpShims = () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), 'proxy-review-bot-shim-')));
	const callLog = join(directory, 'calls.log');
	const fakeRealTool = join(directory, 'real-tool');
	const repository = join(directory, 'repo with space');

	mkdirSync(repository);
	writeFileSync(
		fakeRealTool,
		`#!/bin/sh\necho "$@" >> "${callLog}"\necho "cwd=$PWD leak=$PRB_LEAK shim=$${SHIM_CWD_VARIABLE}" >> "${callLog}"\nexit 7\n`,
	);
	chmodSync(fakeRealTool, 0o755);
	installCommandShims({
		shimDirectory: join(directory, 'bin'),
		shimCommand: DEV_SHIM_COMMAND,
		realGhPath: fakeRealTool,
		realGitPath: fakeRealTool,
	});

	const run = (tool: 'gh' | 'git', args: string[], extraEnv: Record<string, string> = {}) => {
		return spawnSync(join(directory, 'bin', tool), args, {
			cwd: repository,
			encoding: 'utf8',
			env: { ...process.env, ...extraEnv },
		});
	};

	const calls = (): string[] => {
		return existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : [];
	};

	return { run, calls, repository };
};

describe('installed command shims', () => {
	it('gh write → exit 1, real gh never invoked', () => {
		const { run, calls } = setUpShims();
		const result = run('gh', ['pr', 'review', '1', '--approve']);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Blocked by proxy-review-bot');
		expect(calls()).toEqual([]);
	});

	it('gh read → forwarded with args intact, in the caller directory, exit code kept', () => {
		const { run, calls, repository } = setUpShims();
		const result = run('gh', ['pr', 'view', '1', '--json', 'title']);

		expect(result.status).toBe(7);
		expect(calls()).toEqual(['pr view 1 --json title', `cwd=${repository} leak= shim=`]);
	});

	it('git push → blocked; git show → forwarded', () => {
		const { run, calls } = setUpShims();

		expect(run('git', ['-C', '/clone', 'push']).status).toBe(1);
		expect(run('git', ['-C', '/clone', 'show', 'abc:src/a.ts']).status).toBe(7);
		expect(calls()[0]).toBe('-C /clone show abc:src/a.ts');
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

	it('plain bun in the malicious repo → loads its .env and runs its preload (fixture control)', () => {
		const { repository } = setUpShims();
		const { marker } = plantMaliciousRepository(repository);

		const result = spawnSync(process.execPath, ['probe.ts'], { cwd: repository });

		expect(result.status).toBe(0);
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(join(repository, 'probe-leak'), 'utf8')).toBe('from-dotenv');
	});

	it('plain bun with BUN_OPTIONS=--preload → runs the preload (fixture control)', () => {
		const { repository } = setUpShims();
		const { bunOptionsMarker, bunOptionsPreload } = plantMaliciousRepository(repository);

		const result = spawnSync(process.execPath, ['--no-env-file', '-e', '0'], {
			cwd: '/',
			env: { ...process.env, BUN_OPTIONS: `--preload ${bunOptionsPreload}` },
		});

		expect(result.status).toBe(0);
		expect(existsSync(bunOptionsMarker)).toBe(true);
	});

	it('a repo with a bunfig.toml preload and a .env → neither is loaded by the shim', () => {
		const { run, calls, repository } = setUpShims();
		const { marker } = plantMaliciousRepository(repository);

		expect(run('gh', ['api', 'repos/cli/cli']).status).toBe(7);
		expect(existsSync(marker)).toBe(false);
		expect(calls()[1]).toBe(`cwd=${repository} leak= shim=`);
	});

	it('BUN_OPTIONS with a preload (NODE_OPTIONS set too) → stripped, the preload never runs', () => {
		const { run, calls, repository } = setUpShims();
		const { bunOptionsMarker, bunOptionsPreload } = plantMaliciousRepository(repository);

		const result = run('gh', ['api', 'repos/cli/cli'], {
			BUN_OPTIONS: `--preload ${bunOptionsPreload}`,
			NODE_OPTIONS: `--require ${bunOptionsPreload}`,
		});

		expect(result.status).toBe(7);
		expect(existsSync(bunOptionsMarker)).toBe(false);
		expect(calls()[0]).toBe('api repos/cli/cli');
	});

	it('a PR-controlled directory name with quotes and substitutions → passed through literally', () => {
		const { calls, repository } = setUpShims();
		const hostileName = "a'b`touch p1`$(touch p2)";
		const hostileDirectory = join(repository, hostileName);

		mkdirSync(hostileDirectory);

		const result = spawnSync(join(repository, '..', 'bin', 'gh'), ['api', 'repos/cli/cli'], {
			cwd: hostileDirectory,
			encoding: 'utf8',
			env: process.env,
		});

		expect(result.status).toBe(7);
		expect(calls()[1]).toBe(`cwd=${hostileDirectory} leak= shim=`);

		for (const directory of [repository, hostileDirectory, join(repository, '..', 'bin')]) {
			expect(existsSync(join(directory, 'p1'))).toBe(false);
			expect(existsSync(join(directory, 'p2'))).toBe(false);
		}
	});

	it('the service entry with missing arguments or an unknown tool → exit 2, nothing runs', () => {
		const missing = spawnSync(
			process.execPath,
			[...DEV_SHIM_COMMAND.slice(1), '--command-shim', 'gh'],
			{
				encoding: 'utf8',
			},
		);
		const unknown = spawnSync(
			process.execPath,
			[...DEV_SHIM_COMMAND.slice(1), '--command-shim', 'rm', '/bin/rm', '-rf', '/nonexistent'],
			{ encoding: 'utf8' },
		);

		expect(missing.status).toBe(2);
		expect(missing.stderr).toContain('missing tool name or real path');
		expect(unknown.status).toBe(2);
		expect(unknown.stderr).toContain('unknown tool "rm"');
	});

	it('a real tool that cannot start → exit 1 with the reason on stderr', () => {
		const result = spawnSync(
			process.execPath,
			[...DEV_SHIM_COMMAND.slice(1), '--command-shim', 'gh', '/nonexistent/gh', 'api', 'x'],
			{ encoding: 'utf8' },
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('command-shim:');
	});
});

describe('isCompiledEntry', () => {
	it('a /$bunfs entry → compiled; a source path → not compiled', () => {
		expect(isCompiledEntry('/$bunfs/root/proxy-review-bot-service')).toBe(true);
		expect(isCompiledEntry('/repo/service/src/entry.ts')).toBe(false);
	});
});

describe('resolveShimCommand', () => {
	it('compiled binary → the binary alone; source checkout → bun without .env loading on the entry', () => {
		expect(
			resolveShimCommand({
				bunMain: '/$bunfs/root/proxy-review-bot-service',
				execPath: '/Apps/Bot.app/Contents/MacOS/proxy-review-bot-service',
				entryPath: '/unused/entry.ts',
			}),
		).toEqual(['/Apps/Bot.app/Contents/MacOS/proxy-review-bot-service']);
		expect(
			resolveShimCommand({
				bunMain: '/repo/service/src/entry.ts',
				execPath: '/Users/me/.bun/bin/bun',
				entryPath: '/repo/service/src/entry.ts',
			}),
		).toEqual(['/Users/me/.bun/bin/bun', '--no-env-file', '/repo/service/src/entry.ts']);
	});
});

describe('decideShimAction', () => {
	it('missing tool or real path → invalid', () => {
		expect(decideShimAction({ args: ['gh'], env: {} }).kind).toBe('invalid');
	});

	it('a tool other than gh or git → invalid, never run', () => {
		expect(decideShimAction({ args: ['rm', '/bin/rm', '-rf', '/'], env: {} }).kind).toBe('invalid');
	});

	it('read → run with the caller directory from PRB_SHIM_CWD', () => {
		expect(
			decideShimAction({
				args: ['gh', '/real/gh', 'pr', 'view', '1'],
				env: { [SHIM_CWD_VARIABLE]: '/repo' },
			}),
		).toEqual({ kind: 'run', realPath: '/real/gh', args: ['pr', 'view', '1'], cwd: '/repo' });
	});

	it('git read with a dangerous GIT_ variable → blocked', () => {
		expect(
			decideShimAction({
				args: ['git', '/real/git', 'status'],
				env: { GIT_SSH_COMMAND: 'touch /tmp/x' },
			}).kind,
		).toBe('blocked');
	});
});

describe('buildShimScript', () => {
	it('quotes every part and runs from the safe directory with the caller directory exported', () => {
		const script = buildShimScript({
			shimCommand: ["/Apps/Proxy Review Bot.app/svc's", '--no-env-file'],
			toolName: 'gh',
			realPath: '/opt/$HOME/`gh`',
			safeDirectory: '/data dir/bin',
		});

		expect(script).toBe(
			[
				'#!/bin/sh',
				'for name in $(/usr/bin/env | /usr/bin/sed -n \'s/^\\(BUN_[A-Za-z0-9_]*\\)=.*/\\1/p\'); do unset "$name"; done',
				'unset NODE_OPTIONS',
				'PRB_SHIM_CWD="$PWD"',
				'export PRB_SHIM_CWD',
				"cd '/data dir/bin' || exit 1",
				"exec '/Apps/Proxy Review Bot.app/svc'\\''s' '--no-env-file' '--command-shim' 'gh' '/opt/$HOME/`gh`' \"$@\"",
				'',
			].join('\n'),
		);
	});
});
