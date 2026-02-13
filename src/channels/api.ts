import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { createAgent } from '../core/agent.js';
import type { createAuditStore } from '../sandbox/audit.js';
import type { CronScheduler } from '../scheduler/cron.js';
import { createLogger } from '../utils/logger.js';
import type { Channel } from './types.js';

const logger = createLogger('channel:api');

interface ApiRequest {
	method: string;
	pathname: string;
	searchParams: URLSearchParams;
	headers: Record<string, string | undefined>;
	body?: string;
}

interface ApiResponse {
	status: number;
	body: unknown;
}

interface ApiCostSnapshot {
	todayCostUsd: number;
	monthCostUsd: number;
	totalCostUsd: number;
	records: number;
}

interface ApiChannelOptions {
	host: string;
	port: number;
	token?: string;
	agent: ReturnType<typeof createAgent>;
	scheduler?: CronScheduler;
	auditStore?: ReturnType<typeof createAuditStore>;
	memorySearch?: (query: string) => Promise<string>;
	costSnapshot?: () => ApiCostSnapshot;
	statusSnapshot?: () => Promise<unknown> | unknown;
}

interface ApiChannel extends Channel {
	name: 'api';
	getToken(): string;
	getPort(): number | null;
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.statusCode = statusCode;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}

function parseJsonBody(body: string | undefined): Record<string, unknown> {
	if (!body) return {};
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed && typeof parsed === 'object') {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

function extractBearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (!trimmed.startsWith('Bearer ')) return null;
	return trimmed.slice(7).trim();
}

function isLocalhostHost(host: string): boolean {
	return host === '127.0.0.1' || host === 'localhost';
}

export function createApiRequestHandler(options: {
	token: string;
	agent: ReturnType<typeof createAgent>;
	scheduler?: CronScheduler;
	auditStore?: ReturnType<typeof createAuditStore>;
	memorySearch?: (query: string) => Promise<string>;
	costSnapshot?: () => ApiCostSnapshot;
	statusSnapshot?: () => Promise<unknown> | unknown;
}) {
	return async function handle(request: ApiRequest): Promise<ApiResponse> {
		const authToken = extractBearerToken(request.headers.authorization);
		if (authToken !== options.token) {
			return { status: 401, body: { error: 'Unauthorized' } };
		}

		if (request.method === 'POST' && request.pathname === '/api/message') {
			const body = parseJsonBody(request.body);
			const message = String(body.message ?? '').trim();
			if (!message) {
				return { status: 400, body: { error: 'message is required' } };
			}
			const response = await options.agent.processMessage(message, 'api');
			return {
				status: 200,
				body: {
					content: response.content,
					model: response.model,
					provider: response.provider,
				},
			};
		}

		if (request.method === 'GET' && request.pathname === '/api/status') {
			const status = (typeof options.statusSnapshot === 'function' &&
				(await options.statusSnapshot())) || {
				status: 'ok',
			};
			return { status: 200, body: status };
		}

		if (request.method === 'GET' && request.pathname === '/api/jobs') {
			const jobs = options.scheduler ? await options.scheduler.listJobs() : [];
			return { status: 200, body: { jobs } };
		}

		if (request.method === 'POST' && request.pathname === '/api/jobs') {
			if (!options.scheduler) {
				return { status: 503, body: { error: 'Scheduler unavailable' } };
			}
			const body = parseJsonBody(request.body);
			const schedule = String(body.schedule ?? '').trim();
			const task = String(body.task ?? '').trim();
			const name = typeof body.name === 'string' ? body.name : undefined;
			if (!schedule || !task) {
				return { status: 400, body: { error: 'schedule and task are required' } };
			}
			const id = await options.scheduler.createJob({ name, schedule, task });
			return { status: 201, body: { id } };
		}

		if (request.method === 'GET' && request.pathname === '/api/audit') {
			if (!options.auditStore) {
				return { status: 503, body: { error: 'Audit store unavailable' } };
			}
			const limitRaw = request.searchParams.get('limit');
			const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw ?? '20', 10) || 20));
			const entries = options.auditStore.getRecent(limit);
			return { status: 200, body: { entries } };
		}

		if (request.method === 'GET' && request.pathname === '/api/memory/search') {
			if (!options.memorySearch) {
				return { status: 503, body: { error: 'Memory search unavailable' } };
			}
			const q = request.searchParams.get('q')?.trim() ?? '';
			if (!q) {
				return { status: 400, body: { error: 'q is required' } };
			}
			const result = await options.memorySearch(q);
			return { status: 200, body: { result } };
		}

		if (request.method === 'GET' && request.pathname === '/api/cost') {
			if (!options.costSnapshot) {
				return { status: 503, body: { error: 'Cost tracker unavailable' } };
			}
			return { status: 200, body: options.costSnapshot() };
		}

		return { status: 404, body: { error: 'Not found' } };
	};
}

export function createApiChannel(options: ApiChannelOptions): ApiChannel {
	if (!isLocalhostHost(options.host)) {
		throw new Error('API channel must bind to localhost (127.0.0.1 or localhost).');
	}

	const token = options.token?.trim() ? options.token : randomUUID();
	const handler = createApiRequestHandler({
		token,
		agent: options.agent,
		scheduler: options.scheduler,
		auditStore: options.auditStore,
		memorySearch: options.memorySearch,
		costSnapshot: options.costSnapshot,
		statusSnapshot: options.statusSnapshot,
	});
	let server: Server | null = null;
	let boundPort: number | null = null;

	return {
		name: 'api',
		async start(): Promise<void> {
			server = createServer(async (req, res) => {
				try {
					if (!req.url || !req.method) {
						json(res, 404, { error: 'Not found' });
						return;
					}
					const parsed = new URL(req.url, `http://${options.host}:${options.port}`);
					const response = await handler({
						method: req.method,
						pathname: parsed.pathname,
						searchParams: parsed.searchParams,
						headers: {
							authorization: req.headers.authorization,
						},
						body: await readBody(req),
					});
					json(res, response.status, response.body);
				} catch (error) {
					json(res, 500, {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});

			await new Promise<void>((resolve, reject) => {
				server?.once('error', reject);
				server?.listen(options.port, options.host, () => {
					const address = server?.address();
					if (address && typeof address !== 'string') {
						boundPort = address.port;
					}
					resolve();
				});
			});

			logger.info('API channel started', {
				host: options.host,
				port: boundPort ?? options.port,
			});
		},
		async stop(): Promise<void> {
			if (!server) return;
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			server = null;
			boundPort = null;
			logger.info('API channel stopped');
		},
		getToken(): string {
			return token;
		},
		getPort(): number | null {
			return boundPort;
		},
	};
}

export type { ApiChannel, ApiChannelOptions, ApiCostSnapshot, ApiRequest, ApiResponse };
