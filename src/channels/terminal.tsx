import { Box, render, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useState } from 'react';
import type { createAgent } from '../core/agent.js';

interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	model?: string;
}

interface AppProps {
	agent: ReturnType<typeof createAgent>;
	agentName: string;
}

function App({ agent, agentName }: AppProps) {
	const [messages, setMessages] = useState<ChatMessage[]>([
		{ role: 'system', content: `${agentName} ready. Type your message. Ctrl+C to exit.` },
	]);
	const [input, setInput] = useState('');
	const [isProcessing, setIsProcessing] = useState(false);
	const { exit } = useApp();

	useInput((_input, key) => {
		if (key.ctrl && _input === 'c') {
			exit();
		}
	});

	const handleSubmit = useCallback(
		async (value: string) => {
			const trimmed = value.trim();
			if (!trimmed || isProcessing) return;

			setInput('');
			setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
			setIsProcessing(true);

			try {
				const response = await agent.processMessage(trimmed, 'terminal');
				setMessages((prev) => [
					...prev,
					{
						role: 'assistant',
						content: response.content,
						model: response.model,
					},
				]);
			} catch (err) {
				setMessages((prev) => [
					...prev,
					{
						role: 'system',
						content: `Error: ${err instanceof Error ? err.message : String(err)}`,
					},
				]);
			} finally {
				setIsProcessing(false);
			}
		},
		[agent, isProcessing],
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
				{visibleMessages.map((msg, i) => (
					<Box key={`msg-${i}`} marginBottom={0}>
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
				{isProcessing ? (
					<Text color="yellow">{'⏳ Thinking...'}</Text>
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
export function startTerminal(agent: ReturnType<typeof createAgent>, agentName: string): void {
	const instance = render(<App agent={agent} agentName={agentName} />);
	instance.waitUntilExit().then(() => {
		process.exit(0);
	});
}
