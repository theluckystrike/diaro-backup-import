import { TEXT } from './copy';
import { Notice, Plugin } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { readBackup, type Backup } from './archive';
import { prepareImport, writeImport, type ImportPlan, type ImportResult } from './importer';
import { ImportModal } from './modal';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DiaroBackupImportSettingTab, normalizeSettings, type DiaroBackupImportSettings } from './settings';
import { validateMapping, type Mapping } from './model';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

export default class DiaroBackupImportPlugin extends Plugin {
	settings: DiaroBackupImportSettings = normalizeSettings(null);
	pro: SponsorsManager | null = null;
	private tab: DiaroBackupImportSettingTab | null = null;
	private modals = new Set<ImportModal>();
	private importing = false;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.tab = new DiaroBackupImportSettingTab(this.app, this);
		this.addSettingTab(this.tab);
		this.register(pro.onChange(() => { this.tab?.update(); for (const modal of this.modals) modal.updatePro(); }));
		this.addCommand({ id: 'import-backup', name: TEXT.title, callback: () => { this.openImport(); } });
		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
		});
	}
	onunload(): void {
		this.closeImportWindows();
		resetPro();
	}
	closeImportWindows(): void {
		for (const modal of this.modals) modal.close();
		this.modals.clear();
	}
	openImport(backup?: Backup): ImportModal {
		this.closeImportWindows();
		const modal = new ImportModal(this, backup);
		this.modals.add(modal);
		modal.open();
		return modal;
	}
	closed(modal: ImportModal): void { this.modals.delete(modal); }
	readBackup(bytes: Uint8Array): Backup { return readBackup(bytes); }
	async prepare(backup: Backup, folder: string, mapping: Mapping): Promise<ImportPlan> { return prepareImport(this.app.vault, backup, folder, mapping); }
	async importPlan(plan: ImportPlan, reviews = false): Promise<ImportResult> {
		if (this.importing) throw new Error('An import is in progress.');
		if (reviews && !isPro()) throw new Error('Monthly review notes need Pro.');
		this.importing = true;
		try { return await writeImport(this.app.vault, plan, reviews); } finally { this.importing = false; }
	}
	async savePreset(name: string, mapping: Mapping): Promise<boolean> {
		if (!isPro()) { new Notice(TEXT.needPreset); return false; }
		validateMapping(mapping);
		const clean = name.trim().slice(0, 60);
		if (!clean) throw new Error('Enter a preset name.');
		this.settings.presets = [...this.settings.presets.filter((p) => p.name !== clean), { name: clean, mapping: { ...mapping } }].slice(-20);
		await this.saveSettings();
		return true;
	}
	async loadSettings(): Promise<void> { this.settings = normalizeSettings(await this.loadData()); }
	async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}
