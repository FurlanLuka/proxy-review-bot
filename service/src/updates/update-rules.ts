import { basename, dirname } from 'node:path';
import { z } from 'zod';

export const RELEASE_REPOSITORY = 'FurlanLuka/proxy-review-bot';
export const BUNDLE_IDENTIFIER = 'com.furlanluka.proxy-review-bot';
export const BUNDLE_NAME = 'ProxyReviewBot.app';
export const SERVICE_BINARY_NAME = 'proxy-review-bot-service';

const TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
const SYSTEM_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const PASSED_THROUGH_VARIABLES = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'];

type VersionParts = [number, number, number];

const versionPartsOf = (version: string): VersionParts | null => {
	const match = TAG_PATTERN.exec(version);

	return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** A release tag as a plain version (`v0.6.1` → `0.6.1`), or null for anything else. */
export const versionOfTag = (tag: string): string | null => {
	const parts = versionPartsOf(tag);

	return parts === null ? null : parts.join('.');
};

/** Strictly newer only, so an update can never be a downgrade or a reinstall. */
export const isNewerVersion = (candidate: string, current: string): boolean => {
	const candidateParts = versionPartsOf(candidate);
	const currentParts = versionPartsOf(current);

	if (candidateParts === null || currentParts === null) {
		return false;
	}

	for (const [index, part] of candidateParts.entries()) {
		if (part !== currentParts[index]) {
			return part > (currentParts[index] ?? 0);
		}
	}

	return false;
};

export const assetNameFor = (version: string): string => {
	return `ProxyReviewBot_${version}_macos_arm64.zip`;
};

const RELEASE_SCHEMA = z.object({
	tag_name: z.string(),
	assets: z.array(z.object({ name: z.string(), digest: z.string().nullable().optional() })),
});

export interface LatestRelease {
	tag: string;
	version: string;
	assetName: string;
	sha256: string;
}

export type LatestReleaseResult =
	| { kind: 'release'; release: LatestRelease }
	| { kind: 'invalid'; reason: string };

/** The release's app zip and its checksum: a release without a sha256 digest is never installed. */
export const parseLatestRelease = (body: unknown): LatestReleaseResult => {
	const parsed = RELEASE_SCHEMA.safeParse(body);

	if (!parsed.success) {
		return { kind: 'invalid', reason: 'GitHub sent a release in an unexpected shape' };
	}

	const tag = parsed.data.tag_name;
	const version = versionOfTag(tag);

	if (version === null) {
		return { kind: 'invalid', reason: `The latest release tag ${tag} isn't a version` };
	}

	const assetName = assetNameFor(version);
	const asset = parsed.data.assets.find((candidate) => candidate.name === assetName);

	if (asset === undefined) {
		return { kind: 'invalid', reason: `Release ${tag} has no ${assetName}` };
	}

	const digest = DIGEST_PATTERN.exec(asset.digest ?? '');

	if (digest === null) {
		return { kind: 'invalid', reason: `Release ${tag} has no checksum for ${assetName}` };
	}

	return { kind: 'release', release: { tag, version, assetName, sha256: digest[1] ?? '' } };
};

export type InstallLocation =
	| { canInstall: true; installDirectory: string }
	| { canInstall: false; reason: string };

interface InstallLocationOfParams {
	servicePath: string;
	isCompiled: boolean;
	isWritable: (directory: string) => boolean;
}

/** Where install.sh puts the update: only a compiled service inside `ProxyReviewBot.app` can. */
export const installLocationOf = ({
	servicePath,
	isCompiled,
	isWritable,
}: InstallLocationOfParams): InstallLocation => {
	const macosDirectory = dirname(servicePath);
	const contentsDirectory = dirname(macosDirectory);
	const bundleDirectory = dirname(contentsDirectory);
	const isBundleShaped =
		basename(servicePath) === SERVICE_BINARY_NAME &&
		basename(macosDirectory) === 'MacOS' &&
		basename(contentsDirectory) === 'Contents' &&
		bundleDirectory.endsWith('.app');

	if (!isCompiled || !isBundleShaped) {
		return { canInstall: false, reason: 'Updates work only in the installed app' };
	}

	if (basename(bundleDirectory) !== BUNDLE_NAME) {
		return { canInstall: false, reason: `Updates work only when the app is named ${BUNDLE_NAME}` };
	}

	if (servicePath.includes('/AppTranslocation/')) {
		return {
			canInstall: false,
			reason: 'macOS is running a temporary copy of the app. Run the install command once.',
		};
	}

	const installDirectory = dirname(bundleDirectory);

	if (!isWritable(installDirectory)) {
		return { canInstall: false, reason: `Can't write to ${installDirectory}` };
	}

	return { canInstall: true, installDirectory };
};

interface BuildInstallerEnvParams {
	baseEnv: Record<string, string | undefined>;
	zipPath: string;
	installDirectory: string;
	toolPaths: (string | null)[];
}

/** An allowlist, not the service's env: tokens, shims and install.sh's test switches stay out. */
export const buildInstallerEnv = ({
	baseEnv,
	zipPath,
	installDirectory,
	toolPaths,
}: BuildInstallerEnvParams): Record<string, string> => {
	const toolDirectories = toolPaths
		.filter((path) => path?.startsWith('/') === true)
		.map((path) => dirname(path ?? ''));
	const passedThrough = PASSED_THROUGH_VARIABLES.flatMap((name) => {
		const value = baseEnv[name];

		return value === undefined ? [] : [[name, value] as const];
	});

	return {
		...Object.fromEntries(passedThrough),
		PATH: [...new Set([...toolDirectories, ...SYSTEM_DIRECTORIES])].join(':'),
		PRB_LOCAL_ZIP: zipPath,
		INSTALL_DIR: installDirectory,
		PRB_KEEP_LOGIN_ITEM: '1',
	};
};
