import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, DEFAULT_SETTINGS } from './settings.js';

const settingsPath = (): string => {
	return join(mkdtempSync(join(tmpdir(), 'proxy-review-bot-settings-')), 'settings.json');
};

describe('settings', () => {
	it('defaults: manual mode, auto-approve off, 5 rounds, 60 s', () => {
		expect(DEFAULT_SETTINGS).toMatchObject({
			reviewMode: 'manual',
			autoApprove: 'off',
			maxRounds: 5,
			pollIntervalSeconds: 60,
			answerQuestions: true,
		});
	});

	it('defaults: updates install automatically, also for an older file without the field', () => {
		const path = settingsPath();

		writeFileSync(path, JSON.stringify({ reviewMode: 'manual' }));

		expect(DEFAULT_SETTINGS.autoUpdate).toBe(true);
		expect(createSettingsStore(path).get().autoUpdate).toBe(true);
	});

	it('updates off is kept', () => {
		const path = settingsPath();

		createSettingsStore(path).replace({ ...DEFAULT_SETTINGS, autoUpdate: false });

		expect(createSettingsStore(path).get().autoUpdate).toBe(false);
	});

	it('defaults: Post reviews is Ask me first', () => {
		expect(DEFAULT_SETTINGS.postReviews).toBe('ask');
	});

	it.each([
		['manual', 'ask'],
		['auto', 'auto'],
	] as const)(
		'an older settings file in %s mode, without Post reviews → %s',
		(reviewMode, expected) => {
			const path = settingsPath();

			writeFileSync(path, JSON.stringify({ reviewMode }));

			expect(createSettingsStore(path).get()).toMatchObject({ reviewMode, postReviews: expected });
		},
	);

	it('an explicit Post reviews value is kept, even when it differs from the mode', () => {
		const path = settingsPath();
		const store = createSettingsStore(path);

		store.replace({ ...DEFAULT_SETTINGS, reviewMode: 'manual', postReviews: 'auto' });

		expect(createSettingsStore(path).get()).toMatchObject({
			reviewMode: 'manual',
			postReviews: 'auto',
		});
	});

	it('an invalid Post reviews value → defaults', () => {
		const path = settingsPath();

		writeFileSync(path, JSON.stringify({ reviewMode: 'auto', postReviews: 'sometimes' }));

		expect(createSettingsStore(path).get()).toEqual(DEFAULT_SETTINGS);
	});

	it('defaults: develop → master and develop → main start manually', () => {
		expect(DEFAULT_SETTINGS.manualStartBranches).toEqual([
			{ head: 'develop', base: 'master' },
			{ head: 'develop', base: 'main' },
		]);
	});

	it('an older settings file without Start manually → the default branches', () => {
		const path = settingsPath();

		writeFileSync(path, JSON.stringify({ reviewMode: 'auto' }));

		expect(createSettingsStore(path).get().manualStartBranches).toEqual(
			DEFAULT_SETTINGS.manualStartBranches,
		);
	});

	it('Start manually branches are trimmed, and an empty list is kept', () => {
		const path = settingsPath();
		const store = createSettingsStore(path);

		store.replace({
			...DEFAULT_SETTINGS,
			manualStartBranches: [{ head: ' release ', base: 'prod' }],
		});
		expect(createSettingsStore(path).get().manualStartBranches).toEqual([
			{ head: 'release', base: 'prod' },
		]);

		store.replace({ ...DEFAULT_SETTINGS, manualStartBranches: [] });
		expect(createSettingsStore(path).get().manualStartBranches).toEqual([]);
	});

	it.each([
		[{ head: 'develop', base: ' ' }],
		[{ head: 'develop' }],
		[{ head: 'develop', base: 'master', extra: true }],
		['develop → master'],
	])('an invalid Start manually pair %p → defaults', (pair) => {
		const path = settingsPath();

		writeFileSync(path, JSON.stringify({ reviewMode: 'auto', manualStartBranches: [pair] }));

		expect(createSettingsStore(path).get()).toEqual(DEFAULT_SETTINGS);
	});

	it('defaults: no Claude model, so Claude Code’s default applies', () => {
		expect(DEFAULT_SETTINGS.claudeModel).toBeNull();
	});

	it.each([
		[' sonnet ', 'sonnet'],
		['claude-opus-5-5', 'claude-opus-5-5'],
		['opus[1m]', 'opus[1m]'],
		[null, null],
	])('Claude model %p → kept as %p', (claudeModel, expected) => {
		const path = settingsPath();

		createSettingsStore(path).replace({ ...DEFAULT_SETTINGS, claudeModel });

		expect(createSettingsStore(path).get().claudeModel).toBe(expected);
	});

	it.each([['-x'], ['--x'], [''], ['two words'], ['a'.repeat(101)]])(
		'an invalid Claude model %p → rejected',
		(claudeModel) => {
			expect(
				createSettingsStore(settingsPath()).replace({ ...DEFAULT_SETTINGS, claudeModel }),
			).toBeNull();
		},
	);

	it('an older settings file without a Claude model → none', () => {
		const path = settingsPath();

		writeFileSync(path, JSON.stringify({ reviewMode: 'auto' }));

		expect(createSettingsStore(path).get().claudeModel).toBeNull();
	});

	it('defaults: three reviews at once', () => {
		expect(DEFAULT_SETTINGS.maxParallelReviews).toBe(3);
	});

	it.each([[1], [10]])('reviews at once %p → kept', (maxParallelReviews) => {
		const path = settingsPath();

		createSettingsStore(path).replace({ ...DEFAULT_SETTINGS, maxParallelReviews });

		expect(createSettingsStore(path).get().maxParallelReviews).toBe(maxParallelReviews);
	});

	it.each([[0], [11], [1.5]])('reviews at once %p → rejected', (maxParallelReviews) => {
		expect(
			createSettingsStore(settingsPath()).replace({ ...DEFAULT_SETTINGS, maxParallelReviews }),
		).toBeNull();
	});

	it('an older settings file without reviews at once → 3, the other values intact', () => {
		const path = settingsPath();

		writeFileSync(path, JSON.stringify({ reviewMode: 'auto', maxRounds: 8 }));

		expect(createSettingsStore(path).get()).toMatchObject({
			reviewMode: 'auto',
			maxRounds: 8,
			maxParallelReviews: 3,
		});
	});

	it('defaults: no review instructions, also for an older settings file', () => {
		const path = settingsPath();

		writeFileSync(path, JSON.stringify({ reviewMode: 'auto' }));

		expect(DEFAULT_SETTINGS.reviewInstructions).toBe('');
		expect(createSettingsStore(path).get().reviewInstructions).toBe('');
	});

	it('review instructions are trimmed; up to 4000 characters are kept, more are rejected', () => {
		const path = settingsPath();
		const store = createSettingsStore(path);

		store.replace({ ...DEFAULT_SETTINGS, reviewInstructions: '  Be brief.\n' });

		expect(createSettingsStore(path).get().reviewInstructions).toBe('Be brief.');
		expect(
			store.replace({ ...DEFAULT_SETTINGS, reviewInstructions: 'a'.repeat(4000) }),
		).not.toBeNull();
		expect(store.replace({ ...DEFAULT_SETTINGS, reviewInstructions: 'a'.repeat(4001) })).toBeNull();
	});

	it('the 4000 limit counts UTF-16 units, as the app does: 2000 emoji fit, 4000 do not', () => {
		const store = createSettingsStore(settingsPath());

		expect(
			store.replace({ ...DEFAULT_SETTINGS, reviewInstructions: '😀'.repeat(2000) }),
		).not.toBeNull();
		expect(
			store.replace({ ...DEFAULT_SETTINGS, reviewInstructions: '😀'.repeat(4000) }),
		).toBeNull();
	});

	it('missing file → defaults', () => {
		expect(createSettingsStore(settingsPath()).get()).toEqual(DEFAULT_SETTINGS);
	});

	it('corrupt file → defaults, not a crash', () => {
		const path = settingsPath();

		writeFileSync(path, JSON.stringify({ reviewMode: 'chaos' }));

		expect(createSettingsStore(path).get()).toEqual(DEFAULT_SETTINGS);
	});

	it('replace valid → written to disk and reloaded', () => {
		const path = settingsPath();

		createSettingsStore(path).replace({ ...DEFAULT_SETTINGS, skip: ['acme/infra'] });

		expect(JSON.parse(readFileSync(path, 'utf8')).skip).toEqual(['acme/infra']);
		expect(createSettingsStore(path).get().skip).toEqual(['acme/infra']);
	});

	it('replace invalid or with unknown keys → null, nothing written', () => {
		const path = settingsPath();
		const store = createSettingsStore(path);

		expect(store.replace({ ...DEFAULT_SETTINGS, pollIntervalSeconds: 1 })).toBeNull();
		expect(store.replace({ ...DEFAULT_SETTINGS, surprise: true })).toBeNull();
		expect(store.get()).toEqual(DEFAULT_SETTINGS);
	});
});
