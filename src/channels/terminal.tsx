import { Box, render, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { createAgent } from '../core/agent.js';
import type { ExecutionPlan } from '../core/planner.js';
import type { AgentEvent } from '../core/types.js';
import type { ApprovalRequest } from '../sandbox/types.js';

interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	model?: string;
}

type PendingDecision =
	| {
			kind: 'sandbox';
			request: ApprovalRequest;
			resolve: (approved: boolean) => void;
	  }
	| {
			kind: 'plan';
			plan: ExecutionPlan;
			resolve: (approved: boolean) => void;
	  };

interface ApprovalCapableSandbox {
	setApprovalHandler(handler: (request: ApprovalRequest) => Promise<boolean>): void;
}

interface AppProps {
	agent: ReturnType<typeof createAgent>;
	agentName: string;
	sandbox?: ApprovalCapableSandbox;
}

function formatPlanForApproval(plan: ExecutionPlan): string {
	const stepLines = plan.steps.map((step) => `- ${step.id}. ${step.description} [${step.tool}]`);
	const riskLine = plan.risks.length > 0 ? `Risks: ${plan.risks.join('; ')}` : 'Risks: none';
	return [
		'Plan requires approval:',
		`Goal: ${plan.goal}`,
		...stepLines,
		`Estimated duration: ${plan.estimatedDuration}`,
		riskLine,
		'Approve? (yes/no)',
	].join('\n');
}

function formatEvent(event: AgentEvent): string | null {
	switch (event.type) {
		case 'tool_call_started':
			return `Running tool: ${event.toolName}`;
		case 'tool_call_finished':
			return event.success
				? `Tool finished: ${event.toolName}`
				: `Tool failed: ${event.toolName}${event.error ? ` (${event.error})` : ''}`;
		case 'plan_created':
			return `Plan created with ${event.plan.steps.length} step(s).`;
		case 'plan_approval_requested':
			return 'Plan has side effects and needs approval.';
		case 'plan_step_started':
			return `Step ${event.stepId} started: ${event.description}`;
		case 'plan_step_finished':
			return `Step ${event.stepId} ${event.status} (${event.percentComplete}%)`;
		default:
			return null;
	}
}

function App({ agent, agentName, sandbox }: AppProps) {
	const messageId = useRef(1);
	const [messages, setMessages] = useState<ChatMessage[]>([
		{
			id: 'msg-0',
			role: 'system',
			content: `${agentName} ready. Type your message. Ctrl+C to exit.`,
		},
	]);
	const [input, setInput] = useState('');
	const [isProcessing, setIsProcessing] = useState(false);
	const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
	const { exit } = useApp();

	const appendMessage = useCallback((message: Omit<ChatMessage, 'id'>) => {
		const id = `msg-${messageId.current++}`;
		setMessages((prev) => [...prev, { id, ...message }]);
	}, []);

	useEffect(() => {
		if (!sandbox) return;
		sandbox.setApprovalHandler(async (request) => {
			return new Promise<boolean>((resolve) => {
				appendMessage({
					role: 'system',
					content: `Approval needed (${request.capability}:${request.action}) on "${request.resource}". Approve? (yes/no)`,
				});
				setPendingDecision({ kind: 'sandbox', request, resolve });
			});
		});
	}, [appendMessage, sandbox]);

	useInput((_input, key) => {
		if (key.ctrl && _input === 'c') {
			exit();
		}
	});

	const handleSubmit = useCallback(
		async (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) return;

			if (pendingDecision) {
				const normalized = trimmed.toLowerCase();
				if (!['y', 'yes', 'n', 'no'].includes(normalized)) {
					appendMessage({
						role: 'system',
						content: 'Please answer with yes or no.',
					});
					setInput('');
					return;
				}

				const approved = normalized === 'y' || normalized === 'yes';
				pendingDecision.resolve(approved);
				setPendingDecision(null);
				setInput('');
				appendMessage({
					role: 'system',
					content: approved ? 'Approved.' : 'Denied.',
				});
				return;
			}

			if (isProcessing) return;

			setInput('');
			appendMessage({ role: 'user', content: trimmed });
			setIsProcessing(true);

			try {
				const response = await agent.processMessage(trimmed, 'terminal', {
					onEvent(event) {
						const eventText = formatEvent(event);
						if (eventText) {
							appendMessage({ role: 'system', content: eventText });
						}
					},
					onPlanApproval(plan) {
						return new Promise<boolean>((resolve) => {
							appendMessage({
								role: 'system',
								content: formatPlanForApproval(plan),
							});
							setPendingDecision({ kind: 'plan', plan, resolve });
						});
					},
				});

				appendMessage({
					role: 'assistant',
					content: response.content,
					model: response.model,
				});
			} catch (err) {
				appendMessage({
					role: 'system',
					content: `Error: ${err instanceof Error ? err.message : String(err)}`,
				});
			} finally {
				setIsProcessing(false);
			}
		},
		[agent, appendMessage, isProcessing, pendingDecision],
	);

	// Show last N messages to keep terminal clean
	const visibleMessages = messages.slice(-20);

	return (
		<Box flexDirection="column" padding={1}>
			{/* Header */}
			<Box marginBottom={1}>
				<Text bold color="magenta">
					{'🤱 '}
					{agentName}
				</Text>
				<Text color="gray"> — Personal AI Agent</Text>
			</Box>

			{/* Messages */}
			<Box flexDirection="column" marginBottom={1}>
				{visibleMessages.map((msg) => (
					<Box key={msg.id} marginBottom={0}>
						{msg.role === 'user' && (
							<Text>
								<Text color="cyan" bold>
									{'You: '}
								</Text>
								<Text>{msg.content}</Text>
							</Text>
						)}
						{msg.role === 'assistant' && (
							<Text>
								<Text color="magenta" bold>{`${agentName}: `}</Text>
								<Text>{msg.content}</Text>
								{msg.model && <Text color="gray">{` [${msg.model}]`}</Text>}
							</Text>
						)}
						{msg.role === 'system' && (
							<Text color="yellow" dimColor>
								{msg.content}
							</Text>
						)}
					</Box>
				))}
			</Box>

			{/* Input */}
			<Box>
				{pendingDecision ? (
					<Box flexDirection="column">
						<Text color="yellow">
							{pendingDecision.kind === 'sandbox'
								? 'Awaiting sandbox approval (yes/no)...'
								: 'Awaiting plan approval (yes/no)...'}
						</Text>
						<Box>
							<Text color="cyan" bold>
								{'> '}
							</Text>
							<TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
						</Box>
					</Box>
				) : isProcessing ? (
					<Text color="yellow">{'⏳ Working...'}</Text>
				) : (
					<Box>
						<Text color="cyan" bold>
							{'> '}
						</Text>
						<TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
					</Box>
				)}
			</Box>
		</Box>
	);
}

/**
 * Starts the terminal chat interface using Ink.
 */
export function startTerminal(
	agent: ReturnType<typeof createAgent>,
	agentName: string,
	sandbox?: ApprovalCapableSandbox,
): void {
	const instance = render(<App agent={agent} agentName={agentName} sandbox={sandbox} />);
	instance.waitUntilExit().then(() => {
		process.exit(0);
	});
}
