import { describe, expect, it, vi } from 'vitest';
import { createTriggerEngine, createWebhookRequestHandler } from '../triggers.js';

describe('createTriggerEngine', () => {
	it('detects file watcher events and triggers agent task', async () => {
		const listeners: Array<(eventType: string, filename: string | Buffer | null) => void> = [];
		const runTask = vi.fn(async () => ({ success: true }));
		const engine = createTriggerEngine({
			fileWatchers: [
				{
					path: '/tmp/downloads',
					events: ['add'],
					task: 'A new file was downloaded: {filename}',
				},
			],
			watchFactory: (_path, listener) => {
				listeners.push(listener);
				return { close() {} };
			},
			runTask,
		});

		await engine.start();
		listeners[0]?.('rename', 'new-file.pdf');
		await Promise.resolve();
		await engine.stop();

		const [task, context] = runTask.mock.calls[0] ?? [];
		expect(String(task)).toContain('new-file.pdf');
		expect(context).toMatchObject({
			source: 'file_watcher',
			watcherPath: '/tmp/downloads',
			filename: 'new-file.pdf',
		});
	});
});

describe('createWebhookRequestHandler', () => {
	it('validates bearer token and dispatches webhook tasks', async () => {
		const runTask = vi.fn(async () => ({ success: true }));
		const handle = createWebhookRequestHandler({
			hooks: [
				{
					id: 'github',
					token: 'secret-token',
					task: 'Process webhook payload: {payload}',
				},
			],
			runTask,
		});

		const denied = await handle({
			method: 'POST',
			url: '/hooks/github',
			authorizationHeader: '',
			body: '{"action":"push"}',
		});
		expect(denied.status).toBe(401);

		const accepted = await handle({
			method: 'POST',
			url: '/hooks/github',
			authorizationHeader: 'Bearer secret-token',
			body: '{"action":"push"}',
		});
		expect(accepted.status).toBe(202);
		expect(runTask).toHaveBeenCalledTimes(1);
		const [task, context] = runTask.mock.calls[0] ?? [];
		expect(String(task)).toContain('"action":"push"');
		expect(context).toMatchObject({
			source: 'webhook',
			hookId: 'github',
		});
	});
});
