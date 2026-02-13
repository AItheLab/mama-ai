#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);

function copyDir(sourceRelative, targetRelative) {
	const source = join(projectRoot, sourceRelative);
	const target = join(projectRoot, targetRelative);
	if (!existsSync(source)) return;

	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true, force: true });
}

copyDir('src/memory/migrations', 'dist/migrations');
copyDir('src/skills/built-in', 'dist/built-in');
