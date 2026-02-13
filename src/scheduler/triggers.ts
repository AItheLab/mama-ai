import { type FSWatcher, watch } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createLogger } from '../utils/logger.js';
import type { JobRunResult } from './types.js';

const logger = createLogger('scheduler:triggers');

type FileWatcherEvent = 'add' | 'change' | 'unlink' | 'rename';

interface FileWatcherConfig {
	path: string;
	events: FileWatcherEvent[];
	task: string;
}

interface WebhookHookConfig {
	id: string;
	token: string;
	task: string;
}

interface WebhookConfig {
	enabled: boolean;
	host?: string;
	port: number;
	hooks: WebhookHookConfig[];
}

interface TriggerTaskContext {
	source: 'file_watcher' | 'webhook';
	watcherPath?: string;
	filename?: string;
	hookId?: string;
	payload?: unknown;
}

interface WatcherLike {
	close(): void;
}

type WatchFactory = (
	path: string,
	listener: (eventType: string, filename: string | Buffer | null) => void,
) => WatcherLike;

interface CreateTriggerEngineOptions {
	fileWatchers?: FileWatcherConfig[];
	webhooks?: WebhookConfig;
	runTask: (task: string, context: TriggerTaskContext) => Promise<JobRunResult | undefined>;
	watchFactory?: WatchFactory;
}

interface TriggerEngine {
	start(): Promise<void>;
	stop(): Promise<void>;
	getWebhookPort(): number | null;
}

interface WebhookDispatchRequest {
	method: string;
	url: string;
	authorizationHeader?: string;
	body: string;
}

interface WebhookDispatchResponse {
	status: number;
	body: { error?: string; accepted?: boolean };
}

function eventMatches(eventType: string, configured: FileWatcherEvent[]): boolean {
	if (eventType === 'change') {
		return configured.includes('change');
	}
	if (eventType === 'rename') {
		return (
			configured.includes('add') || configured.includes('unlink') || configured.includes('rename')
		);
	}
	return false;
}

function fillTemplate(template: string, values: Record<string, string>): string {
	let output = template;
	for (const [key, value] of Object.entries(values)) {
		output = output.replaceAll(`{${key}}`, value);
	}
	return output;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf-8');
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.statusCode = statusCode;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(payload));
}

function defaultWatchFactory(
	path: string,
	listener: (eventType: string, filename: string | Buffer | null) => void,
): WatcherLike {
	return watch(path, listener) as FSWatcher;
}

function parsePayload(body: string): unknown {
	if (!body) return {};
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

export function createWebhookRequestHandler(options: {
	hooks: WebhookHookConfig[];
	runTask: (task: string, context: TriggerTaskContext) => Promise<JobRunResult | undefined>;
}) {
	const hookMap = new Map(options.hooks.map((hook) => [hook.id, hook]));

	return async function handle(request: WebhookDispatchRequest): Promise<WebhookDispatchResponse> {
		if (request.method !== 'POST') {
			return { status: 404, body: { error: 'Not found' } };
		}
		const match = request.url.match(/^\/hooks\/([a-zA-Z0-9_-]+)$/);
		if (!match?.[1]) {
			return { status: 404, body: { error: 'Not found' } };
		}

		const hookId = match[1];
		const hook = hookMap.get(hookId);
		if (!hook) {
			return { status: 404, body: { error: 'Unknown hook' } };
		}

		const header = request.authorizationHeader ?? '';
		const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
		if (!token || token !== hook.token) {
			return { status: 401, body: { error: 'Unauthorized' } };
		}

		const payload = parsePayload(request.body);
		const task = fillTemplate(hook.task, {
			payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
		});
		void options.runTask(task, {
			source: 'webhook',
			hookId,
			payload,
		});
		return { status: 202, body: { accepted: true } };
	};
}

export function createTriggerEngine(options: CreateTriggerEngineOptions): TriggerEngine {
	const watchers: WatcherLike[] = [];
	const watchFactory = options.watchFactory ?? defaultWatchFactory;
	let server: Server | null = null;
	let webhookPort: number | null = null;

	function startFileWatchers(): void {
		for (const watcherConfig of options.fileWatchers ?? []) {
			try {
				const watcher = watchFactory(watcherConfig.path, (eventType, filename) => {
					if (!eventMatches(eventType, watcherConfig.events)) return;
					const fileNameValue = filename?.toString() ?? '';
					const task = fillTemplate(watcherConfig.task, {
						filename: fileNameValue,
						event: eventType,
						path: watcherConfig.path,
					});
					void options
						.runTask(task, {
							source: 'file_watcher',
							watcherPath: watcherConfig.path,
							filename: fileNameValue,
						})
						.catch((error) => {
							logger.error('File watcher trigger failed', {
								path: watcherConfig.path,
								error: error instanceof Error ? error.message : String(error),
							});
						});
				});
				watchers.push(watcher);
			} catch (error) {
				logger.warn('File watcher could not be started', {
					path: watcherConfig.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	function startWebhookServer(webhooks: WebhookConfig): Promise<void> {
		if (!webhooks.enabled) return Promise.resolve();

		const handler = createWebhookRequestHandler({
			hooks: webhooks.hooks,
			runTask: options.runTask,
		});

		server = createServer(async (req, res) => {
			try {
				if (!req.url || !req.method) {
					json(res, 404, { error: 'Not found' });
					return;
				}
				const body = await readBody(req);
				const result = await handler({
					method: req.method,
					url: req.url,
					authorizationHeader: req.headers.authorization,
					body,
				});
				json(res, result.status, result.body);
			} catch (error) {
				json(res, 500, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});

		return new Promise<void>((resolve, reject) => {
			server?.once('error', reject);
			server?.listen(webhooks.port, webhooks.host ?? '127.0.0.1', () => {
				const address = server?.address();
				if (address && typeof address !== 'string') {
					webhookPort = address.port;
				}
				resolve();
			});
		});
	}

	async function start(): Promise<void> {
		startFileWatchers();
		if (options.webhooks) {
			await startWebhookServer(options.webhooks);
		}
	}

	async function stop(): Promise<void> {
		for (const watcher of watchers) {
			watcher.close();
		}
		watchers.length = 0;

		if (server) {
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}

		server = null;
		webhookPort = null;
	}

	return {
		start,
		stop,
		getWebhookPort: () => webhookPort,
	};
}

export type {
	CreateTriggerEngineOptions,
	FileWatcherConfig,
	FileWatcherEvent,
	TriggerEngine,
	TriggerTaskContext,
	WebhookConfig,
	WebhookDispatchRequest,
	WebhookDispatchResponse,
	WebhookHookConfig,
	WatcherLike,
	WatchFactory,
};
