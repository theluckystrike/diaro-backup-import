import { browser, expect } from '@wdio/globals';
import { resolve } from 'node:path';
import type DiaroBackupImportPlugin from '../../src/main';
import type { SponsorsManager } from '../../src/license/index';
import { pluginId } from './load';

// A free user can select the Pro controls of the import window. The select shows the shared Pro notice with the
// "Sponsor on GitHub" button. The review toggle shows off again, no comparison runs and no preset is saved.
// A Pro user turns the same toggle on and compares the backup.
type Host = { plugins: { plugins: Record<string, DiaroBackupImportPlugin> } };
const LEADS = ['Monthly review notes need Pro.', 'Saved mapping presets need Pro.', 'Backup comparison needs Pro.'];

async function setPro(on: boolean): Promise<boolean> {
	return browser.executeObsidian(async ({ app }, enabled) => {
		const p = (app as unknown as Host).plugins.plugins['diaro-backup-import']!;
		const pro = p.pro as SponsorsManager;
		if (!enabled) { pro.signOut(); return pro.isPro(); }
		// Synthetic token store and HTTP answer. No network request or Keychain key.
		let token: string | null = 'gho_' + '0'.repeat(36);
		pro.opts.tokens.get = () => token; pro.opts.tokens.set = (v) => { token = v; }; pro.opts.tokens.clear = () => { token = null; };
		pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader', totalSponsorshipAmountAsSponsorInCents: 1500 }, user: { viewerIsSponsoring: true, sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
		await pro.refreshNow();
		return pro.isPro();
	}, on);
}

async function openWindow(): Promise<void> {
	await browser.executeObsidian(() => { activeDocument.querySelectorAll('.notice').forEach((n) => n.remove()); });
	await browser.executeObsidianCommand(`${pluginId}:import-backup`);
	await browser.$('input[type="file"]').setValue(resolve('tests/fixtures/sample.zip'));
	await browser.waitUntil(async () => (await browser.$('.diaro-status').getText()).includes('Preview ready'), { timeout: 20000, timeoutMsg: 'Import preview did not finish' });
}

/** Selects the review toggle and then the buttons, and returns the toggle state, the notices, the status and the settings. */
async function select(toggle: boolean, buttons: string[]) {
	return browser.executeObsidian(async ({ app }, toggle, buttons) => {
		const root = activeDocument.querySelector('.diaro-import-modal')!;
		const row = () => [...root.querySelectorAll('.setting-item')].find((r) => r.querySelector('.setting-item-name')?.textContent === 'Monthly review notes (Pro)');
		if (toggle) (row()?.querySelector('.checkbox-container') as HTMLElement | null)?.click();
		for (const text of buttons) [...root.querySelectorAll('button')].find((b) => b.textContent === text)?.click();
		await new Promise((r) => setTimeout(r, 300));
		const p = (app as unknown as Host).plugins.plugins['diaro-backup-import']!;
		return {
			on: row()?.querySelector('.checkbox-container')?.classList.contains('is-enabled') ?? null,
			notices: [...activeDocument.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', sponsor: n.querySelectorAll('.pf-pro-notice-sponsor').length })),
			status: root.querySelector('.diaro-status')?.textContent ?? '',
			settings: JSON.stringify(p.settings),
			saved: JSON.stringify((await p.loadData()) ?? {}),
		};
	}, toggle, buttons);
}

describe('Pro controls of the import window', function () {
	afterEach(async () => {
		await browser.executeObsidian(({ app }) => { (app as unknown as Host).plugins.plugins['diaro-backup-import']!.closeImportWindows(); });
		await setPro(false);
	});

	it('a free user who selects Monthly review notes, Save preset or Compare backup gets the Pro notice with a Sponsor button, and nothing runs or saves', async () => {
		expect(await setPro(false)).toBe(false);
		await openWindow();
		const before = await select(false, []);
		const after = await select(true, ['Save preset', 'Compare backup (Pro)']);
		for (const lead of LEADS) {
			if (!after.notices.some((n) => n.text.includes(lead) && n.sponsor === 1)) throw new Error(`No Pro notice with "${lead}": ${JSON.stringify(after.notices)}`);
		}
		expect(after.on).toBe(false);
		expect(after.status).toBe(before.status);
		expect(after.settings).toBe(before.settings);
		expect(after.saved).toBe(before.saved);
	});

	it('a Pro user who selects Monthly review notes and Compare backup turns reviews on and compares', async () => {
		expect(await setPro(true)).toBe(true);
		await openWindow();
		const after = await select(true, ['Compare backup (Pro)']);
		expect(after.on).toBe(true);
		expect(after.status).toContain('unchanged');
		expect(after.notices.filter((n) => n.sponsor > 0)).toEqual([]);
	});
});
