import data from './vectors/diaro-backup-import.json';
import { describe, it, expect } from 'vitest';
import { inspectXml } from '../src/parser';
import { safeSegment, compareSources } from '../src/model';
const vectors = data as { cases: { name: string; function?: string; args: unknown[]; expected: unknown }[] };
describe('golden acceptance vectors', () => {
	// happy-dom has no XML CDATA support. The real Electron test runs this vector.
	for (const c of vectors.cases) (c.name === 'CDATA retains source HTML' ? it.skip : it)(c.name, () => {
		const functions: Record<string, (...args: never[]) => unknown> = { inspectXml, safeSegment, compareSources };
		expect(functions[c.function ?? 'inspectXml']!(...c.args as never[])).toEqual(c.expected);
	});
});
