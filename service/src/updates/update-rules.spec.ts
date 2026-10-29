import { describe, expect, it } from 'bun:test';
import {
	buildInstallerEnv,
	installLocationOf,
	isNewerVersion,
	parseLatestRelease,
	versionOfTag,
} from './update-rules.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

const releaseBody = (
	tag: string,
	assets = [{ name: `ProxyReviewBot_0.6.1_macos_arm64.zip`, digest: DIGEST }],
) => {
	return { tag_name: tag, assets };
};

describe('versions', () => {
	it.each([
		['v0.6.1', '0.6.1'],
		['0.6.1', '0.6.1'],
		['v10.20.30', '10.20.30'],
	])('tag %s → %s', (tag, expected) => {
		expect(versionOfTag(tag)).toBe(expected);
	});

	it.each(['v0.6', 'v0.6.1-beta', '../../etc', 'v0.6.1/../x', 'latest', ''])(
		'tag %p → not a version',
		(tag) => {
			expect(versionOfTag(tag)).toBeNull();
		},
	);

	it.each([
		['0.6.1', '0.6.0', true],
		['0.7.0', '0.6.9', true],
		['1.0.0', '0.99.99', true],
		['0.10.0', '0.9.0', true],
		['0.6.0', '0.6.0', false],
		['0.5.9', '0.6.0', false],
		['0.6.0', '1.0.0', false],
		['nonsense', '0.6.0', false],
		['0.6.1', 'nonsense', false],
	])('%s newer than %s → %p', (candidate, current, expected) => {
		expect(isNewerVersion(candidate, current)).toBe(expected);
	});
});

describe('latest release', () => {
	it('the app zip and its checksum', () => {
		expect(parseLatestRelease(releaseBody('v0.6.1'))).toEqual({
			kind: 'release',
			release: {
				tag: 'v0.6.1',
				version: '0.6.1',
				assetName: 'ProxyReviewBot_0.6.1_macos_arm64.zip',
				sha256: 'a'.repeat(64),
			},
		});
	});

	it.each([
		[
			'a tag that isn’t a version',
			releaseBody('nightly'),
			"The latest release tag nightly isn't a version",
		],
		[
			'no app zip',
			releaseBody('v0.6.1', []),
			'Release v0.6.1 has no ProxyReviewBot_0.6.1_macos_arm64.zip',
		],
		[
			'no checksum',
			releaseBody('v0.6.1', [
				{ name: 'ProxyReviewBot_0.6.1_macos_arm64.zip', digest: null as never },
			]),
			'Release v0.6.1 has no checksum for ProxyReviewBot_0.6.1_macos_arm64.zip',
		],
		[
			'a checksum that isn’t sha256',
			releaseBody('v0.6.1', [{ name: 'ProxyReviewBot_0.6.1_macos_arm64.zip', digest: 'md5:abc' }]),
			'Release v0.6.1 has no checksum for ProxyReviewBot_0.6.1_macos_arm64.zip',
		],
		[
			'an unexpected shape',
			{ message: 'Not Found' },
			'GitHub sent a release in an unexpected shape',
		],
	])('%s → not installable', (_case, body, reason) => {
		expect(parseLatestRelease(body)).toEqual({ kind: 'invalid', reason });
	});
});

describe('install location', () => {
	const SERVICE =
		'/Users/me/Applications/ProxyReviewBot.app/Contents/MacOS/proxy-review-bot-service';
	const writable = () => true;

	it('the installed app → its folder', () => {
		expect(
			installLocationOf({ servicePath: SERVICE, isCompiled: true, isWritable: writable }),
		).toEqual({
			canInstall: true,
			installDirectory: '/Users/me/Applications',
		});
	});

	it.each([
		[
			'a dev run',
			{ servicePath: '/opt/bun/bin/bun', isCompiled: false },
			'Updates work only in the installed app',
		],
		[
			'a binary outside a bundle',
			{ servicePath: '/tmp/proxy-review-bot-service', isCompiled: true },
			'Updates work only in the installed app',
		],
		[
			'a renamed bundle',
			{
				servicePath: '/Applications/Copy.app/Contents/MacOS/proxy-review-bot-service',
				isCompiled: true,
			},
			'Updates work only when the app is named ProxyReviewBot.app',
		],
		[
			'a translocated copy',
			{
				servicePath:
					'/private/var/folders/x/AppTranslocation/1234/d/ProxyReviewBot.app/Contents/MacOS/proxy-review-bot-service',
				isCompiled: true,
			},
			'macOS is running a temporary copy of the app. Run the install command once.',
		],
	])('%s → can’t install', (_case, params, reason) => {
		expect(installLocationOf({ ...params, isWritable: writable })).toEqual({
			canInstall: false,
			reason,
		});
	});

	it('a folder it can’t write to → can’t install', () => {
		expect(
			installLocationOf({ servicePath: SERVICE, isCompiled: true, isWritable: () => false }),
		).toEqual({
			canInstall: false,
			reason: "Can't write to /Users/me/Applications",
		});
	});
});

describe('installer env', () => {
	it('an allowlist: tool folders and the system PATH, never tokens, shims or test switches', () => {
		const env = buildInstallerEnv({
			baseEnv: {
				HOME: '/Users/me',
				USER: 'me',
				LANG: 'en_US.UTF-8',
				PATH: '/Users/me/Library/Application Support/ProxyReviewBot/bin:/opt/homebrew/bin',
				GITHUB_TOKEN: 'secret',
				PRB_TOKEN: 'secret',
				PRB_SOURCE_ONLY: '1',
				PRB_NO_LAUNCH: '1',
				ANTHROPIC_API_KEY: 'secret',
			},
			zipPath: '/data/updates/0.6.1/app.zip',
			installDirectory: '/Users/me/Applications',
			toolPaths: ['/opt/homebrew/bin/gh', '/usr/bin/git', null, 'gh'],
		});

		expect(env).toEqual({
			HOME: '/Users/me',
			USER: 'me',
			LANG: 'en_US.UTF-8',
			PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
			PRB_LOCAL_ZIP: '/data/updates/0.6.1/app.zip',
			INSTALL_DIR: '/Users/me/Applications',
			PRB_KEEP_LOGIN_ITEM: '1',
		});
	});
});
