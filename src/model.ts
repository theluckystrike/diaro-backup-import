import { htmlToMarkdown, normalizePath, stringifyYaml } from 'obsidian';
import type { Entry } from './parser';

export interface Mapping {
	noteName: 'date-title' | 'date-id';
	titleProperty: string;
	folderProperty: string;
	moodProperty: string;
	tagsProperty: string;
}
export const DEFAULT_MAPPING: Mapping = { noteName: 'date-title', titleProperty: 'title', folderProperty: 'diaro_folder', moodProperty: 'diaro_mood', tagsProperty: 'tags' };

export function validProperty(key: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(key) && !['diaro_uid', 'diaro_date', 'diaro_time_fields', 'diaro_source_hash', 'diaro_location', 'diaro_tags', '__proto__', 'constructor', 'prototype'].includes(key);
}
export function validateMapping(mapping: Mapping): void {
	const keys = [mapping.titleProperty, mapping.folderProperty, mapping.moodProperty, mapping.tagsProperty];
	if (keys.some((key) => !validProperty(key)) || new Set(keys).size !== keys.length) throw new Error('Use four different property names. Start each with a letter. Source properties are reserved.');
}
export function safeSegment(value: string, limit = 80): string {
	const normalized = Array.from(value.normalize('NFC')).map((c) => c.charCodeAt(0) < 32 ? '-' : c).join('').replace(/[\\/:*?"<>|[\]#^]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
	// Count UTF-8 bytes so a title plus an ID stays below a file name byte limit.
	let s = '';
	let length = 0;
	for (const char of normalized) {
		const size = new TextEncoder().encode(char).length;
		if (length + size > limit) break;
		s += char; length += size;
	}
	s = s.replace(/[. ]+$/g, '');
	const clean = s || 'Untitled';
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
}
export function safeFolder(value: string): string {
	if (!value.trim() || (/[\\:*?"<>|]/.test(value) || Array.from(value).some((c) => c.charCodeAt(0) < 32))) throw new Error('Use a relative vault folder path.');
	const path = normalizePath(value.trim());
	if (!path || value.trim().startsWith('/') || path.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.') || part !== safeSegment(part, 120))) throw new Error('Use a relative vault folder path without hidden folders or parent steps.');
	return path;
}
export function notePath(entry: Entry, folder: string, mapping: Mapping): string {
	const title = mapping.noteName === 'date-title' && entry.title.trim() ? ` ${safeSegment(entry.title)}` : '';
	return normalizePath(`${safeFolder(folder)}/${entry.day}${title} -- ${safeSegment(entry.id, 60)}.md`);
}
export function photoPath(source: string, folder: string): string {
	const parts = source.split('/').slice(2).map((p, i, rows) => {
		if (i !== rows.length - 1) return safeSegment(p, 100);
		const dot = p.lastIndexOf('.');
		return `${safeSegment(p.slice(0, dot), 100)}${p.slice(dot).toLowerCase()}`;
	});
	return normalizePath(`${safeFolder(folder)}/attachments/${parts.join('/')}`);
}

export function cleanHtml(text: string): string {
	const allowed = new Set('p div span strong b em i u s del br hr h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code a table thead tbody tr th td'.split(' '));
	const clean = text.replace(/<(script|style|iframe|object|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
	return clean.replace(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi, (tag: string, closing: string, raw: string) => {
		const name = raw.toLowerCase();
		if (!allowed.has(name)) return '';
		if (closing) return `</${name}>`;
		if (name !== 'a') return `<${name}>`;
		const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		const href = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
		// Keep web links and relative links only. Encoded schemes are removed below by the DOM check.
		if (!/^(?:https?:|\/|#|\.?\.?\/)/i.test(href)) return '<a>';
		return `<a href="${href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`;
	});
}

/** Convert HTML without executing it or retaining source image requests. */
export function entryBody(text: string): string {
	if (!/<\/?[a-z][a-z0-9-]*(?=[\s/>])[^>]*>/i.test(text)) return text.replace(/!\[[^\]]*\]\([^\n]*?\)/g, '').replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');
	const html = cleanHtml(text);
	// Text with inline tags only keeps its source line breaks.
	const blocks = /<(?:p|div|br|hr|h[1-6]|ul|ol|li|blockquote|pre|table)>/i.test(html);
	const doc = new DOMParser().parseFromString(blocks ? html : html.replace(/\r?\n/g, '<br>'), 'text/html');
	for (const node of Array.from(doc.querySelectorAll('script, style, iframe, object, embed, img, link, meta, audio, video, source'))) node.remove();
	for (const link of Array.from(doc.querySelectorAll('a'))) if (/^\s*(?:javascript|data|vbscript):/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.parentElement?.closest('pre,code')) node.nodeValue = (node.nodeValue ?? '').replace(/\uE000/g, '').replace(/<(?=[a-z/!?])/gi, '\uE000');
	}
	return htmlToMarkdown(doc.body).replace(/\uE000/g, '&lt;').trim();
}
export function tagName(tag: string): string {
	const value = tag.trim().replace(/[^\p{L}\p{N}_/-]/gu, '-').replace(/^\/+|\/+$/g, '');
	return /^\p{N}+$/u.test(value) ? `_${value}` : value;
}
export function markdown(entry: Entry, mapping: Mapping, hash: string, images: string[], missing: string[]): string {
	validateMapping(mapping);
	const props: Record<string, unknown> = {
		diaro_uid: entry.id, diaro_date: entry.date, diaro_time_fields: entry.timeFields,
		diaro_source_hash: hash, diaro_tags: entry.tags,
		[mapping.titleProperty]: entry.title || 'Untitled', [mapping.folderProperty]: entry.folder,
		[mapping.moodProperty]: entry.mood,
		[mapping.tagsProperty]: [...new Set(entry.tags.map(tagName).filter(Boolean))],
	};
	if (Object.keys(entry.location).length) props.diaro_location = entry.location;
	const embeds = images.map((path) => `![[${path}]]`).join('\n');
	const warnings = missing.length ? `\n\n> Missing Diaro photos: ${missing.map((s) => safeSegment(s, 120)).join(', ')}.` : '';
	return `---\n${stringifyYaml(props).trimEnd()}\n---\n\n${entryBody(entry.text)}${embeds ? `\n\n${embeds}` : ''}${warnings}\n`;
}

/** Hash source fields and photo bytes, independent of output mapping and ZIP ordering. */
export async function sourceHash(entry: Entry, media: Map<string, Uint8Array>): Promise<string> {
	const photos: [string, string][] = [];
	for (const path of [...entry.photos].sort()) {
		const bytes = media.get(path);
		photos.push([path, bytes ? await digest(bytes) : 'missing']);
	}
	const stable = { ...entry, timeFields: Object.fromEntries(Object.entries(entry.timeFields).sort()), location: Object.fromEntries(Object.entries(entry.location).sort()), photos };
	return digest(new TextEncoder().encode(JSON.stringify(stable)));
}
async function digest(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
	return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}
export interface Existing { id: string; hash: string; path: string }
export interface Comparison { added: string[]; changed: string[]; unchanged: string[]; absent: string[] }
export function compareSources(incoming: Existing[], existing: Existing[]): Comparison {
	const old = new Map(existing.map((e) => [e.id, e]));
	const ids = new Set(incoming.map((e) => e.id));
	const result: Comparison = { added: [], changed: [], unchanged: [], absent: [] };
	for (const entry of incoming) {
		const previous = old.get(entry.id);
		if (!previous) result.added.push(entry.id);
		else if (previous.hash === entry.hash) result.unchanged.push(entry.id);
		else result.changed.push(entry.id);
	}
	result.absent = existing.filter((e) => !ids.has(e.id)).map((e) => e.id);
	return result;
}
export function monthlyReview(month: string, entries: { day: string; title: string; path: string; tags: string[] }[]): string {
	const rows = [...entries].sort((a, b) => a.day.localeCompare(b.day) || a.path.localeCompare(b.path));
	const tags = [...new Set(rows.flatMap((e) => e.tags))].sort();
	return `# ${month} Diaro review\n\n${rows.length} journal entries.\n\n${rows.map((e) => `- ${e.day}: [[${e.path}|${safeSegment(e.title)}]]`).join('\n')}\n\n## Tags\n\n${tags.map((t) => `- ${safeSegment(t)}`).join('\n') || 'No tags.'}\n`;
}
