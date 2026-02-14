import { z } from 'zod';

const AgentSchema = z.object({
	name: z.string().default('Mama'),
	soulPath: z.string().default('./soul.md'),
});

const UserSchema = z.object({
	name: z.string().default('User'),
	telegramIds: z.array(z.number()).default([]),
	timezone: z.string().default('UTC'),
	locale: z.string().default('en-US'),
});

const ClaudeProviderSchema = z.object({
	apiKey: z.string().default(''),
	defaultModel: z.string().default('claude-sonnet-4-20250514'),
	maxMonthlyBudgetUsd: z.number().positive().default(50),
});

const OllamaProviderSchema = z.object({
	host: z.string().url().default('http://localhost:11434'),
	apiKey: z.string().default(''),
	defaultModel: z.string().default('minimax-m2.5:cloud'),
	smartModel: z.string().default('minimax-m2.5:cloud'),
	fastModel: z.string().default('gemini-3-flash-preview:cloud'),
	embeddingModel: z.string().default('nomic-embed-text'),
});

const RoutingSchema = z.object({
	complexReasoning: z.enum(['claude', 'ollama']).default('ollama'),
	codeGeneration: z.enum(['claude', 'ollama']).default('ollama'),
	simpleTasks: z.enum(['claude', 'ollama']).default('ollama'),
	embeddings: z.enum(['claude', 'ollama']).default('ollama'),
	memoryConsolidation: z.enum(['claude', 'ollama']).default('ollama'),
	privateContent: z.enum(['claude', 'ollama']).default('ollama'),
});

const LlmSchema = z.object({
	defaultProvider: z.enum(['claude', 'ollama']).default('ollama'),
	providers: z
		.object({
			claude: ClaudeProviderSchema.default({}),
			ollama: OllamaProviderSchema.default({}),
		})
		.default({}),
	routing: RoutingSchema.default({}),
});

const TerminalChannelSchema = z.object({
	enabled: z.boolean().default(true),
});

const TelegramChannelSchema = z.object({
	enabled: z.boolean().default(false),
	botToken: z.string().default(''),
	defaultChatId: z.number().int().optional(),
});

const ApiChannelSchema = z.object({
	enabled: z.boolean().default(false),
	host: z.string().default('127.0.0.1'),
	port: z.number().int().min(1).max(65535).default(3377),
	token: z.string().default(''),
});

const ChannelsSchema = z.object({
	terminal: TerminalChannelSchema.default({}),
	telegram: TelegramChannelSchema.default({}),
	api: ApiChannelSchema.default({}),
});

const FsPathPermission = z.object({
	path: z.string(),
	actions: z.array(z.enum(['read', 'write', 'list', 'delete', 'search', 'move'])),
	level: z.enum(['auto', 'ask', 'deny']),
});

const FilesystemSandboxSchema = z.object({
	workspace: z.string().default('~/.mama/workspace'),
	allowedPaths: z.array(FsPathPermission).default([]),
	deniedPaths: z.array(z.string()).default([]),
});

const ShellSandboxSchema = z.object({
	safeCommands: z
		.array(z.string())
		.default(['ls', 'wc', 'date', 'whoami', 'pwd', 'echo', 'git status', 'git log', 'git diff']),
	askCommands: z
		.array(z.string())
		.default(['git commit', 'git push', 'git pull', 'mkdir', 'cp', 'mv', 'npm', 'pnpm', 'node']),
	deniedPatterns: z
		.array(z.string())
		.default([
			'env',
			'printenv',
			'rm -rf',
			'sudo',
			'curl | bash',
			'wget | sh',
			'chmod 777',
			'> /dev',
			'mkfs',
			'dd if=',
		]),
});

const NetworkSandboxSchema = z.object({
	allowedDomains: z
		.array(z.string())
		.default(['ollama.com', 'api.telegram.org', 'localhost', 'api.github.com']),
	askDomains: z.boolean().default(true),
	rateLimitPerMinute: z.number().int().positive().default(30),
	logAllRequests: z.boolean().default(true),
});

const SandboxSchema = z.object({
	filesystem: FilesystemSandboxSchema.default({}),
	shell: ShellSandboxSchema.default({}),
	network: NetworkSandboxSchema.default({}),
});

const HeartbeatSchema = z.object({
	enabled: z.boolean().default(true),
	intervalMinutes: z.number().int().positive().default(30),
	heartbeatFile: z.string().default('~/.mama/heartbeat.md'),
});

const FileWatcherTriggerSchema = z.object({
	path: z.string(),
	events: z.array(z.enum(['add', 'change', 'unlink', 'rename'])).default(['add']),
	task: z.string().min(1),
});

const WebhookHookSchema = z.object({
	id: z.string().min(1),
	token: z.string().default(''),
	task: z.string().min(1),
});

const WebhookTriggersSchema = z.object({
	enabled: z.boolean().default(false),
	host: z.string().default('127.0.0.1'),
	port: z.number().int().min(1).max(65535).default(3378),
	hooks: z.array(WebhookHookSchema).default([]),
});

const TriggersSchema = z.object({
	fileWatchers: z.array(FileWatcherTriggerSchema).default([]),
	webhooks: WebhookTriggersSchema.default({}),
});

const SchedulerSchema = z.object({
	heartbeat: HeartbeatSchema.default({}),
	maxConcurrentJobs: z.number().int().positive().default(3),
	triggers: TriggersSchema.default({}),
});

const DaemonSchema = z.object({
	pidFile: z.string().default('~/.mama/mama.pid'),
	healthCheckIntervalSeconds: z.number().int().positive().default(30),
});

const ConsolidationSchema = z.object({
	enabled: z.boolean().default(true),
	intervalHours: z.number().positive().default(6),
	minEpisodesToConsolidate: z.number().int().positive().default(10),
	model: z.enum(['claude', 'ollama']).default('ollama'),
});

const MemorySchema = z.object({
	consolidation: ConsolidationSchema.default({}),
	maxEpisodicEntries: z.number().int().positive().default(100000),
	embeddingDimensions: z.number().int().positive().default(768),
	searchTopK: z.number().int().positive().default(10),
});

const LoggingSchema = z.object({
	level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
	file: z.string().default('~/.mama/logs/mama.log'),
	maxSizeMb: z.number().positive().default(50),
	rotate: z.boolean().default(true),
});

export const ConfigSchema = z.object({
	version: z.number().int().default(1),
	agent: AgentSchema.default({}),
	user: UserSchema.default({}),
	llm: LlmSchema.default({}),
	channels: ChannelsSchema.default({}),
	sandbox: SandboxSchema.default({}),
	scheduler: SchedulerSchema.default({}),
	daemon: DaemonSchema.default({}),
	memory: MemorySchema.default({}),
	logging: LoggingSchema.default({}),
});

export type MamaConfig = z.infer<typeof ConfigSchema>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
