import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { createAgent } from '../core/agent.js';
import type { createAuditStore } from '../sandbox/audit.js';
import type { ApprovalRequest } from '../sandbox/types.js';
import type { CronScheduler } from '../scheduler/cron.js';
import { createLogger } from '../utils/logger.js';
import { redactSecrets } from '../utils/secret-redaction.js';
import type { Channel } from './types.js';

const logger = createLogger('channel:telegram');

const TELEGRAM_MESSAGE_LIMIT = 4096;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const MAX_TELEGRAM_DOCUMENT_BYTES = 256 * 1024;

type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

interface TelegramIncomingMessage {
	chatId: number;
	fromId: number;
	text?: string;
	document?: {
		fileName: string;
		content: string;
	};
	voice?: boolean;
}

interface TelegramCallback {
	chatId: number;
	fromId: number;
	data: string;
}

interface TelegramAdapter {
	start(handlers: {
		onMessage: (message: TelegramIncomingMessage) => Promise<void>;
		onCallback: (callback: TelegramCallback) => Promise<void>;
	}): Promise<void>;
	stop(): Promise<void>;
	sendMessage(
		chatId: number,
		text: string,
		options?: {
			parseMode?: 'Markdown';
			disableNotification?: boolean;
			replyMarkup?: {
				inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
			};
		},
	): Promise<void>;
}

interface ApprovalCapableSandbox {
	setApprovalHandler(handler: (request: ApprovalRequest) => Promise<boolean>): void;
}

interface TelegramCostSnapshot {
	todayCostUsd: number;
	monthCostUsd: number;
	totalCostUsd: number;
}

interface TelegramChannelOptions {
	token: string;
	allowedUserIds: number[];
	workspacePath: string;
	agent: ReturnType<typeof createAgent>;
	adapter: TelegramAdapter;
	sandbox?: ApprovalCapableSandbox;
	scheduler?: CronScheduler;
	auditStore?: ReturnType<typeof createAuditStore>;
	memorySearch?: (query: string) => Promise<string>;
	costSnapshot?: () => TelegramCostSnapshot;
	statusSnapshot?: () => Promise<string> | string;
}

interface PendingApproval {
	id: string;
	chatId: number;
	resolve: (approved: boolean) => void;
	timeout: NodeJS.Timeout;
	key: string;
}

interface TelegramChannel extends Channel {
	name: 'telegram';
	handleIncoming(message: TelegramIncomingMessage): Promise<void>;
	handleCallback(callback: TelegramCallback): Promise<void>;
	sendProactiveMessage(
		chatId: number,
		text: string,
		priority?: NotificationPriority,
	): Promise<void>;
}

function splitMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
	if (text.length <= limit) return [text];
	const lines = text.split('\n');
	const chunks: string[] = [];
	let current = '';
	for (const line of lines) {
		if (line.length > limit) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			for (let i = 0; i < line.length; i += limit) {
				chunks.push(line.slice(i, i + limit));
			}
			continue;
		}
		if ((current + (current ? '\n' : '') + line).length > limit) {
			if (current) chunks.push(current);
			current = line;
			continue;
		}
		current = current ? `${current}\n${line}` : line;
	}
	if (current) chunks.push(current);
	return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}

function approvalKey(request: ApprovalRequest): string {
	return `${request.capability}:${request.action}:${request.resource}`;
}

function isAuthorized(allowedUserIds: number[], fromId: number): boolean {
	return allowedUserIds.includes(fromId);
}

function renderApprovalMessage(request: ApprovalRequest): string {
	return [
		'🔒 Permission Request',
		`Action: ${request.capability}:${request.action}`,
		`Path/Resource: ${redactSecrets(request.resource)}`,
	].join('\n');
}

function normalizeDocumentName(fileName: string): string {
	return basename(fileName).replace(/[^\w.-]/g, '_');
}

async function sendChunked(
	adapter: TelegramAdapter,
	chatId: number,
	text: string,
	options: { markdown?: boolean; disableNotification?: boolean } = {},
): Promise<void> {
	const chunks = splitMessage(redactSecrets(text));
	for (const chunk of chunks) {
		await adapter.sendMessage(chatId, chunk, {
			parseMode: options.markdown ? 'Markdown' : undefined,
			disableNotification: options.disableNotification,
		});
	}
}

export function createTelegramChannel(options: TelegramChannelOptions): TelegramChannel {
	const pendingById = new Map<string, PendingApproval>();
	const alwaysApproved = new Set<string>();
	const chatByUser = new Map<number, number>();

	async function handleIncoming(message: TelegramIncomingMessage): Promise<void> {
		if (!isAuthorized(options.allowedUserIds, message.fromId)) {
			return;
		}
		chatByUser.set(message.fromId, message.chatId);

		if (message.voice) {
			await sendChunked(
				options.adapter,
				message.chatId,
				'Voice messages are not supported yet. Please send text for now.',
			);
			return;
		}

		if (message.document) {
			mkdirSync(options.workspacePath, { recursive: true });
			const fileName = normalizeDocumentName(message.document.fileName);
			const targetPath = join(options.workspacePath, fileName);
			writeFileSync(targetPath, message.document.content, 'utf-8');
			const response = await options.agent.processMessage(
				`A document was uploaded to ${targetPath}. Please review and process it.`,
				'telegram',
			);
			await sendChunked(options.adapter, message.chatId, response.content, { markdown: true });
			return;
		}

		const text = message.text?.trim() ?? '';
		if (!text) return;

		if (text.startsWith('/')) {
			await handleCommand(message.chatId, text);
			return;
		}

		const response = await options.agent.processMessage(text, 'telegram');
		await sendChunked(options.adapter, message.chatId, response.content, { markdown: true });
	}

	async function handleCommand(chatId: number, input: string): Promise<void> {
		const [command, ...args] = input.trim().split(/\s+/);

		switch (command) {
			case '/status': {
				const status =
					(typeof options.statusSnapshot === 'function' && (await options.statusSnapshot())) ||
					'Mama is running.';
				await sendChunked(options.adapter, chatId, String(status));
				return;
			}
			case '/jobs': {
				if (!options.scheduler) {
					await sendChunked(options.adapter, chatId, 'Scheduler is not enabled.');
					return;
				}
				const jobs = await options.scheduler.listJobs();
				if (jobs.length === 0) {
					await sendChunked(options.adapter, chatId, 'No scheduled jobs.');
					return;
				}
				const lines = jobs.map(
					(job) =>
						`- ${job.id} | ${job.enabled ? 'enabled' : 'disabled'} | ${job.schedule} | ${job.name}`,
				);
				await sendChunked(options.adapter, chatId, lines.join('\n'));
				return;
			}
			case '/audit': {
				if (!options.auditStore) {
					await sendChunked(options.adapter, chatId, 'Audit store is not available.');
					return;
				}
				const entries = options.auditStore.getRecent(10);
				const lines = entries.map(
					(entry) =>
						`- ${entry.timestamp.toISOString()} ${entry.capability}:${entry.action} ${entry.result}`,
				);
				await sendChunked(options.adapter, chatId, lines.join('\n') || 'No audit entries.');
				return;
			}
			case '/cost': {
				if (!options.costSnapshot) {
					await sendChunked(options.adapter, chatId, 'Cost tracker is not available.');
					return;
				}
				const cost = options.costSnapshot();
				await sendChunked(
					options.adapter,
					chatId,
					[
						`Today: $${cost.todayCostUsd.toFixed(4)}`,
						`This month: $${cost.monthCostUsd.toFixed(4)}`,
						`Total: $${cost.totalCostUsd.toFixed(4)}`,
					].join('\n'),
				);
				return;
			}
			case '/memory': {
				if (!options.memorySearch) {
					await sendChunked(options.adapter, chatId, 'Memory search is not available.');
					return;
				}
				const query = args.join(' ').trim();
				if (!query) {
					await sendChunked(options.adapter, chatId, 'Usage: /memory <query>');
					return;
				}
				const result = await options.memorySearch(query);
				await sendChunked(options.adapter, chatId, result);
				return;
			}
			default:
				await sendChunked(options.adapter, chatId, `Unknown command: ${command}`);
		}
	}

	async function handleCallback(callback: TelegramCallback): Promise<void> {
		if (!isAuthorized(options.allowedUserIds, callback.fromId)) {
			return;
		}
		const [action, approvalId] = callback.data.split(':');
		if (!approvalId) return;
		const pending = pendingById.get(approvalId);
		if (!pending) return;

		clearTimeout(pending.timeout);
		pendingById.delete(approvalId);

		if (action === 'always') {
			alwaysApproved.add(pending.key);
			pending.resolve(true);
			await sendChunked(options.adapter, callback.chatId, 'Approved and stored as always allow.');
			return;
		}

		const approved = action === 'approve';
		pending.resolve(approved);
		await sendChunked(options.adapter, callback.chatId, approved ? 'Approved.' : 'Denied.');
	}

	async function sendProactiveMessage(
		chatId: number,
		text: string,
		priority: NotificationPriority = 'normal',
	): Promise<void> {
		if (priority === 'urgent') {
			for (let i = 0; i < 2; i++) {
				await sendChunked(options.adapter, chatId, text);
			}
			return;
		}
		const disableNotification = priority === 'low';
		await sendChunked(options.adapter, chatId, text, { disableNotification });
	}

	function bindSandboxApproval(): void {
		if (!options.sandbox) return;
		options.sandbox.setApprovalHandler(async (request) => {
			const key = approvalKey(request);
			if (alwaysApproved.has(key)) return true;

			const chatId = chatByUser.get(options.allowedUserIds[0] ?? -1);
			if (!chatId) return false;

			const id = Math.random().toString(36).slice(2, 10);
			await options.adapter.sendMessage(chatId, renderApprovalMessage(request), {
				replyMarkup: {
					inline_keyboard: [
						[
							{ text: '✅ Approve', callback_data: `approve:${id}` },
							{ text: '❌ Deny', callback_data: `deny:${id}` },
							{ text: '🔓 Always', callback_data: `always:${id}` },
						],
					],
				},
			});

			return new Promise<boolean>((resolve) => {
				const timeout = setTimeout(() => {
					pendingById.delete(id);
					resolve(false);
				}, APPROVAL_TIMEOUT_MS);

				pendingById.set(id, { id, chatId, resolve, timeout, key });
			});
		});
	}

	return {
		name: 'telegram',
		async start(): Promise<void> {
			if (!options.token) {
				throw new Error('Telegram token is required');
			}
			bindSandboxApproval();
			await options.adapter.start({
				onMessage: handleIncoming,
				onCallback: handleCallback,
			});
			logger.info('Telegram channel started');
		},
		async stop(): Promise<void> {
			for (const pending of pendingById.values()) {
				clearTimeout(pending.timeout);
				pending.resolve(false);
			}
			pendingById.clear();
			await options.adapter.stop();
			logger.info('Telegram channel stopped');
		},
		handleIncoming,
		handleCallback,
		sendProactiveMessage,
	};
}

interface TelegramHttpUpdate {
	update_id: number;
	message?: {
		chat?: { id: number };
		from?: { id: number };
		text?: string;
		voice?: unknown;
		document?: { file_id?: string; file_name?: string };
	};
	callback_query?: {
		from?: { id: number };
		data?: string;
		message?: { chat?: { id: number } };
	};
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result: T;
}

async function telegramApi<T>(
	token: string,
	method: string,
	payload: Record<string, unknown>,
): Promise<T> {
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`);
	}
	const data = (await response.json()) as TelegramApiResponse<T>;
	if (!data.ok) {
		throw new Error(`Telegram API ${method} returned ok=false`);
	}
	return data.result;
}

async function downloadTelegramDocument(token: string, fileId: string): Promise<string> {
	const result = await telegramApi<{ file_path?: string }>(token, 'getFile', { file_id: fileId });
	const filePath = result.file_path;
	if (!filePath) return '';
	const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
	if (!response.ok) return '';
	const text = await response.text();
	if (Buffer.byteLength(text, 'utf-8') > MAX_TELEGRAM_DOCUMENT_BYTES) {
		return '';
	}
	return text;
}

export function createTelegramHttpAdapter(token: string): TelegramAdapter {
	let running = false;
	let offset = 0;
	let pollLoop: Promise<void> | null = null;

	return {
		async start(handlers): Promise<void> {
			running = true;
			pollLoop = (async () => {
				while (running) {
					try {
						const updates = await telegramApi<TelegramHttpUpdate[]>(token, 'getUpdates', {
							timeout: 20,
							offset,
						});
						for (const update of updates) {
							offset = Math.max(offset, update.update_id + 1);
							const message = update.message;
							if (message?.chat?.id && message.from?.id) {
								let documentContent = '';
								if (message.document?.file_id) {
									documentContent = await downloadTelegramDocument(token, message.document.file_id);
								}
								await handlers.onMessage({
									chatId: message.chat.id,
									fromId: message.from.id,
									text: message.text,
									voice: Boolean(message.voice),
									document:
										message.document?.file_name || message.document?.file_id
											? {
													fileName: message.document?.file_name ?? 'document.txt',
													content: documentContent,
												}
											: undefined,
								});
							}

							const callback = update.callback_query;
							if (callback?.data && callback.from?.id && callback.message?.chat?.id) {
								await handlers.onCallback({
									chatId: callback.message.chat.id,
									fromId: callback.from.id,
									data: callback.data,
								});
							}
						}
					} catch (error) {
						logger.warn('Telegram polling error', {
							error: error instanceof Error ? error.message : String(error),
						});
						await sleep(1000);
					}
				}
			})();
		},
		async stop(): Promise<void> {
			running = false;
			if (pollLoop) {
				await pollLoop.catch(() => undefined);
			}
			pollLoop = null;
		},
		async sendMessage(chatId, text, options): Promise<void> {
			await telegramApi(token, 'sendMessage', {
				chat_id: chatId,
				text,
				parse_mode: options?.parseMode,
				disable_notification: options?.disableNotification,
				reply_markup: options?.replyMarkup,
			});
		},
	};
}

export type {
	NotificationPriority,
	TelegramAdapter,
	TelegramCallback,
	TelegramChannel,
	TelegramChannelOptions,
	TelegramCostSnapshot,
	TelegramIncomingMessage,
};
