import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult, RunCommand } from '../commands/run-command.js';
import { BUNDLE_IDENTIFIER, BUNDLE_NAME, RELEASE_REPOSITORY } from './update-rules.js';
import type { LatestRelease } from './update-rules.js';

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const ERROR_DETAIL_LIMIT = 200;

export type StepResult = { isOk: true } | { isOk: false; stage: string; message: string };

export const detailOf = (text: string): string => {
	return text.trim().split('\n').slice(-1)[0]?.slice(0, ERROR_DETAIL_LIMIT) ?? '';
};

export const messageOf = (error: unknown): string => {
	return error instanceof Error ? error.message : String(error);
};

const failureDetailOf = (result: CommandResult): string => {
	return result.isTimedOut ? 'timed out' : detailOf(result.stderr || result.stdout);
};

const sha256Of = (path: string): Promise<string> => {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');

		createReadStream(path)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
};

export const installScriptPathOf = (directory: string): string => {
	return join(directory, 'unpacked', BUNDLE_NAME, 'Contents', 'Resources', 'install.sh');
};

interface DownloadParams {
	runCommand: RunCommand;
	ghPath: string;
	env: Record<string, string | undefined>;
	release: LatestRelease;
	directory: string;
}

export const downloadRelease = async ({
	runCommand,
	ghPath,
	env,
	release,
	directory,
}: DownloadParams): Promise<StepResult> => {
	const result = await runCommand({
		command: ghPath,
		args: [
			'release',
			'download',
			release.tag,
			'--repo',
			RELEASE_REPOSITORY,
			'--pattern',
			release.assetName,
			'--dir',
			directory,
			'--clobber',
		],
		env,
		timeoutMs: DOWNLOAD_TIMEOUT_MS,
	});

	return result.exitCode === 0
		? { isOk: true }
		: {
				isOk: false,
				stage: 'download',
				message: `Couldn't download v${release.version}: ${failureDetailOf(result)}`,
			};
};

interface VerifyParams {
	runCommand: RunCommand;
	release: LatestRelease;
	directory: string;
}

const readPlistValue = async (
	runCommand: RunCommand,
	plistPath: string,
	key: string,
): Promise<string> => {
	const result = await runCommand({
		command: '/usr/bin/plutil',
		args: ['-extract', key, 'raw', '-o', '-', plistPath],
	});

	return result.exitCode === 0 ? result.stdout.trim() : '';
};

/** The checks that stand between a download and running its install.sh. */
export const verifyDownload = async ({
	runCommand,
	release,
	directory,
}: VerifyParams): Promise<StepResult> => {
	const zipPath = join(directory, release.assetName);

	if (!existsSync(zipPath) || (await sha256Of(zipPath)) !== release.sha256) {
		return { isOk: false, stage: 'verify', message: "The download didn't match its checksum" };
	}

	const unpacked = await runCommand({
		command: '/usr/bin/ditto',
		args: ['-x', '-k', zipPath, join(directory, 'unpacked')],
	});

	if (unpacked.exitCode !== 0) {
		return { isOk: false, stage: 'verify', message: "Couldn't unpack the download" };
	}

	const bundlePath = join(directory, 'unpacked', BUNDLE_NAME);
	const plistPath = join(bundlePath, 'Contents', 'Info.plist');
	const bundleIdentifier = await readPlistValue(runCommand, plistPath, 'CFBundleIdentifier');
	const bundleVersion = await readPlistValue(runCommand, plistPath, 'CFBundleShortVersionString');

	if (bundleIdentifier !== BUNDLE_IDENTIFIER || bundleVersion !== release.version) {
		return {
			isOk: false,
			stage: 'verify',
			message: `The download isn't Proxy Review Bot v${release.version}`,
		};
	}

	if (!existsSync(installScriptPathOf(directory))) {
		return { isOk: false, stage: 'verify', message: 'The download has no installer' };
	}

	const seal = await runCommand({
		command: '/usr/bin/codesign',
		args: ['--verify', '--deep', '--strict', bundlePath],
	});

	return seal.exitCode === 0
		? { isOk: true }
		: { isOk: false, stage: 'verify', message: "The download's code seal is broken" };
};
