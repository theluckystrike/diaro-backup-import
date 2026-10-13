export interface Entry {
	id: string;
	title: string;
	text: string;
	date: string;
	day: string;
	timeFields: Record<string, string>;
	folder: string;
	tags: string[];
	mood: string;
	location: Record<string, string>;
	photos: string[];
}
export interface Journal {
	entries: Entry[];
	warnings: string[];
}

const MAX_XML = 16 * 1024 * 1024;
const MAX_ENTRIES = 20000;

/** Check a relative archive path before the ZIP reader or the vault writer uses it. */
export function safeArchivePath(path: string): boolean {
	return path.length > 0 && !path.includes('\\') && !Array.from(path).some((c) => c.charCodeAt(0) < 32) && !path.startsWith('/') && !path.includes(':') && path.split('/').every((s) => s !== '..' && s !== '.');
}

/** Read the version 2 tables. No XML field is used to build a DOM element. */
export function parseXml(xml: string): Journal {
	if (xml.length > MAX_XML) throw new Error('The XML file exceeds 16 MiB.');
	if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML document types and entities are not supported.');
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	if (doc.querySelector('parsererror') || !doc.documentElement) throw new Error('The XML file is not valid.');
	const root = doc.documentElement;
	if (root.getAttribute('version') !== '2') throw new Error('Select a version 2 Diaro backup.');
	const tables = new Map<string, Record<string, string>[]>();
	for (const table of Array.from(root.children)) {
		if (table.tagName !== 'table') continue;
		const name = table.getAttribute('name') ?? '';
		if (tables.has(name)) throw new Error(`Duplicate table: ${name}.`);
		const rows: Record<string, string>[] = [];
		for (const item of Array.from(table.children)) {
			const fields: Record<string, string> = Object.create(null) as Record<string, string>;
			for (const field of Array.from(item.children)) {
				if (Object.prototype.hasOwnProperty.call(fields, field.tagName)) throw new Error(`Duplicate field: ${field.tagName}.`);
				fields[field.tagName] = field.textContent ?? '';
			}
			rows.push(fields);
		}
		tables.set(name, rows);
	}
	if (!tables.has('diaro_entries')) throw new Error('The backup has no diaro_entries table.');
	const warnings: string[] = [];
	function index(name: string): Map<string, Record<string, string>> {
		const result = new Map<string, Record<string, string>>();
		for (const row of tables.get(name) ?? []) {
			if (!row.uid) continue;
			if (result.has(row.uid)) throw new Error(`Duplicate ID in ${name}: ${row.uid}.`);
			result.set(row.uid, row);
		}
		return result;
	}
	const folders = index('diaro_folders');
	const tags = index('diaro_tags');
	const moods = index('diaro_moods');
	const locations = index('diaro_locations');
	const photos = new Map<string, string[]>();
	for (const row of tables.get('diaro_attachments') ?? []) {
		if (row.type !== 'photo') {
			warnings.push(`Attachment type not copied: ${row.type || '(empty)'}.`);
			continue;
		}
		const path = `media/photo/${row.filename ?? ''}`;
		if (!row.entry_uid || !row.filename || !safeArchivePath(path) || !/\.(jpe?g|png|gif|webp|heic|heif)$/i.test(path)) {
			throw new Error('A photo record has an unsafe path or unsupported file type.');
		}
		photos.set(row.entry_uid, [...(photos.get(row.entry_uid) ?? []), path]);
	}
	const rows = tables.get('diaro_entries') ?? [];
	if (rows.length > MAX_ENTRIES) throw new Error('The backup exceeds 20000 entries.');
	const ids = new Set<string>();
	const entries = rows.map((row): Entry => {
		const id = row.uid?.trim() ?? '';
		if (!id || id.length > 1000) throw new Error('An entry has no valid source ID.');
		if (ids.has(id)) throw new Error(`Duplicate entry ID: ${id}.`);
		ids.add(id);
		const date = row.date ?? '';
		const n = Number(date);
		if (!/^-?\d+$/.test(date) || !Number.isSafeInteger(n) || !Number.isFinite(new Date(n).getTime())) throw new Error(`Entry ${id} has an invalid date.`);
		const day = new Date(n).toISOString().slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Entry ${id} has a date outside years 0000 to 9999.`);
		const resolve = (map: Map<string, Record<string, string>>, value: string | undefined, label: string): string => {
			if (!value) return '';
			const match = map.get(value.trim());
			if (!match) warnings.push(`Entry ${id}: missing ${label} ID ${value}.`);
			return match?.title ?? '';
		};
		// Some Diaro versions keep a mood value in the entry row. Use its title when a mood row has that ID.
		const moodValue = (value: string | undefined): string => value?.trim() ? moods.get(value.trim())?.title ?? value.trim() : '';
		const tagTitles = [...new Set((row.tags ?? '').split(',').map((t) => resolve(tags, t.trim(), 'tag')).filter(Boolean))];
		const timeFields = Object.fromEntries(Object.entries(row).filter(([key]) => /date|time|tz|offset/i.test(key)));
		const location = locations.get(row.location_uid ?? '') ?? {};
		if (row.location_uid && !locations.has(row.location_uid)) warnings.push(`Entry ${id}: missing location ID ${row.location_uid}.`);
		return {
			id, title: row.title ?? '', text: row.text ?? '', date, day, timeFields,
			folder: resolve(folders, row.folder_uid, 'folder'), tags: tagTitles,
			mood: row.mood_uid ? resolve(moods, row.mood_uid, 'mood') : moodValue(row.mood), location: { ...location },
			photos: [...new Set(photos.get(id) ?? [])],
		};
	});
	for (const id of photos.keys()) if (!ids.has(id)) warnings.push(`Photo record has no entry: ${id}.`);
	return { entries, warnings };
}

/** A stable public result for golden acceptance vectors, including rejection cases. */
export function inspectXml(xml: string): Journal | { error: string } {
	try { return parseXml(xml); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
