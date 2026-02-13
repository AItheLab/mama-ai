import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsCapability } from '../fs-cap.js';

let rootDir: string;
let workspaceDir: string;
let outsideDir: string;

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), 'mama-fs-cap-'));
	workspaceDir = join(rootDir, 'workspace');
	outsideDir = join(rootDir, 'outside');
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe('fs-cap security hardening', () => {
	it('denies workspace symlink escapes', () => {
		const secretPath = join(outsideDir, 'secret.txt');
		writeFileSync(secretPath, 'top-secret', 'utf-8');
		symlinkSync(outsideDir, join(workspaceDir, 'link'));

		const cap = createFsCapability(
			{
				workspace: workspaceDir,
				allowedPaths: [],
				deniedPaths: [],
			},
			process.env.HOME ?? '/',
		);

		const decision = cap.checkPermission({
			capability: 'filesystem',
			action: 'read',
			resource: join(workspaceDir, 'link', 'secret.txt'),
			requestedBy: 'test',
		});

		expect(decision.allowed).toBe(false);
	});

	it('requires explicit approval token for ask-level rules', async () => {
		const sharedDir = join(rootDir, 'shared');
		mkdirSync(sharedDir, { recursive: true });

		const cap = createFsCapability(
			{
				workspace: workspaceDir,
				allowedPaths: [
					{
						path: join(realpathSync(sharedDir), '**'),
						actions: ['write'],
						level: 'ask',
					},
				],
				deniedPaths: [],
			},
			process.env.HOME ?? '/',
		);

		const targetPath = join(sharedDir, 'note.txt');
		const deniedResult = await cap.execute('write', {
			path: targetPath,
			content: 'hello',
		});
		expect(deniedResult.success).toBe(false);
		expect(deniedResult.error).toContain('Missing explicit user approval token');

		const approvedResult = await cap.execute('write', {
			path: targetPath,
			content: 'hello',
			__approvedByUser: true,
		});
		expect(approvedResult.success).toBe(true);
		expect(existsSync(targetPath)).toBe(true);
	});
});
