import { browser, expect } from '@wdio/globals';
import data from '../../tests/vectors/diaro-backup-import.json';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type DiaroBackupImportPlugin from '../../src/main';
import type { SponsorsManager } from '../../src/license/index';
import { pluginId, reloadPlugin } from './load';

const fixture = Array.from(readFileSync('tests/fixtures/sample.zip'));
const photo = Array.from(readFileSync('tests/fixtures/garden.png'));
const vectors = data as unknown as { cases: { name:string;function?:string;args:string[];expected:unknown }[] };

async function closeModals(): Promise<void> {
	await browser.executeObsidian(({app}) => {
		const p=(app as unknown as {plugins:{plugins:Record<string,DiaroBackupImportPlugin>}}).plugins.plugins['diaro-backup-import']!;
		p.closeImportWindows();
	});
}
async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(async ({app},enabled)=>{
		const p=(app as unknown as {plugins:{plugins:Record<string,DiaroBackupImportPlugin>}}).plugins.plugins['diaro-backup-import']!;
		const pro=p.pro as SponsorsManager;
		if(!enabled){pro.signOut();return;}
		// Synthetic token store and HTTP answer. No network request or Keychain key.
		let token:string|null='gho_'+'0'.repeat(36);
		pro.opts.tokens.get=()=>token;pro.opts.tokens.set=(v)=>{token=v;};pro.opts.tokens.clear=()=>{token=null;};
		pro.opts.http=async()=>({status:200,json:{data:{viewer:{login:'demo-reader',totalSponsorshipAmountAsSponsorInCents:1500},user:{viewerIsSponsoring:true,sponsorshipForViewerAsSponsor:{isActive:true,isOneTimePayment:false,tier:{name:'$5 a month',monthlyPriceInCents:500}}}}}});
		await pro.refreshNow();
	},on);
}

describe('Diaro Backup Import in real Obsidian',function(){
	afterEach(async()=>{await closeModals();await setPro(false);});
	it('loads and reloads with no errors',async()=>{expect(await reloadPlugin(pluginId)).toEqual({enabled:true,reloaded:true,errors:[]});});
	it('runs the XML golden vectors with the browser XML parser',async()=>{
		for(const c of vectors.cases.filter(c=>!c.function)){
			const bytes=Array.from(zipSync({'DiaroBackup.xml':strToU8(c.args[0]!)}));
			const result=await browser.executeObsidian(({app},data)=>{
				const p=(app as unknown as {plugins:{plugins:Record<string,DiaroBackupImportPlugin>}}).plugins.plugins['diaro-backup-import']!;
				try { const b=p.readBackup(new Uint8Array(data));return JSON.stringify({entries:b.entries,warnings:b.warnings}); } catch(e) {return JSON.stringify({error:e instanceof Error?e.message:String(e)});}
			},bytes);
			expect(JSON.parse(result)).toEqual(c.expected);
		}
	});
	it('selects a local ZIP in the UI and creates notes with a local photo',async()=>{
		await browser.executeObsidian(({app})=>{
			const p=(app as unknown as {plugins:{plugins:Record<string,DiaroBackupImportPlugin>}}).plugins.plugins['diaro-backup-import']!;
			p.settings.folder='E2E journal';p.settings.mapping={noteName:'date-title',titleProperty:'title',folderProperty:'diaro_folder',moodProperty:'diaro_mood',tagsProperty:'tags'};
		});
		await browser.executeObsidianCommand(`${pluginId}:import-backup`);
		await browser.$('input[type="file"]').setValue(resolve('tests/fixtures/sample.zip'));
		await browser.waitUntil(async()=>(await browser.$('.diaro-status').getText()).includes('Preview ready'),{timeout:20000,timeoutMsg:'Import preview did not finish'});
		expect(await browser.$('.diaro-counts').getText()).toContain('3 entries');
		expect(await browser.$('.diaro-counts').getText()).toContain('1 missing photos');
		// Free users can select Compare backup: the select shows the Pro notice (test/e2e/pro-notice.e2e.ts).
		expect(await browser.$('button=Compare backup (Pro)').isEnabled()).toBe(true);
		await browser.$('button=Create notes').click();
		await browser.waitUntil(async()=>(await browser.$('.diaro-status').getText()).includes('3 notes created'),{timeout:20000,timeoutMsg:'Import did not finish'});
		const output=await browser.executeObsidian(async({app})=>{
			const notes=app.vault.getMarkdownFiles().filter(f=>f.path.startsWith('E2E journal/'));
			const first=notes.find(f=>f.path.includes('walk-01'))!;
			const img=app.vault.getFileByPath('E2E journal/attachments/garden.png')!;
			return {count:notes.length,text:await app.vault.read(first),photo:Array.from(new Uint8Array(await app.vault.readBinary(img)))};
		});
		expect(output.count).toBe(3);expect(output.text).toContain('diaro_uid: walk-01');expect(output.text).toContain('The garden was quiet after the rain.');
		expect(output.text).toContain('![[E2E journal/attachments/garden.png]]');expect(output.photo).toEqual(photo);
	});
	it('skips a repeat import and compares later source changes with Pro',async()=>{
		await setPro(true);
		const result=await browser.executeObsidian(async({app},data)=>{
			const p=(app as unknown as {plugins:{plugins:Record<string,DiaroBackupImportPlugin>}}).plugins.plugins['diaro-backup-import']!;
			const b=p.readBackup(new Uint8Array(data));
			const plan=await p.prepare(b,'E2E journal',p.settings.mapping);const result=await p.importPlan(plan);b.entries[0]!.text+=' Changed in later backup.';
			p.openImport(b);return result;
		},fixture);
		expect(result.created).toBe(0);expect(result.skipped).toBe(3);
		await browser.waitUntil(async()=>await browser.$('button=Compare backup (Pro)').isEnabled(),{timeout:20000});
		await browser.$('button=Compare backup (Pro)').click();
		expect(await browser.$('.diaro-status').getText()).toContain('1 changed');expect(await browser.$('.diaro-status').getText()).toContain('2 unchanged');
	});
	it('creates Pro monthly reviews and blocks review writes after sign out',async()=>{
		await setPro(true);
		const result=await browser.executeObsidian(async({app},data)=>{
			const p=(app as unknown as {plugins:{plugins:Record<string,DiaroBackupImportPlugin>}}).plugins.plugins['diaro-backup-import']!;
			const b=p.readBackup(new Uint8Array(data));const plan=await p.prepare(b,'E2E pro journal',p.settings.mapping);const result=await p.importPlan(plan,true);
			await p.savePreset('E2E mapping',{...p.settings.mapping,titleProperty:'subject'});
			const review=app.vault.getFileByPath('E2E pro journal/reviews/2024-09 Diaro review.md')!;
			p.pro!.signOut();let blocked='';try {await p.importPlan(plan,true);}catch(e){blocked=e instanceof Error?e.message:String(e);}
			return {result,review:await app.vault.read(review),presets:p.settings.presets.length,blocked};
		},fixture);
		expect(result.result.reviews).toBe(2);expect(result.review).toContain('2 journal entries.');expect(result.review).toContain('Morning garden walk');expect(result.presets).toBe(1);expect(result.blocked).toContain('need Pro');
	});
	it('shows an invalid backup error without creating notes',async()=>{
		await browser.executeObsidianCommand(`${pluginId}:import-backup`);
		await browser.$('input[type="file"]').setValue(resolve('tests/fixtures/sample.zip'));
		await browser.waitUntil(async()=>(await browser.$('.diaro-status').getText()).includes('Preview ready'),{timeout:20000});
		await browser.$('input[type="file"]').setValue(resolve('tests/fixtures/invalid.zip'));
		await browser.waitUntil(async()=>(await browser.$('.diaro-status').getText()).includes('Select a version 2'),{timeout:20000});
		expect(await browser.$('button=Create notes').isEnabled()).toBe(false);
		expect(await browser.$('button=Preview').isEnabled()).toBe(false);
	});
});
