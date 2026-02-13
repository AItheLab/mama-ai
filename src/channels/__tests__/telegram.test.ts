import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramChannel, type TelegramAdapter } from '../telegram.js';

function createMockAdapter() {
	let handlers: {
		onMessage: (message: {
			chatId: number;
			fromId: number;
			text?: string;
			document?: { fileName: string; content: string };
			voice?: boolean;
		}) => Promise<void>;
		onCallback: (callback: { chatId: number; fromId: number; data: string }) => Promise<void>;
	} | null = null;

	const sent: Array<{
		chatId: number;
		text: string;
		options?: {
			parseMode?: 'Markdown';
			disableNotification?: boolean;
			replyMarkup?: {
				inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
			};
		};
	}> = [];

	const adapter: TelegramAdapter = {
		start: vi.fn(async (nextHandlers) => {
			handlers = nextHandlers;
		}),
		stop: vi.fn(async () => {}),
		sendMessage: vi.fn(async (chatId, text, options) => {
			sent.push({ chatId, text, options });
		}),
	};

	return {
		adapter,
		sent,
		getHandlers() {
			if (!handlers) throw new Error('Handlers not initialized');
			return handlers;
		},
	};
}

describe('createTelegramChannel', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('blocks unauthorized users and processes authorized text messages', async () => {
		const mock = createMockAdapter();
		const agent = {
			processMessage: vi.fn(async (text: string) => ({
				content: `Echo: ${text}`,
				model: 'test-model',
				provider: 'test',
				tokenUsage: { input: 1, output: 1 },
				iterations: 1,
				toolCallsExecuted: 0,
			})),
		};

		const channel = createTelegramChannel({
			token: 'token',
			allowedUserIds: [1001],
			workspacePath: '/tmp/mama-telegram-tests',
			agent: agent as never,
			adapter: mock.adapter,
		});
		await channel.start();

		await channel.handleIncoming({ chatId: 10, fromId: 9999, text: 'blocked' });
		expect(agent.processMessage).not.toHaveBeenCalled();

		await channel.handleIncoming({ chatId: 11, fromId: 1001, text: 'hello' });
		expect(agent.processMessage).toHaveBeenCalledWith('hello', 'telegram');
		expect(mock.sent[mock.sent.length - 1]?.text).toContain('Echo: hello');
	});

	it('splits long responses into Telegram-safe chunks', async () => {
		const mock = createMockAdapter();
		const longText = `A${'x'.repeat(5000)}`;
		const agent = {
			processMessage: vi.fn(async () => ({
				content: longText,
				model: 'test-model',
				provider: 'test',
				tokenUsage: { input: 1, output: 1 },
				iterations: 1,
				toolCallsExecuted: 0,
			})),
		};

		const channel = createTelegramChannel({
			token: 'token',
			allowedUserIds: [42],
			workspacePath: '/tmp/mama-telegram-tests',
			agent: agent as never,
			adapter: mock.adapter,
		});
		await channel.start();
		await channel.handleIncoming({ chatId: 5, fromId: 42, text: 'go' });

		expect(mock.sent.length).toBeGreaterThan(1);
		expect(mock.sent.every((entry) => entry.text.length <= 4096)).toBe(true);
	});

	it('handles inline approval flow with approve/deny/always callbacks', async () => {
		const mock = createMockAdapter();
		let approvalHandler:
			| ((request: { capability: string; action: string; resource: string }) => Promise<boolean>)
			| null = null;
		const sandbox = {
			setApprovalHandler: vi.fn((handler) => {
				approvalHandler = handler as never;
			}),
		};
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
		const channel = createTelegramChannel({
			token: 'token',
			allowedUserIds: [77],
			workspacePath: '/tmp/mama-telegram-tests',
			agent: agent as never,
			adapter: mock.adapter,
			sandbox,
		});
		await channel.start();
		await channel.handleIncoming({ chatId: 77, fromId: 77, text: 'hello' });

		if (!approvalHandler) throw new Error('Missing approval handler');
		const pending = approvalHandler({
			capability: 'filesystem',
			action: 'write',
			resource: '/tmp/test.md',
		});

		const approvalMessage = mock.sent[mock.sent.length - 1];
		const callbackData =
			approvalMessage?.options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data ?? '';
		expect(callbackData.startsWith('approve:')).toBe(true);
		await Promise.resolve();

		await channel.handleCallback({ chatId: 77, fromId: 77, data: callbackData });
		await expect(pending).resolves.toBe(true);
	});

	it('sends proactive messages with priority behavior', async () => {
		const mock = createMockAdapter();
		const channel = createTelegramChannel({
			token: 'token',
			allowedUserIds: [55],
			workspacePath: '/tmp/mama-telegram-tests',
			agent: {
				processMessage: vi.fn(async () => ({
					content: 'ok',
					model: 'test',
					provider: 'test',
					tokenUsage: { input: 1, output: 1 },
					iterations: 1,
					toolCallsExecuted: 0,
				})),
			} as never,
			adapter: mock.adapter,
		});
		await channel.start();

		await channel.sendProactiveMessage(55, 'quiet', 'low');
		await channel.sendProactiveMessage(55, 'urgent', 'urgent');

		const low = mock.sent.find((entry) => entry.text === 'quiet');
		expect(low?.options?.disableNotification).toBe(true);

		const urgentCount = mock.sent.filter((entry) => entry.text === 'urgent').length;
		expect(urgentCount).toBe(2);
	});
});
