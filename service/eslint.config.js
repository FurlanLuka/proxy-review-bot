import stylistic from '@stylistic/eslint-plugin';
import tsParser from 'typescript-eslint';

export default [
	{
		ignores: ['**/node_modules/**'],
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser.parser,
		},
		plugins: {
			'@stylistic': stylistic,
		},
		rules: {
			'@stylistic/padding-line-between-statements': [
				'warn',
				{ blankLine: 'always', prev: '*', next: 'return' },
				{ blankLine: 'always', prev: '*', next: 'multiline-block-like' },
				{ blankLine: 'always', prev: 'multiline-block-like', next: '*' },
				{ blankLine: 'always', prev: 'import', next: '*' },
				{ blankLine: 'any', prev: 'import', next: 'import' },
				{ blankLine: 'always', prev: '*', next: ['interface', 'type'] },
				{ blankLine: 'always', prev: ['interface', 'type'], next: '*' },
				{ blankLine: 'any', prev: 'type', next: 'type' },
				{ blankLine: 'any', prev: 'interface', next: 'interface' },
			],
		},
	},
];
