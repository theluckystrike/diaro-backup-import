import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { MAX_ZIP, readBackup } from '../src/archive';
import { parseXml } from '../src/parser';
const xml = readFileSync('tests/fixtures/DiaroBackup.xml', 'utf8');
const zip = () => new Uint8Array(readFileSync('tests/fixtures/sample.zip'));
describe('local ZIP backup', () => {
	it('joins three entries and lists a missing photo before writing', () => {
		const b = readBackup(zip());
		expect(b.entries).toHaveLength(3);
		expect(b.media.size).toBe(1);
		expect(b.missing).toEqual(['media/photo/coast.jpg']);
		expect(b.media.get('media/photo/garden.png')).toEqual(new Uint8Array(readFileSync('tests/fixtures/garden.png')));
	});
	it('rejects missing XML and a nested backup root', () => {
		expect(() => readBackup(zipSync({ 'Folder/DiaroBackup.xml': strToU8(xml) }))).toThrow('ZIP root');
	});
	it('rejects random bytes', () => { expect(() => readBackup(new Uint8Array([1,2,3]))).toThrow('Cannot read'); });
	it('rejects parent steps and absolute paths before expansion', () => {
		for (const name of ['../photo.jpg','/photo.jpg','media/photo/../../photo.jpg','media\\photo\\photo.jpg']) expect(() => readBackup(zipSync({ 'DiaroBackup.xml': strToU8(xml), [name]: new Uint8Array([1]) }))).toThrow('unsafe path');
	});
	it('rejects encrypted ZIP flags', () => {
		const bytes = zip(); const v = new DataView(bytes.buffer);
		for (let i=0;i<bytes.length-46;i++) if (v.getUint32(i,true) === 0x02014b50) { v.setUint16(i+8,v.getUint16(i+8,true)|1,true); break; }
		expect(() => readBackup(bytes)).toThrow('Encrypted');
	});
	it('rejects a checksum mismatch', () => {
		const bytes = zip(); const v = new DataView(bytes.buffer);
		for (let i=0;i<bytes.length-46;i++) if (v.getUint32(i,true) === 0x02014b50) { v.setUint32(i+16,0,true); break; }
		expect(() => readBackup(bytes)).toThrow('checksum');
	});
	it('rejects files that exceed the ZIP limit', () => { expect(() => readBackup(new Uint8Array(MAX_ZIP+1))).toThrow('64 MiB'); });
	it('rejects a member with an excessive declared expansion', () => {
		const bytes = zip(); const v = new DataView(bytes.buffer);
		for (let i=0;i<bytes.length-46;i++) if (v.getUint32(i,true) === 0x02014b50) { v.setUint32(i+24,33*1024*1024,true); break; }
		expect(() => readBackup(bytes)).toThrow('size limit');
	});
	it('ignores non photo ZIP files and macOS sidecars', () => {
		const b = readBackup(zipSync({ 'DiaroBackup.xml': strToU8(xml), '__MACOSX/._DiaroBackup.xml': new Uint8Array([1]), 'media/audio/voice.mp3': new Uint8Array([1]) }));
		expect(b.entries).toHaveLength(3); expect(b.media.size).toBe(0);
	});
	it('rejects an XML document above its size bound', () => { expect(() => parseXml(' '.repeat(16*1024*1024+1))).toThrow('16 MiB'); });
});
