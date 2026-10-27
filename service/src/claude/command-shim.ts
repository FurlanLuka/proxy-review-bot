import { spawnSync } from 'node:child_process';
import {
	hasDangerousGitEnvironment,
	isGhWriteCommand,
	isGitWriteCommand,
} from './command-guard.js';

export const COMMAND_SHIM_FLAG = '--command-shim';
export const SHIM_CWD_VARIABLE = 'PRB_SHIM_CWD';

const COMPILED_ENTRY_PREFIX = '/$bunfs/';
const SHIMMED_TOOLS = new Set(['gh', 'git']);

type Environment = Record<string, string | undefined>;

export type ShimDecision =
	| { kind: 'invalid'; message: string }
	| { kind: 'blocked'; message: string }
	| { kind: 'run'; realPath: string; args: string[]; cwd: string | undefined };

interface DecideShimActionParams {
	args: string[];
	env: Environment;
}

export const decideShimAction = ({ args, env }: DecideShimActionParams): ShimDecision => {
	const [toolName, realPath, ...forwardedArgs] = args;

	if (toolName === undefined || realPath === undefined) {
		return { kind: 'invalid', message: 'command-shim: missing tool name or real path' };
	}

	if (!SHIMMED_TOOLS.has(toolName)) {
		return { kind: 'invalid', message: `command-shim: unknown tool "${toolName}"` };
	}

	const isWrite =
		toolName === 'gh'
			? isGhWriteCommand(forwardedArgs)
			: isGitWriteCommand(forwardedArgs) || hasDangerousGitEnvironment(env);

	if (isWrite) {
		return {
			kind: 'blocked',
			message:
				`Blocked by proxy-review-bot: "${toolName} ${forwardedArgs.join(' ')}" would write. ` +
				'This run is read-only; return the draft as JSON instead.',
		};
	}

	return { kind: 'run', realPath, args: forwardedArgs, cwd: env[SHIM_CWD_VARIABLE] };
};

const buildRealToolEnv = (env: Environment, cwd: string | undefined): Environment => {
	const { [SHIM_CWD_VARIABLE]: _shimCwd, OLDPWD: _oldPwd, ...rest } = env;

	return cwd === undefined ? rest : { ...rest, PWD: cwd };
};

export const runCommandShim = (args: string[], env: Environment = process.env): number => {
	const decision = decideShimAction({ args, env });

	if (decision.kind !== 'run') {
		process.stderr.write(`${decision.message}\n`);

		return decision.kind === 'invalid' ? 2 : 1;
	}

	const result = spawnSync(decision.realPath, decision.args, {
		stdio: 'inherit',
		cwd: decision.cwd,
		env: buildRealToolEnv(env, decision.cwd),
	});

	if (result.error !== undefined) {
		process.stderr.write(`command-shim: ${result.error.message}\n`);
	}

	return result.status ?? 1;
};

interface ResolveShimCommandParams {
	bunMain: string;
	execPath: string;
	entryPath: string;
}

export const isCompiledEntry = (bunMain: string): boolean => {
	return bunMain.startsWith(COMPILED_ENTRY_PREFIX);
};

export const resolveShimCommand = ({
	bunMain,
	execPath,
	entryPath,
}: ResolveShimCommandParams): string[] => {
	return isCompiledEntry(bunMain) ? [execPath] : [execPath, '--no-env-file', entryPath];
};

const shellQuote = (value: string): string => {
	return `'${value.replaceAll("'", "'\\''")}'`;
};

interface BuildShimScriptParams {
	shimCommand: string[];
	toolName: 'gh' | 'git';
	realPath: string;
	safeDirectory: string;
}

export const buildShimScript = ({
	shimCommand,
	toolName,
	realPath,
	safeDirectory,
}: BuildShimScriptParams): string => {
	const command = [...shimCommand, COMMAND_SHIM_FLAG, toolName, realPath].map(shellQuote).join(' ');

	return [
		'#!/bin/sh',
		'for name in $(/usr/bin/env | /usr/bin/sed -n \'s/^\\(BUN_[A-Za-z0-9_]*\\)=.*/\\1/p\'); do unset "$name"; done',
		'unset NODE_OPTIONS',
		`${SHIM_CWD_VARIABLE}="$PWD"`,
		`export ${SHIM_CWD_VARIABLE}`,
		`cd ${shellQuote(safeDirectory)} || exit 1`,
		`exec ${command} "$@"`,
		'',
	].join('\n');
};
