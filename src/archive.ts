import { strFromU8, unzipSync } from 'fflate';
import { parseXml, safeArchivePath, type Journal } from './parser';

export interface Backup extends Journal {
	media: Map<string, Uint8Array>;
	missing: string[];
}
export const MAX_ZIP = 64 * 1024 * 1024;

interface Member { name: string; size: number; crc: number }

/** Read the central directory before expansion. Reject encryption and duplicate names. */
function members(bytes: Uint8Array): Member[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
		if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
	}
	if (end < 0) throw new Error('ZIP central directory not found.');
	if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Split ZIP files are not supported.');
	const count = view.getUint16(end + 10, true);
	let cursor = view.getUint32(end + 16, true);
	const directoryEnd = cursor + view.getUint32(end + 12, true);
	if (count > 25000 || count !== view.getUint16(end + 8, true) || directoryEnd > end) throw new Error('Invalid or oversized ZIP directory.');
	const result: Member[] = [];
	const names = new Set<string>();
	for (let i = 0; i < count; i++) {
		if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid ZIP member.');
		if (view.getUint16(cursor + 8, true) & 1) throw new Error('Encrypted ZIP backups are not supported.');
		const length = view.getUint16(cursor + 28, true);
		const next = cursor + 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
		if (next > directoryEnd) throw new Error('Invalid ZIP member length.');
		const name = strFromU8(bytes.subarray(cursor + 46, cursor + 46 + length));
		if (names.has(name)) throw new Error('Duplicate ZIP member names are not supported.');
		if (!safeArchivePath(name)) throw new Error('The ZIP file has an unsafe path.');
		names.add(name);
		const size = view.getUint32(cursor + 24, true);
		if (size === 0xffffffff) throw new Error('ZIP64 backups are not supported.');
		result.push({ name, size, crc: view.getUint32(cursor + 16, true) });
		cursor = next;
	}
	if (cursor !== directoryEnd) throw new Error('Invalid ZIP directory size.');
	return result;
}
const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
	let value = i;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
	return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 255] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}

/** Open only the XML and photo files. Reject unsafe names and bounded expansion. */
export function readBackup(bytes: Uint8Array): Backup {
	if (bytes.length > MAX_ZIP) throw new Error('The ZIP file exceeds 64 MiB.');
	let total = 0;
	let count = 0;
	let files: Record<string, Uint8Array>;
	let index: Member[];
	try {
		index = members(bytes);
		files = unzipSync(bytes, { filter: (file) => {
			if (++count > 25000) throw new Error('The ZIP file exceeds 25000 files.');
			if (!safeArchivePath(file.name)) throw new Error('The ZIP file has an unsafe path.');
			const keep = file.name === 'DiaroBackup.xml' || /^media\/photo\/.+\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name);
			if (!keep) return false;
			total += file.originalSize;
			if (file.originalSize > 32 * 1024 * 1024 || total > 128 * 1024 * 1024) throw new Error('The expanded backup exceeds the size limit.');
			return true;
		} });
	} catch (e) {
		throw new Error(`Cannot read the ZIP backup. Use an unencrypted ZIP. ${e instanceof Error ? e.message : String(e)}`);
	}
	for (const member of index) {
		const data = files[member.name];
		if (data && (data.length !== member.size || crc32(data) !== member.crc)) throw new Error(`ZIP checksum failed: ${member.name}.`);
	}
	const xml = files['DiaroBackup.xml'];
	if (!xml) throw new Error('The ZIP root must contain DiaroBackup.xml.');
	const journal = parseXml(strFromU8(xml));
	const media = new Map<string, Uint8Array>();
	const missing = new Set<string>();
	for (const entry of journal.entries) for (const photo of entry.photos) {
		const data = files[photo];
		if (data) media.set(photo, data); else missing.add(photo);
	}
	return { ...journal, media, missing: [...missing].sort() };
}
