import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SpawnInstallerParams {
	scriptPath: string;
	env: Record<string, string>;
	logPath: string;
	cwd: string;
	onError: (error: Error) => void;
}

export type SpawnInstaller = (params: SpawnInstallerParams) => void;

/**
 * Starts install.sh so it outlives the service: its own session escapes launchd's process-group
 * kill, and file output (no pipes) means no SIGPIPE once the service is gone. Not `runCommand`:
 * its timeout and shutdown kill would end the installer midway.
 */
export const spawnInstaller: SpawnInstaller = ({ scriptPath, env, logPath, cwd, onError }) => {
	mkdirSync(dirname(logPath), { recursive: true });

	const logFile = openSync(logPath, 'a');

	try {
		const child = spawn('/bin/sh', [scriptPath], {
			cwd,
			env,
			detached: true,
			stdio: ['ignore', logFile, logFile],
		});

		child.on('error', onError);
		child.unref();
	} finally {
		closeSync(logFile);
	}
};
