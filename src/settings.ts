import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { DEFAULT_MAPPING, safeFolder, validateMapping, type Mapping } from './model';
import { PRO_UI } from './pro';
import type DiaroBackupImportPlugin from './main';

export interface Preset { name: string; mapping: Mapping }
export interface DiaroBackupImportSettings { folder: string; mapping: Mapping; presets: Preset[] }
export const DEFAULT_SETTINGS: DiaroBackupImportSettings = { folder: 'Diaro import', mapping: { ...DEFAULT_MAPPING }, presets: [] };

function normalizeMapping(saved: unknown): Mapping {
	if (typeof saved !== 'object' || saved === null) return { ...DEFAULT_MAPPING };
	const row = saved as Partial<Mapping>;
	const mapping: Mapping = {
		noteName: row.noteName === 'date-id' ? 'date-id' : 'date-title',
		titleProperty: typeof row.titleProperty === 'string' ? row.titleProperty : DEFAULT_MAPPING.titleProperty,
		folderProperty: typeof row.folderProperty === 'string' ? row.folderProperty : DEFAULT_MAPPING.folderProperty,
		moodProperty: typeof row.moodProperty === 'string' ? row.moodProperty : DEFAULT_MAPPING.moodProperty,
		tagsProperty: typeof row.tagsProperty === 'string' ? row.tagsProperty : DEFAULT_MAPPING.tagsProperty,
	};
	try { validateMapping(mapping); return mapping; } catch { return { ...DEFAULT_MAPPING }; }
}
export function normalizeSettings(saved: unknown): DiaroBackupImportSettings {
	const s = typeof saved === 'object' && saved !== null ? saved as Partial<DiaroBackupImportSettings> : {};
	let folder = DEFAULT_SETTINGS.folder;
	try { if (typeof s.folder === 'string') folder = safeFolder(s.folder); } catch { /* Use the default folder. */ }
	const presets = Array.isArray(s.presets) ? s.presets.filter((p): p is Preset => typeof p === 'object' && p !== null && typeof p.name === 'string' && p.name.trim().length > 0).slice(0, 20).map((p) => ({ name: p.name.slice(0, 60), mapping: normalizeMapping(p.mapping) })) : [];
	return { folder, mapping: normalizeMapping(s.mapping), presets };
}
export class DiaroBackupImportSettingTab extends PluginSettingTab {
	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], readonly plugin: DiaroBackupImportPlugin) { super(app, plugin); }
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'Import folder', desc: 'Default folder for new notes, photos and reviews. You can change it in the import window.', control: { type: 'text', key: 'folder', defaultValue: DEFAULT_SETTINGS.folder } },
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
		];
	}
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'folder' && typeof value === 'string') { try { safeFolder(value); } catch { return; } }
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
	}
}
