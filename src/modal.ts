import { TEXT } from './copy';
import { Modal, Notice, Setting } from 'obsidian';
import { MAX_ZIP, type Backup } from './archive';
import { comparePlan, existingFile, type ImportPlan } from './importer';
import { validateMapping, type Mapping } from './model';
import { isPro } from './pro';
import type DiaroBackupImportPlugin from './main';

export class ImportModal extends Modal {
	private backup: Backup | null;
	private plan: ImportPlan | null = null;
	private mapping: Mapping;
	private folder: string;
	private reviews = false;
	private busy = false;
	private generation = 0;
	private disposed = false;
	private status: HTMLElement | null = null;
	private preview: HTMLElement | null = null;
	private proControls: HTMLElement | null = null;
	private actions: HTMLElement | null = null;

	constructor(private readonly plugin: DiaroBackupImportPlugin, backup?: Backup) {
		super(plugin.app);
		this.backup = backup ?? null;
		this.mapping = { ...plugin.settings.mapping };
		this.folder = plugin.settings.folder;
	}
	onOpen(): void {
		this.setTitle(TEXT.title);
		this.modalEl.addClass('diaro-import-modal');
		this.contentEl.addClass('diaro-import');
		this.contentEl.createEl('p', { text: TEXT.description });
		const picker = new Setting(this.contentEl).setName(TEXT.fileLabel).setDesc(TEXT.fileHelp);
		const input = picker.controlEl.createEl('input', { type: 'file', cls: 'diaro-picker' });
		input.accept = '.zip';
		input.setAttribute('aria-label', TEXT.fileLabel);
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			if (file) void this.run(async () => {
				this.backup = null;
				if (file.size > MAX_ZIP) throw new Error('The ZIP file exceeds 64 MiB.');
				this.backup = this.plugin.readBackup(new Uint8Array(await file.arrayBuffer()));
				await this.refreshPreview();
			});
		});
		new Setting(this.contentEl).setName('Import folder').addText((t) => t.setValue(this.folder).onChange((value) => { this.folder = value; this.invalidate(); }));
		new Setting(this.contentEl).setName('Note name').addDropdown((d) => d.addOption('date-title', TEXT.dateTitle).addOption('date-id', TEXT.dateId).setValue(this.mapping.noteName).onChange((value) => { this.mapping.noteName = value === 'date-id' ? 'date-id' : 'date-title'; this.invalidate(); }));
		const details = this.contentEl.createEl('details');
		details.createEl('summary', { text: 'Property mapping' });
		for (const [key, name] of [['titleProperty', 'Title property'], ['folderProperty', 'Folder property'], ['moodProperty', 'Mood property'], ['tagsProperty', 'Tags property']] as const) {
			new Setting(details).setName(name).addText((t) => t.setValue(this.mapping[key]).onChange((value) => { this.mapping[key] = value.trim(); this.invalidate(); }));
		}
		this.proControls = this.contentEl.createDiv();
		this.updatePro();
		this.status = this.contentEl.createDiv({ cls: 'diaro-status', attr: { role: 'status', 'aria-live': 'polite' } });
		this.preview = this.contentEl.createDiv({ cls: 'diaro-preview' });
		this.actions = this.contentEl.createDiv({ cls: 'diaro-actions' });
		this.drawActions();
		if (this.backup) void this.run(() => this.refreshPreview());
	}
	private invalidate(): void {
		this.generation++;
		this.plan = null;
		this.preview?.empty();
		this.message('Select Preview to check the current folder and mapping.');
		this.drawActions();
	}
	private message(text: string): void { this.status?.setText(text); }
	private async run(action: () => Promise<void>): Promise<void> {
		if (this.busy || this.disposed) return;
		this.busy = true;
		this.drawActions();
		this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((input) => { input.disabled = true; });
		try { await action(); } catch (e) { this.plan = null; this.preview?.empty(); this.message(e instanceof Error ? e.message : String(e)); }
		finally {
			this.busy = false;
			if (!this.disposed) { this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((input) => { input.disabled = false; }); this.drawActions(); }
		}
	}
	async refreshPreview(): Promise<void> {
		if (!this.backup) { this.message('Select a ZIP backup first.'); return; }
		const generation = ++this.generation;
		this.plan = null;
		this.message('Read source IDs and prepare the preview…');
		const plan = await this.plugin.prepare(this.backup, this.folder, this.mapping);
		if (this.disposed || generation !== this.generation) return;
		this.plan = plan;
		this.drawPreview(plan);
		this.message('Preview ready. Existing entries and file conflicts are skipped.');
		this.drawActions();
	}
	private drawPreview(plan: ImportPlan): void {
		const el = this.preview;
		if (!el) return;
		el.empty();
		const existing = plan.entries.filter((e) => e.existing).length;
		el.createEl('p', { cls: 'diaro-counts', text: `${plan.entries.length} entries · ${plan.backup.media.size} photos · ${plan.backup.missing.length} missing photos · ${existing} existing entries` });
		const table = el.createEl('table', { cls: 'diaro-table' });
		const header = table.createEl('thead').createEl('tr');
		for (const name of ['UTC date', 'Title', 'Folder', 'Tags', 'Photos']) header.createEl('th', { text: name });
		const body = table.createEl('tbody');
		for (const item of plan.entries.slice(0, 8)) {
			const row = body.createEl('tr');
			for (const value of [item.entry.day, item.entry.title || 'Untitled', item.entry.folder || '—', item.entry.tags.join(', ') || '—', String(item.entry.photos.length)]) row.createEl('td', { text: value });
		}
		if (plan.entries.length > 8) el.createEl('p', { text: `The table shows the first 8 of ${plan.entries.length} entries.` });
		this.list(el, 'Missing photos', plan.backup.missing);
		this.list(el, 'File conflicts', plan.conflicts);
		this.list(el, 'Source warnings', plan.backup.warnings);
	}
	private list(el: HTMLElement, title: string, values: string[]): void {
		if (!values.length) return;
		const details = el.createEl('details');
		details.createEl('summary', { text: `${title} (${values.length})` });
		const list = details.createEl('ul');
		for (const value of values.slice(0, 30)) list.createEl('li', { text: value });
		if (values.length > 30) list.createEl('li', { text: `${values.length - 30} more items.` });
	}
	updatePro(): void {
		const el = this.proControls;
		if (!el || this.disposed) return;
		el.empty();
		if (!isPro()) this.reviews = false;
		new Setting(el).setName(TEXT.reviews).setDesc('Create a review for each month in this import. Existing reviews are kept.').addToggle((t) => t.setValue(this.reviews).setDisabled(!isPro()).onChange((value) => { this.reviews = isPro() && value; }));
		const details = el.createEl('details');
		details.createEl('summary', { text: TEXT.presets });
		let name = '';
		new Setting(details).setName(TEXT.savePreset).addText((t) => t.setPlaceholder('Preset name').onChange((value) => { name = value; })).addButton((b) => b.setButtonText('Save preset').setDisabled(!isPro()).onClick(() => void this.run(async () => { validateMapping(this.mapping); if (await this.plugin.savePreset(name, this.mapping)) { this.updatePro(); new Notice('Mapping preset saved.'); } })));
		for (const preset of this.plugin.settings.presets) {
			new Setting(details).setName(preset.name).addButton((b) => b.setButtonText('Use preset').setDisabled(!isPro()).onClick(() => {
				if (!isPro()) return;
				this.mapping = { ...preset.mapping };
				// Reopen the modal to draw the loaded mapping without stale input values.
				this.plugin.settings.mapping = { ...preset.mapping };
				this.plugin.settings.folder = this.folder;
				const backup = this.backup ?? undefined;
				this.close(); this.plugin.openImport(backup);
			}));
		}
		this.drawActions();
	}
	private drawActions(): void {
		const el = this.actions;
		if (!el || this.disposed) return;
		el.empty();
		new Setting(el).addButton((b) => b.setButtonText('Preview').setDisabled(this.busy || !this.backup).onClick(() => void this.run(() => this.refreshPreview())))
			.addButton((b) => b.setButtonText(TEXT.compare).setDisabled(this.busy || !this.plan || !isPro()).onClick(() => {
				if (!isPro() || !this.plan) return;
				const c = comparePlan(this.plan);
				this.message(`${c.added.length} new · ${c.changed.length} changed · ${c.unchanged.length} unchanged · ${c.absent.length} absent from backup. Existing notes stay in place.`);
				const el = this.preview;
				if (el) { this.drawPreview(this.plan); this.list(el, 'Changed source IDs', c.changed); this.list(el, 'Absent source IDs', c.absent); }
			}))
			.addButton((b) => b.setButtonText('Create notes').setCta().setDisabled(this.busy || !this.plan || !this.plan.entries.length).onClick(() => void this.run(async () => {
				const plan = this.plan;
				if (!plan) return;
				const result = await this.plugin.importPlan(plan, this.reviews && isPro());
				this.plan = null;
				if (this.disposed) return;
				this.preview?.empty();
				this.message(`Import complete: ${result.created} notes created, ${result.skipped} skipped, ${result.photos} photos copied, ${result.reviews} reviews, ${result.errors.length} errors.`);
				if (this.preview) this.list(this.preview, 'Import errors', result.errors);
				const first = plan.entries.find((e) => !e.existing && !plan.conflicts.includes(e.path) && existingFile(this.app.vault, e.path));
				if (first) new Setting(this.preview ?? this.contentEl).setName('Read the imported journal').addButton((b) => b.setButtonText('Open first note').onClick(async () => { const f = existingFile(this.app.vault, first.path); if (f) { await this.app.workspace.getLeaf(false).openFile(f); this.close(); } }));
				this.plugin.settings.folder = plan.folder;
				this.plugin.settings.mapping = { ...plan.mapping };
				await this.plugin.saveSettings();
			})));
	}
	onClose(): void { this.disposed = true; this.generation++; this.contentEl.empty(); this.backup = null; this.plan = null; this.plugin.closed(this); }
}
