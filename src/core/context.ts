/**
 * Builds the full system prompt for the agent from soul content and memory injections.
 */
export function buildSystemPrompt(soul: string, memories?: string[]): string {
	const parts: string[] = [soul];

	if (memories && memories.length > 0) {
		parts.push('\n## Relevant Memories');
		for (const mem of memories) {
			parts.push(`- ${mem}`);
		}
	}

	parts.push('\n## Guidelines');
	parts.push('- Be concise and helpful');
	parts.push('- If you plan to perform actions with side effects, explain what you will do first');
	parts.push('- If you are unsure, say so honestly');
	parts.push("- Respect the user's time — be efficient");

	return parts.join('\n');
}
