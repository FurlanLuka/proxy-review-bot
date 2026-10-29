import type { RunCommand } from '../commands/run-command.js';
import type { Logger } from '../logging/logger.js';
import type { SettingsStore } from '../settings/settings.js';
import type { SpawnInstaller } from './installer-process.js';
import type { InstallLocation } from './update-rules.js';

export type UpdatePhase =
	| 'idle'
	| 'checking'
	| 'waiting_for_reviews'
	| 'downloading'
	| 'installing'
	| 'failed';

export interface LastUpdate {
	version: string;
	didSucceed: boolean;
}

export interface UpdateState {
	currentVersion: string;
	latestVersion: string | null;
	isUpdateAvailable: boolean;
	canInstall: boolean;
	cannotInstallReason: string | null;
	phase: UpdatePhase;
	lastCheckedAt: number | null;
	error: string | null;
	lastUpdate: LastUpdate | null;
}

export type InstallRequestResult = 'ok' | 'no_update' | 'cannot_install' | 'busy';

export interface UpdateJobs {
	isIdle(): boolean;
	setHeld(isHeld: boolean): void;
}

export interface UpdaterDependencies {
	runCommand: RunCommand;
	spawnInstaller: SpawnInstaller;
	flags: {
		getFlag(name: string): string | null;
		setFlag(name: string, value: string | null): void;
	};
	settingsStore: SettingsStore;
	jobs: UpdateJobs;
	logger: Logger;
	now: () => number;
	currentVersion: string;
	installLocation: InstallLocation;
	ghPath: string | null;
	gitPath: string | null;
	updatesDirectory: string;
	updateLogPath: string;
	baseEnv: Record<string, string | undefined>;
}
