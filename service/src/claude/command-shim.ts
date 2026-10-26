import { spawnSync } from 'node:child_process';
import {
	hasDangerousGitEnvironment,
	isGhWriteCommand,
	isGitWriteCommand,
} from './command-guard.js';

const [toolName, realPath, ...forwardedArgs] = process.argv.slice(2);

if (toolName === undefined || realPath === undefined) {
	process.stderr.write('command-shim: missing tool name or real path\n');
	process.exit(2);
}

const isWrite =
	toolName === 'gh'
		? isGhWriteCommand(forwardedArgs)
		: isGitWriteCommand(forwardedArgs) || hasDangerousGitEnvironment(process.env);

if (isWrite) {
	process.stderr.write(
		`Blocked by proxy-review-bot: "${toolName} ${forwardedArgs.join(' ')}" would write. ` +
			'This run is read-only; return the draft as JSON instead.\n',
	);
	process.exit(1);
}

const result = spawnSync(realPath, forwardedArgs, { stdio: 'inherit' });

process.exit(result.status ?? 1);
