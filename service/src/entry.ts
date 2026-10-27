import { COMMAND_SHIM_FLAG, runCommandShim } from './claude/command-shim.js';

if (process.argv[2] === COMMAND_SHIM_FLAG) {
	process.exit(runCommandShim(process.argv.slice(3)));
}

await import('./main.js');
