const READ_ONLY_PULL_REQUEST_COMMANDS = new Set(['view', 'diff', 'list', 'checks', 'status']);
const READ_ONLY_TOP_LEVEL_COMMANDS = new Set(['search', 'browse', 'version', 'help']);
const READ_ONLY_GIT_COMMANDS = new Set([
	'show',
	'fetch',
	'diff',
	'log',
	'merge-base',
	'merge-tree',
	'rev-parse',
	'rev-list',
	'cat-file',
	'ls-tree',
	'ls-files',
	'grep',
	'blame',
	'status',
	'range-diff',
	'shortlog',
	'describe',
	'show-ref',
	'for-each-ref',
	'name-rev',
	'version',
	'help',
]);
const GIT_HARMLESS_GLOBAL_FLAGS = new Set(['-P', '--no-pager', '--no-optional-locks']);
const GIT_COMMAND_RUNNING_OPTION_PATTERN =
	/^(--upload-pack|--receive-pack|-O|--open-files-in-pager|--output|--ext-diff|ext::)/;

const FIELD_FLAG_PATTERN = /^(-[fF]|--(field|raw-field|input)(=|$))/;

const findMethod = (args: string[]): string | null => {
	for (const [index, argument] of args.entries()) {
		if (argument === '-X' || argument === '--method') {
			return args[index + 1]?.toUpperCase() ?? null;
		}

		if (argument.startsWith('--method=')) {
			return argument.slice('--method='.length).toUpperCase();
		}

		if (argument.startsWith('-X')) {
			return argument.slice(2).toUpperCase();
		}
	}

	return null;
};

const isGhApiWrite = (args: string[]): boolean => {
	const hasFields = args.some((argument) => FIELD_FLAG_PATTERN.test(argument));
	const usesInputBody = args.some((argument) => argument.startsWith('--input'));

	if (args.some((argument) => /(^|\/)graphql$/.test(argument))) {
		const readsFieldFromFile = args.some(
			(argument) => argument.startsWith('@') || argument.includes('=@'),
		);
		const hasMutation = args.some((argument) => /\bmutation\b/i.test(argument));

		return usesInputBody || readsFieldFromFile || hasMutation;
	}

	const method = findMethod(args);

	if (method !== null) {
		return method !== 'GET' || usesInputBody;
	}

	return hasFields;
};

export const isGhWriteCommand = (args: string[]): boolean => {
	const [command, subcommand] = args;

	if (command === undefined) {
		return false;
	}

	if (command === 'api') {
		return isGhApiWrite(args.slice(1));
	}

	if (command === 'pr') {
		return subcommand === undefined || !READ_ONLY_PULL_REQUEST_COMMANDS.has(subcommand);
	}

	if (command === 'auth') {
		return subcommand !== 'status';
	}

	if (command === 'repo') {
		return subcommand !== 'view';
	}

	return !READ_ONLY_TOP_LEVEL_COMMANDS.has(command);
};

const skipGitGlobalOptions = (args: string[]): string[] | null => {
	const [first, ...rest] = args;

	if (first === undefined || !first.startsWith('-')) {
		return args;
	}

	if (first === '-C') {
		return skipGitGlobalOptions(rest.slice(1));
	}

	if (first === '--version' || first === '--help') {
		return rest.length === 0 ? [first.slice(2)] : null;
	}

	return GIT_HARMLESS_GLOBAL_FLAGS.has(first) ? skipGitGlobalOptions(rest) : null;
};

const isReadOnlyGitConfig = (args: string[]): boolean => {
	return args.some((argument) =>
		['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(argument),
	);
};

const isReadOnlyGitRemote = (subcommand: string | undefined): boolean => {
	return subcommand === undefined || ['-v', '--verbose', 'show', 'get-url'].includes(subcommand);
};

export const isGitWriteCommand = (args: string[]): boolean => {
	const isDangerous = args.some((argument) => GIT_COMMAND_RUNNING_OPTION_PATTERN.test(argument));

	if (isDangerous) {
		return true;
	}

	const commandArgs = skipGitGlobalOptions(args);

	if (commandArgs === null) {
		return true;
	}

	const [command, subcommand] = commandArgs;

	if (command === undefined) {
		return false;
	}

	if (command === 'remote') {
		return !isReadOnlyGitRemote(subcommand);
	}

	if (command === 'config') {
		return !isReadOnlyGitConfig(commandArgs);
	}

	return !READ_ONLY_GIT_COMMANDS.has(command);
};

const DANGEROUS_GIT_ENVIRONMENT_PATTERN =
	/^GIT_(CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_GLOBAL|CONFIG_SYSTEM|EXTERNAL_DIFF|SSH|SSH_COMMAND|PROXY_COMMAND|EXEC_PATH|PAGER|ASKPASS|DIR|WORK_TREE|ALLOW_PROTOCOL|TEMPLATE_DIR|TRACE\w*)$/;

export const isDangerousGitVariable = (name: string): boolean => {
	return DANGEROUS_GIT_ENVIRONMENT_PATTERN.test(name);
};

export const hasDangerousGitEnvironment = (
	environment: Record<string, string | undefined>,
): boolean => {
	return Object.entries(environment).some(
		([name, value]) => value !== undefined && isDangerousGitVariable(name),
	);
};
