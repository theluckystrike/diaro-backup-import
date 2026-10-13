import { TFile, TFolder, normalizePath, parseYaml, type Vault } from 'obsidian';
import type { Backup } from './archive';
import type { Entry } from './parser';
import { compareSources, markdown, monthlyReview, notePath, photoPath, safeFolder, sourceHash, validateMapping, type Comparison, type Existing, type Mapping } from './model';

export interface PlannedEntry { entry: Entry; path: string; hash: string; existing: string | null }
export interface ImportPlan {
	backup: Backup;
	folder: string;
	mapping: Mapping;
	entries: PlannedEntry[];
	existing: Existing[];
	conflicts: string[];
}
export interface ImportResult { created: number; skipped: number; photos: number; reviews: number; errors: string[] }

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function folderExists(vault: Vault, folder: string): Promise<void> {
	let current = '';
	for (const part of folder.split('/')) {
		current = normalizePath(current ? `${current}/${part}` : part);
		const found = vault.getAbstractFileByPath(current);
		if (found && !(found instanceof TFolder)) throw new Error(`A file blocks folder ${current}.`);
		if (!found) await vault.createFolder(current);
	}
}

/** Read source IDs in the destination folder. Cache timing does not affect this scan. */
export async function findExisting(vault: Vault, folder: string): Promise<Existing[]> {
	const result: Existing[] = [];
	for (const file of vault.getMarkdownFiles()) {
		if (!file.path.startsWith(`${folder}/`) || file.path.startsWith(`${folder}/reviews/`)) continue;
		const text = await vault.cachedRead(file);
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		if (!match) continue;
		let props: unknown;
		try { props = parseYaml(match[1] ?? ''); } catch { continue; }
		if (typeof props !== 'object' || props === null) continue;
		const row = props as Record<string, unknown>;
		if (typeof row.diaro_uid === 'string') result.push({ id: row.diaro_uid, hash: typeof row.diaro_source_hash === 'string' ? row.diaro_source_hash : '', path: file.path });
	}
	return result;
}

export async function prepareImport(vault: Vault, backup: Backup, folderInput: string, mapping: Mapping): Promise<ImportPlan> {
	const folder = safeFolder(folderInput);
	validateMapping(mapping);
	const existing = await findExisting(vault, folder);
	const old = new Map(existing.map((e) => [e.id, e.path]));
	const entries: PlannedEntry[] = [];
	const paths = new Set<string>();
	const conflicts = new Set<string>();
	const checkParents = (path: string) => {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			const parent = parts.slice(0, i).join('/');
			const found = vault.getAbstractFileByPath(parent);
			if (found && !(found instanceof TFolder)) conflicts.add(parent);
		}
	};
	const photoPaths = new Map<string, string>();
	for (const entry of backup.entries) {
		const path = notePath(entry, folder, mapping);
		const key = path.toLocaleLowerCase();
		if (paths.has(key)) throw new Error('Two entries have the same safe output path. Change the note name format or use another backup.');
		paths.add(key);
		checkParents(path);
		if (!old.has(entry.id) && vault.getAbstractFileByPath(path)) conflicts.add(path);
		for (const source of entry.photos) {
			if (!backup.media.has(source)) continue;
			const target = photoPath(source, folder);
			const lower = target.toLocaleLowerCase();
			const other = photoPaths.get(lower);
			if (other && other !== source) throw new Error('Two photo names have the same safe output path.');
			photoPaths.set(lower, source);
			checkParents(target);
			if (!old.has(entry.id)) {
				const file = vault.getAbstractFileByPath(target);
				if (file && (!(file instanceof TFile) || !sameBytes(new Uint8Array(await vault.readBinary(file)), backup.media.get(source) ?? new Uint8Array()))) conflicts.add(target);
			}
		}
		entries.push({ entry, path, hash: await sourceHash(entry, backup.media), existing: old.get(entry.id) ?? null });
	}
	return { backup, folder, mapping: { ...mapping }, entries, existing, conflicts: [...conflicts].sort() };
}
export function comparePlan(plan: ImportPlan): Comparison {
	return compareSources(plan.entries.map((e) => ({ id: e.entry.id, hash: e.hash, path: e.path })), plan.existing);
}

/** Create new files only. Recheck IDs and paths at import time. Keep an error count after a partial failure. */
export async function writeImport(vault: Vault, plan: ImportPlan, reviews: boolean): Promise<ImportResult> {
	const result: ImportResult = { created: 0, skipped: 0, photos: 0, reviews: 0, errors: [] };
	const ids = new Set((await findExisting(vault, plan.folder)).map((e) => e.id));
	const copied = new Map<string, string>();
	const imported: { day: string; title: string; path: string; tags: string[] }[] = [];
	for (const item of plan.entries) {
		if (ids.has(item.entry.id) || vault.getAbstractFileByPath(item.path) || plan.conflicts.some((path) => item.path === path || item.path.startsWith(`${path}/`) || item.entry.photos.some((source) => photoPath(source, plan.folder) === path || photoPath(source, plan.folder).startsWith(`${path}/`)))) { result.skipped++; continue; }
		try {
			await folderExists(vault, plan.folder);
			const images: string[] = [];
			for (const source of item.entry.photos) {
				const bytes = plan.backup.media.get(source);
				if (!bytes) continue;
				const path = photoPath(source, plan.folder);
				if (!copied.has(source)) {
					const file = vault.getAbstractFileByPath(path);
					if (file) {
						if (!(file instanceof TFile) || !sameBytes(new Uint8Array(await vault.readBinary(file)), bytes)) throw new Error(`A different file exists at photo path ${path}.`);
					} else {
						await folderExists(vault, path.slice(0, path.lastIndexOf('/')));
						await vault.createBinary(path, new Uint8Array(bytes).buffer);
						result.photos++;
					}
					copied.set(source, path);
				}
				images.push(path);
			}
			const missing = item.entry.photos.filter((source) => !plan.backup.media.has(source));
			await vault.create(item.path, markdown(item.entry, plan.mapping, item.hash, images, missing), { ctime: Number(item.entry.date), mtime: Number(item.entry.date) });
			ids.add(item.entry.id);
			result.created++;
			imported.push({ ...item.entry, path: item.path });
		} catch (e) { result.errors.push(`${item.entry.id}: ${e instanceof Error ? e.message : String(e)}`); }
	}
	if (reviews && imported.length) {
		const months = [...new Set(imported.map((e) => e.day.slice(0, 7)))].sort();
		for (const month of months) {
			const path = normalizePath(`${plan.folder}/reviews/${month} Diaro review.md`);
			try {
				if (vault.getAbstractFileByPath(path)) { result.errors.push(`Review already exists: ${path}.`); continue; }
				await folderExists(vault, `${plan.folder}/reviews`);
				await vault.create(path, monthlyReview(month, imported.filter((e) => e.day.startsWith(month))));
				result.reviews++;
			} catch (e) { result.errors.push(`Review ${month}: ${e instanceof Error ? e.message : String(e)}`); }
		}
	}
	return result;
}

export function existingFile(vault: Vault, path: string): TFile | null {
	const file = vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}
