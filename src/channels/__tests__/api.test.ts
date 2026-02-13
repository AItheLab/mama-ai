import { describe, expect, it, vi } from 'vitest';
import { createApiChannel, createApiRequestHandler } from '../api.js';

describe('createApiRequestHandler', () => {
	const agent = {
		processMessage: vi.fn(async () => ({
			content: 'ok',
			model: 'test-model',
			provider: 'test',
			tokenUsage: { input: 1, output: 1 },
			iterations: 1,
			toolCallsExecuted: 0,
		})),
	};
	const scheduler = {
		listJobs: vi.fn(async () => [
			{ id: 'job-1', name: 'job', schedule: '* * * * *', enabled: true },
		]),
		createJob: vi.fn(async () => 'job-2'),
	};
	const auditStore = {
		getRecent: vi.fn(() => [{ id: 'a1', action: 'read' }]),
	};

	const handler = createApiRequestHandler({
		token: 'secret',
		agent: agent as never,
		scheduler: scheduler as never,
		auditStore: auditStore as never,
		memorySearch: async (q: string) => `memory:${q}`,
		costSnapshot: () => ({
			todayCostUsd: 0.1,
			monthCostUsd: 1.2,
			totalCostUsd: 3.4,
			records: 2,
		}),
		statusSnapshot: () => ({ status: 'ok' }),
	});

	it('requires auth for all endpoints', async () => {
		const response = await handler({
			method: 'GET',
			pathname: '/api/status',
			searchParams: new URLSearchParams(),
			headers: {},
		});
		expect(response.status).toBe(401);
	});

	it('handles core endpoints and returns expected payloads', async () => {
		const headers = { authorization: 'Bearer secret' };

		const status = await handler({
			method: 'GET',
			pathname: '/api/status',
			searchParams: new URLSearchParams(),
			headers,
		});
		expect(status.status).toBe(200);

		const jobs = await handler({
			method: 'GET',
			pathname: '/api/jobs',
			searchParams: new URLSearchParams(),
			headers,
		});
		expect(jobs.status).toBe(200);
		expect(scheduler.listJobs).toHaveBeenCalled();

		const created = await handler({
			method: 'POST',
			pathname: '/api/jobs',
			searchParams: new URLSearchParams(),
			headers,
			body: JSON.stringify({ schedule: '*/5 * * * *', task: 'Do work' }),
		});
		expect(created.status).toBe(201);
		expect(scheduler.createJob).toHaveBeenCalled();

		const message = await handler({
			method: 'POST',
			pathname: '/api/message',
			searchParams: new URLSearchParams(),
			headers,
			body: JSON.stringify({ message: 'hello' }),
		});
		expect(message.status).toBe(200);
		expect(agent.processMessage).toHaveBeenCalledWith('hello', 'api');

		const memory = await handler({
			method: 'GET',
			pathname: '/api/memory/search',
			searchParams: new URLSearchParams('q=test'),
			headers,
		});
		expect(memory.status).toBe(200);
		expect(memory.body).toEqual({ result: 'memory:test' });
	});

	it('returns 404 for unknown routes', async () => {
		const response = await handler({
			method: 'GET',
			pathname: '/api/unknown',
			searchParams: new URLSearchParams(),
			headers: { authorization: 'Bearer secret' },
		});
		expect(response.status).toBe(404);
	});
});

describe('createApiChannel', () => {
	it('enforces localhost-only binding', () => {
		expect(() =>
			createApiChannel({
				host: '0.0.0.0',
				port: 3377,
				token: 'secret',
				agent: {
					processMessage: vi.fn(),
				} as never,
			}),
		).toThrow('localhost');
	});
});
