import packageJson from '../../package.json' with { type: 'json' };

/** The build stamps the release version in (`--define`), so it always matches the app bundle. */
export const SERVICE_VERSION = process.env.PRB_BUILD_VERSION ?? packageJson.version;
