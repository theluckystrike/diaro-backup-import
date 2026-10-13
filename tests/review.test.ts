import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import DiaroBackupImportPlugin from '../src/main';
import { readBackup } from '../src/archive';
import { DEFAULT_MAPPING, entryBody } from '../src/model';
import { bindPro, resetPro } from '../src/pro';
import { parseXml } from '../src/parser';
import manifest from '../manifest.json';
const fixture = () => readBackup(new Uint8Array(readFileSync('tests/fixtures/sample.zip')));
afterEach(() => resetPro());
describe('review defects', () => {
	it('loading a preset keeps the selected backup', () => {
		bindPro({ isPro: () => true, onChange: () => () => undefined } as never);
		const app = App.createConfigured__({});
		const plugin = new DiaroBackupImportPlugin(app as never, manifest as never);
		plugin.settings.presets = [{ name: 'Mine', mapping: { ...DEFAULT_MAPPING, titleProperty: 'subject' } }];
		const modal = plugin.openImport(fixture());
		const button = Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Use preset');
		expect(button).toBeDefined();
		button!.click();
		const next = [...(plugin as unknown as { modals: Set<unknown> }).modals][0] as { backup: unknown } | undefined;
		expect(next).toBeDefined();
		expect(next!.backup).not.toBeNull();
	});
	it('keeps the Diaro mood field when the entry has no mood_uid', () => {
		const one = (fields: string, tables = '') => parseXml(`<data version="2">${tables}<table name="diaro_entries"><r><uid>a</uid><date>0</date>${fields}</r></table></data>`).entries[0]!.mood;
		expect(one('<mood>3</mood>')).toBe('3');
		expect(one('<mood>2</mood>', '<table name="diaro_moods"><r><uid>2</uid><title>Good</title></r></table>')).toBe('Good');
		expect(one('<mood_uid>m1</mood_uid>', '<table name="diaro_moods"><r><uid>m1</uid><title>Calm</title></r></table>')).toBe('Calm');
		expect(one('<mood></mood>')).toBe('');
	});
	it('keeps line breaks in text with inline HTML only', () => {
		expect(entryBody('First line\nSecond <b>bold</b> line\n\nThird')).toMatch(/First line\s*\n\s*Second \*\*bold\*\* line\s*\n[\s\S]*Third/);
	});
});
