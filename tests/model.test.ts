import { describe, expect, it } from 'vitest';
import { parseYaml } from 'obsidian';
import { cleanHtml, entryBody, DEFAULT_MAPPING, markdown, notePath, photoPath, safeFolder, sourceHash, validateMapping, monthlyReview, tagName } from '../src/model';
import { parseXml } from '../src/parser';
const entry = () => parseXml('<backup version="2"><table name="diaro_entries"><row><uid>a</uid><date>0</date><title>Tea: today</title><text>Line one\nLine two</text></row></table></backup>').entries[0]!;
describe('note conversion and mapping', () => {
	it('keeps long Unicode file names below 255 bytes', () => {
		const e = {...entry(), title: '旅行'.repeat(80), id: '日記'.repeat(60)};
		expect(new TextEncoder().encode(notePath(e, 'Journal', DEFAULT_MAPPING).split('/')[1]!).length).toBeLessThan(255);
	});
	it('makes numeric source tags valid and keeps the source label', () => { expect(tagName('123')).toBe('_123'); expect(tagName('旅行')).toBe('旅行'); });
	it('uses a stable ID suffix for same-day notes', () => {
		expect(notePath(entry(),'Journal',DEFAULT_MAPPING)).toBe('Journal/1970-01-01 Tea- today -- a.md');
		expect(notePath(entry(),'Journal',{...DEFAULT_MAPPING,noteName:'date-id'})).toBe('Journal/1970-01-01 -- a.md');
	});
	it('keeps the file extension on long photo names', () => { expect(photoPath(`media/photo/${'x'.repeat(140)}.PNG`,'Journal')).toBe(`Journal/attachments/${'x'.repeat(100)}.png`); });
	it('rejects vault parent steps, hidden folders, absolute paths and reserved names', () => {
		for (const value of ['', '../Journal','/Journal','A/../B','.obsidian','A\\B','A/CON']) expect(() => safeFolder(value)).toThrow();
		expect(safeFolder('Journal/Travel')).toBe('Journal/Travel');
	});
	it('rejects reserved and duplicate mapping properties', () => {
		expect(() => validateMapping({...DEFAULT_MAPPING,titleProperty:'diaro_uid'})).toThrow();
		expect(() => validateMapping({...DEFAULT_MAPPING,titleProperty:'tags'})).toThrow();
	});
	it('writes parseable YAML with original labels and remapped properties', () => {
		const e={...entry(),tags:['Family time','旅行'],folder:'Home',mood:'Calm'};
		const text=markdown(e,{...DEFAULT_MAPPING,titleProperty:'subject',folderProperty:'journal'},'hash',['Journal/attachments/garden.png'],['media/photo/missing.jpg']);
		const props=parseYaml(text.split('---')[1]!) as Record<string,unknown>;
		expect(props).toMatchObject({diaro_uid:'a',diaro_date:'0',diaro_tags:['Family time','旅行'],subject:'Tea: today',journal:'Home',tags:['Family-time','旅行']});
		expect(text).toContain('![[Journal/attachments/garden.png]]'); expect(text).toContain('Missing Diaro photos');
	});
	it('keeps plain text autolinks', () => { expect(entryBody('See <https://example.invalid>')).toBe('See <https://example.invalid>'); });
	it('keeps plain text lines', () => { expect(entryBody('First\nSecond\n\nThird')).toBe('First\nSecond\n\nThird'); });
	it('converts formatting and removes resource tags and active attributes', () => {
		const source='<p onclick="evil()" style="background:url(x)">Walk <strong>outside</strong><img src="https://example.invalid/photo"><iframe src="https://example.invalid/frame"></iframe></p><script>evil()</script>';
		expect(cleanHtml(source)).toBe('<p>Walk <strong>outside</strong></p>');
		expect(entryBody(source)).toContain('**outside**'); expect(entryBody(source)).not.toContain('example.invalid');
	});
	it('does not turn entity text into a raw HTML image', () => { expect(entryBody('<p>&lt;img src=x&gt;</p>')).not.toContain('<img'); });
	it('removes remote Markdown image embeds from plain source text', () => { expect(entryBody('A ![photo](https://example.invalid/photo) B')).toBe('A  B'); });
	it('source hashes change with text and photo bytes', async () => {
		const e={...entry(),photos:['media/photo/a.png']};
		const media=new Map([['media/photo/a.png',new Uint8Array([1,2])]]);
		const hash=await sourceHash(e,media);
		expect(hash).toHaveLength(64);
		expect(await sourceHash({...e,text:'Changed'},media)).not.toBe(hash);
		expect(await sourceHash(e,new Map([['media/photo/a.png',new Uint8Array([1,3])]]))).not.toBe(hash);
		expect(await sourceHash(e,media)).toBe(hash);
	});
	it('creates a dated review with sorted links and tags', () => {
		const text=monthlyReview('2024-09',[{day:'2024-09-02',title:'Tea',path:'Journal/Tea.md',tags:['Family']},{day:'2024-09-01',title:'Walk',path:'Journal/Walk.md',tags:['Family','Travel']}]);
		expect(text).toContain('2 journal entries.'); expect(text.indexOf('Walk.md')).toBeLessThan(text.indexOf('Tea.md')); expect(text).toContain('## Tags\n\n- Family\n- Travel');
	});
});
