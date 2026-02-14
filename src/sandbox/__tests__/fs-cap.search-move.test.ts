import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsCapability } from '../fs-cap.js';

let rootDir: string;
let workspaceDir: string;

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), 'mama-fs-cap-search-'));
	workspaceDir = join(rootDir, 'workspace');
	mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe('fs-cap search/move actions', () => {
	it('search returns matching files under allowed directory', async () => {
		mkdirSync(join(workspaceDir, 'a'), { recursive: true });
		writeFileSync(join(workspaceDir, 'a', 'one.ts'), 'console.log(1)', 'utf-8');
		writeFileSync(join(workspaceDir, 'a', 'two.md'), '# hi', 'utf-8');

		const wsReal = realpathSync(workspaceDir);
		const cap = createFsCapability(
			{
				workspace: workspaceDir,
				allowedPaths: [],
				deniedPaths: [],
			},
			process.env.HOME ?? '/',
		);

		const result = await cap.execute('search', { path: workspaceDir, pattern: '*.ts' });
		expect(result.success).toBe(true);
		expect(result.output).toEqual([join(wsReal, 'a', 'one.ts')]);
	});

	it('move renames a file inside workspace', async () => {
		const source = join(workspaceDir, 'from.txt');
		const dest = join(workspaceDir, 'to.txt');
		writeFileSync(source, 'hello', 'utf-8');

		const cap = createFsCapability(
			{
				workspace: workspaceDir,
				allowedPaths: [],
				deniedPaths: [],
			},
			process.env.HOME ?? '/',
		);

		const result = await cap.execute('move', { sourcePath: source, destinationPath: dest });
		expect(result.success).toBe(true);
		expect(readFileSync(dest, 'utf-8')).toBe('hello');
	});
});
