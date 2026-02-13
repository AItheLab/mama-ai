import type { ToolDefinition } from '../../llm/types.js';
import { createFsTools } from './fs-tools.js';
import { createMetaTools } from './meta-tools.js';
import { createNetworkTools } from './network-tools.js';
import { createShellTools } from './shell-tools.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const TOOL_REGISTRY: Tool[] = [
	...createFsTools(),
	...createShellTools(),
	...createNetworkTools(),
	...createMetaTools(),
];

export function getTools(): Tool[] {
	return [...TOOL_REGISTRY];
}

export function getToolByName(name: string): Tool | undefined {
	return TOOL_REGISTRY.find((tool) => tool.name === name);
}

export function getToolDefinitions(): ToolDefinition[] {
	return TOOL_REGISTRY.map((tool) => tool.getDefinition());
}

export async function executeTool(
	toolName: string,
	params: unknown,
	context: ToolContext,
): Promise<ToolResult> {
	const tool = getToolByName(toolName);
	if (!tool) {
		return {
			success: false,
			output: null,
			error: `Unknown tool: ${toolName}`,
		};
	}

	return tool.run(params, context);
}

export type { Tool, ToolContext, ToolResult } from './types.js';
