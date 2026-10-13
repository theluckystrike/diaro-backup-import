import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian-test-mocks/obsidian';
import DiaroBackupImportPlugin from '../src/main';
import { readBackup } from '../src/archive';
import { prepareImport, writeImport, comparePlan } from '../src/importer';
import { DEFAULT_MAPPING } from '../src/model';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import { bindPro, resetPro, SPONSORS } from '../src/pro';
import manifest from '../manifest.json';
const fixture=()=>readBackup(new Uint8Array(readFileSync('tests/fixtures/sample.zip')));
function setup(files: Record<string,string>={}) { const app=App.createConfigured__({files});const plugin=new DiaroBackupImportPlugin(app as never,manifest as never);return {app,plugin}; }
function pro(value:boolean) { bindPro({isPro:()=>value,onChange:()=>()=>undefined} as never); }
afterEach(()=>resetPro());
describe('vault import and Pro access',()=>{
	it('loads and repairs saved settings',async()=>{const {plugin}=setup();await plugin.loadSettings();expect(plugin.settings).toEqual(DEFAULT_SETTINGS);expect(normalizeSettings({folder:'../x',mapping:{titleProperty:'diaro_uid'}})).toEqual(DEFAULT_SETTINGS);expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);});
	it('previews without writing and imports exact photo bytes and source metadata',async()=>{
		const {app,plugin}=setup();const plan=await plugin.prepare(fixture(),'Journal',DEFAULT_MAPPING);expect(app.vault.getFiles()).toHaveLength(0);
		const r=await plugin.importPlan(plan);expect(r).toEqual({created:3,skipped:0,photos:1,reviews:0,errors:[]});
		const file=app.vault.getAbstractFileByPath(plan.entries[0]!.path) as TFile;const text=await app.vault.read(file);
		expect(text).toContain('diaro_uid: walk-01');expect(text).toContain('diaro_mood: Calm');expect(text).toContain('![[Journal/attachments/garden.png]]');
		const photo=app.vault.getAbstractFileByPath('Journal/attachments/garden.png') as TFile;expect(new Uint8Array(await app.vault.readBinary(photo))).toEqual(fixture().media.get('media/photo/garden.png'));
	});
	it('repeat imports skip source IDs and keep edited notes',async()=>{
		const {app,plugin}=setup();const plan=await plugin.prepare(fixture(),'Journal',DEFAULT_MAPPING);await plugin.importPlan(plan);
		const f=app.vault.getAbstractFileByPath(plan.entries[0]!.path) as TFile;const before=await app.vault.read(f);await app.vault.modify(f,before+'\nMy local edit.');
		const next=await plugin.prepare(fixture(),'Journal',DEFAULT_MAPPING);expect(next.entries.filter(e=>e.existing)).toHaveLength(3);expect((await plugin.importPlan(next)).skipped).toBe(3);expect(await app.vault.read(f)).toContain('My local edit.');
	});
	it('free import reports and skips existing note paths',async()=>{
		const {app}=setup({'Journal/2024-09-01 Morning garden walk -- walk-01.md':'Keep me'});const plan=await prepareImport(app.vault as never,fixture(),'Journal',DEFAULT_MAPPING);expect(plan.conflicts).toHaveLength(1);
		const r=await writeImport(app.vault as never,plan,false);expect(r.skipped).toBe(1);expect(r.created).toBe(2);expect(await app.vault.read(app.vault.getAbstractFileByPath(plan.conflicts[0]!) as TFile)).toBe('Keep me');
	});
	it('a parent file prevents writes and is shown in preview',async()=>{
		const {app}=setup({'Journal':'Keep me'});const plan=await prepareImport(app.vault as never,fixture(),'Journal',DEFAULT_MAPPING);expect(plan.conflicts).toContain('Journal');const r=await writeImport(app.vault as never,plan,false);expect(r.created).toBe(0);expect(r.skipped).toBe(3);expect(app.vault.getFiles()).toHaveLength(1);
	});
	it('different existing photo bytes skip the affected entry',async()=>{
		const {app}=setup();await app.vault.createFolder('Journal');await app.vault.createFolder('Journal/attachments');await app.vault.createBinary('Journal/attachments/garden.png',new Uint8Array([1,2,3]).buffer);const plan=await prepareImport(app.vault as never,fixture(),'Journal',DEFAULT_MAPPING);expect(plan.conflicts).toContain('Journal/attachments/garden.png');const r=await writeImport(app.vault as never,plan,false);expect(r.skipped).toBe(1);expect(r.photos).toBe(0);
	});
	it('identical existing photos can be reused for a later entry',async()=>{
		const {app,plugin}=setup();const backup=fixture();await plugin.importPlan(await plugin.prepare(backup,'Journal',DEFAULT_MAPPING));
		backup.entries=[{...backup.entries[0]!,id:'new-id',title:'Later walk'}];const plan=await plugin.prepare(backup,'Journal',DEFAULT_MAPPING);expect(plan.conflicts).toEqual([]);const r=await plugin.importPlan(plan);expect(r.created).toBe(1);expect(r.photos).toBe(0);
	});
	it('source comparison ignores local note edits and finds later backup changes',async()=>{
		const {plugin}=setup();const backup=fixture();await plugin.importPlan(await plugin.prepare(backup,'Journal',DEFAULT_MAPPING));
		backup.entries[0]!.text+=' New source text.';backup.entries.pop();const c=comparePlan(await plugin.prepare(backup,'Journal',DEFAULT_MAPPING));expect(c).toEqual({added:[],changed:['walk-01'],unchanged:['tea-02'],absent:['train-03']});
	});
	it('monthly reviews are blocked without Pro at execution',async()=>{const {plugin}=setup();const plan=await plugin.prepare(fixture(),'Journal',DEFAULT_MAPPING);await expect(plugin.importPlan(plan,true)).rejects.toThrow('need Pro');});
	it('Pro creates monthly reviews and saves mapping presets',async()=>{
		pro(true);const {app,plugin}=setup();const plan=await plugin.prepare(fixture(),'Journal',DEFAULT_MAPPING);expect((await plugin.importPlan(plan,true)).reviews).toBe(2);
		expect(app.vault.getAbstractFileByPath('Journal/reviews/2024-09 Diaro review.md')).toBeInstanceOf(TFile);
		expect(await plugin.savePreset('Journal',{...DEFAULT_MAPPING,titleProperty:'subject'})).toBe(true);expect(plugin.settings.presets).toHaveLength(1);
	});
	it('saved presets are blocked after Pro turns off',async()=>{const {plugin}=setup();pro(true);await plugin.savePreset('One',DEFAULT_MAPPING);pro(false);expect(await plugin.savePreset('Two',DEFAULT_MAPPING)).toBe(false);expect(plugin.settings.presets).toHaveLength(1);});
	it('partial write errors report counts and a later import can reuse a copied photo',async()=>{
		const {app,plugin}=setup();const plan=await plugin.prepare(fixture(),'Journal',DEFAULT_MAPPING);const spy=vi.spyOn(app.vault,'create').mockRejectedValueOnce(new Error('Disk full'));const result=await plugin.importPlan(plan);expect(result.errors[0]).toContain('Disk full');expect(result.created).toBe(2);expect(result.photos).toBe(1);spy.mockRestore();expect((await plugin.importPlan(await plugin.prepare(fixture(),'Journal',DEFAULT_MAPPING))).created).toBe(1);
	});
	it('same-day safe output collisions are rejected before writes',async()=>{
		const {app,plugin}=setup();const b=fixture();b.entries=[{...b.entries[0]!,id:'a/b'},{...b.entries[0]!,id:'a:b'}];await expect(plugin.prepare(b,'Journal',DEFAULT_MAPPING)).rejects.toThrow('same safe output path');expect(app.vault.getFiles()).toHaveLength(0);
	});
	it('Sponsors config matches the reference',()=>{expect(SPONSORS).toMatchObject({clientId:'Ov23lic5UPGPZqhBlBGg',sponsorLogin:'theluckystrike',minMonthlyUsd:5,oneTimeUsd:15,oneTimeMonths:0,scope:'read:user'});});
});
