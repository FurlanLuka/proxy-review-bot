import { COMMAND_SHIM_FLAG, runCommandShim } from './claude/command-shim.js';
import { SERVICE_VERSION } from './updates/version.js';

if (process.argv[2] === COMMAND_SHIM_FLAG) {
	process.exit(runCommandShim(process.argv.slice(3)));
}

if (process.argv[2] === '--version') {
	process.stdout.write(`${SERVICE_VERSION}\n`);
	process.exit(0);
}

await import('./main.js');
