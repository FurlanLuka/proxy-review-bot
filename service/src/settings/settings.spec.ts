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
