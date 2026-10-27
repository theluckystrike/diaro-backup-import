import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice, ToggleComponent } from 'obsidian-test-mocks/obsidian';
import type { SponsorsManager } from '../src/license/index';
import DiaroBackupImportPlugin from '../src/main';
import { readBackup } from '../src/archive';
import { DEFAULT_MAPPING } from '../src/model';
import { ImportModal } from '../src/modal';
import { bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';

// A free user can select the Pro controls of the import window. The select shows the shared Pro notice with the
// "Sponsor on GitHub" button. No preset is saved or loaded, no comparison runs and the review toggle shows off again.
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';
const REVIEWS = 'Monthly review notes need Pro.';
const PRESETS = 'Saved mapping presets need Pro.';
const COMPARE = 'Backup comparison needs Pro.';
const fixture = () => readBackup(new Uint8Array(readFileSync('tests/fixtures/sample.zip')));

function fakePro(pro: boolean): SponsorsManager {
	return {
		isPro: () => pro,
		onChange: () => () => undefined,
		hasToken: () => false,
		isChecking: () => false,
		getState: () => ({ status: 'unchecked', lastAttemptAt: 0 }),
		config: { sponsorLogin: 'theluckystrike', source: 'diaro-backup-import' },
	} as unknown as SponsorsManager;
}

const toggles: ToggleComponent[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(pro: boolean) {
	const app = App.createConfigured__({ files: {} });
	const plugin = new DiaroBackupImportPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	// A lapsed sponsor keeps a saved preset.
	plugin.settings.presets = [{ name: 'Saved', mapping: { ...DEFAULT_MAPPING, titleProperty: 'heading' } }];
	plugin.saveSettings = vi.fn(async () => undefined);
	plugin.openImport = vi.fn() as never;
	bindPro(fakePro(pro));
	const shown: { text: string; buttons: number }[] = [];
	vi.spyOn(Notice.prototype as unknown as { constructor__(): void }, 'constructor__').mockImplementation(function (this: Notice) {
		shown.push({ text: this.messageEl.textContent ?? '', buttons: this.messageEl.querySelectorAll('.pf-pro-notice-sponsor').length });
	});
	vi.spyOn(ToggleComponent.prototype, 'constructor3__').mockImplementation(function (this: ToggleComponent) { toggles.push(this); });
	const modal = new ImportModal(plugin, fixture());
	modal.onOpen();
	await vi.waitFor(() => { expect(modal.contentEl.querySelector('.diaro-status')?.textContent).toContain('Preview ready'); }, { timeout: 20000 });
	return { plugin, modal, shown };
}

function reviewToggle(modal: ImportModal): ToggleComponent {
	const t = toggles.find((c) => modal.contentEl.contains(c.toggleEl) && c.toggleEl.closest('.setting-item')?.querySelector('.setting-item-name')?.textContent === 'Monthly review notes (Pro)');
	if (!t) throw new Error('No Monthly review notes toggle.');
	return t;
}
const button = (modal: ImportModal, text: string) => [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === text)!;

describe('Pro controls of the import window', () => {
	afterEach(() => { resetPro(); vi.restoreAllMocks(); toggles.length = 0; });

	it('a free user who selects Monthly review notes, Save preset, Use preset or Compare backup gets the Pro notice with a Sponsor button, and nothing runs or saves', async () => {
		const { plugin, modal, shown } = await setup(false);
		const savePreset = vi.spyOn(plugin, 'savePreset');
		const before = JSON.stringify(plugin.settings);
		const status = modal.contentEl.querySelector('.diaro-status')?.textContent;
		const t = reviewToggle(modal);
		expect(t.disabled).toBe(false);
		t.onClick();
		expect(reviewToggle(modal).getValue()).toBe(false);
		expect(reviewToggle(modal).toggleEl.classList.contains('is-enabled')).toBe(false);
		for (const text of ['Save preset', 'Use preset', 'Compare backup (Pro)']) {
			expect(button(modal, text).disabled).toBe(false);
			button(modal, text).click();
		}
		await flush();
		expect(shown).toEqual([
			{ text: `${REVIEWS} ${PITCH}Sponsor on GitHub`, buttons: 1 },
			{ text: `${PRESETS} ${PITCH}Sponsor on GitHub`, buttons: 1 },
			{ text: `${PRESETS} ${PITCH}Sponsor on GitHub`, buttons: 1 },
			{ text: `${COMPARE} ${PITCH}Sponsor on GitHub`, buttons: 1 },
		]);
		expect(savePreset).not.toHaveBeenCalled();
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.openImport).not.toHaveBeenCalled();
		expect(JSON.stringify(plugin.settings)).toBe(before);
		// No comparison ran, and the preview and the Create button stay.
		expect(modal.contentEl.querySelector('.diaro-status')?.textContent).toBe(status);
		expect(button(modal, 'Create notes').disabled).toBe(false);
		modal.close();
	});

	it('a Pro user who selects Monthly review notes, Save preset and Compare backup turns reviews on, saves the preset and compares', async () => {
		const { plugin, modal, shown } = await setup(true);
		reviewToggle(modal).onClick();
		expect(reviewToggle(modal).getValue()).toBe(true);
		const name = [...modal.contentEl.querySelectorAll<HTMLInputElement>('input')].find((i) => i.placeholder === 'Preset name')!;
		name.value = 'Travel'; name.dispatchEvent(new Event('input'));
		button(modal, 'Save preset').click();
		await vi.waitFor(() => { expect(plugin.saveSettings).toHaveBeenCalled(); });
		expect(plugin.settings.presets.map((p) => p.name)).toEqual(['Saved', 'Travel']);
		await vi.waitFor(() => { expect(button(modal, 'Compare backup (Pro)').disabled).toBe(false); });
		button(modal, 'Compare backup (Pro)').click();
		expect(modal.contentEl.querySelector('.diaro-status')?.textContent).toContain('3 new');
		expect(shown.filter((n) => n.buttons > 0)).toEqual([]);
		modal.close();
	});
});
