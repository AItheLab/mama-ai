import type { createLLMRouter } from '../llm/router.js';
import type { Message } from '../llm/types.js';
import { getToolDefinitions } from './tools/index.js';

export interface ExecutionPlanStep {
	id: number;
	description: string;
	tool: string;
	params: Record<string, unknown>;
	dependsOn: number[];
	canFail: boolean;
	fallback?: string;
}

export interface ExecutionPlan {
	goal: string;
	steps: ExecutionPlanStep[];
	hasSideEffects: boolean;
	estimatedDuration: string;
	risks: string[];
}

interface PlannerDeps {
	router: ReturnType<typeof createLLMRouter>;
	maxSteps?: number;
}

interface Planner {
	shouldPlan(input: string): boolean;
	createPlan(input: string, history: Message[]): Promise<ExecutionPlan | null>;
}

const DEFAULT_MAX_STEPS = 8;
const MULTI_STEP_HINTS = [
	/\bthen\b/i,
	/\band then\b/i,
	/\bafter that\b/i,
	/\bfirst\b.*\bthen\b/i,
	/\bcreate\b.*\b(write|list|read|move|run)\b/i,
	/\bmulti[- ]step\b/i,
];

function shouldPlanInput(input: string): boolean {
	return MULTI_STEP_HINTS.some((pattern) => pattern.test(input));
}

function buildPlanningPrompt(input: string, history: Message[]): string {
	const toolList = getToolDefinitions()
		.map((tool) => `- ${tool.name}: ${tool.description}`)
		.join('\n');

	const recentHistory = history
		.slice(-6)
		.map((msg) => `${msg.role}: ${msg.content}`)
		.join('\n');

	return [
		'You are planning steps for a tool-using agent.',
		'Return ONLY valid JSON with this shape:',
		'{"goal":"...","steps":[{"id":1,"description":"...","tool":"...","params":{},"dependsOn":[],"canFail":false,"fallback":"optional"}],"hasSideEffects":true,"estimatedDuration":"...","risks":["..."]}',
		'Rules:',
		'- Use only the listed tools',
		'- Keep steps minimal and ordered',
		'- Read before write when relevant',
		'- Mark hasSideEffects true for write/move/shell/network mutating tasks',
		'Available tools:',
		toolList,
		'Recent conversation:',
		recentHistory || '(none)',
		`User request: ${input}`,
	].join('\n');
}

function extractJsonBlock(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenced?.[1]) {
		return fenced[1].trim();
	}

	const start = text.indexOf('{');
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaping = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (!char) continue;

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (char === '\\') {
				escaping = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === '{') {
			depth++;
			continue;
		}
		if (char === '}') {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}

	return null;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item));
}

function toNumberArray(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
}

function normalizeStep(raw: unknown, fallbackId: number): ExecutionPlanStep | null {
	const step = asRecord(raw);
	const id = Number(step.id);
	const normalizedId = Number.isInteger(id) && id > 0 ? id : fallbackId;

	const description = String(step.description ?? '').trim();
	const tool = String(step.tool ?? '').trim();
	if (!description || !tool) return null;

	const fallbackValue = step.fallback;
	const fallback =
		typeof fallbackValue === 'string' && fallbackValue.trim() ? fallbackValue : undefined;

	return {
		id: normalizedId,
		description,
		tool,
		params: asRecord(step.params),
		dependsOn: toNumberArray(step.dependsOn),
		canFail: Boolean(step.canFail),
		fallback,
	};
}

function normalizePlan(raw: unknown, maxSteps: number): ExecutionPlan | null {
	const candidate = asRecord(raw);
	const rawSteps = Array.isArray(candidate.steps) ? candidate.steps : [];
	if (rawSteps.length === 0) return null;

	const steps: ExecutionPlanStep[] = [];
	for (const [index, rawStep] of rawSteps.entries()) {
		if (steps.length >= maxSteps) break;
		const normalized = normalizeStep(rawStep, index + 1);
		if (normalized) {
			steps.push(normalized);
		}
	}

	if (steps.length === 0) return null;

	steps.sort((a, b) => a.id - b.id);
	const sideEffectTools = new Set(['write_file', 'move_file', 'execute_command', 'http_request']);
	const hasExplicitSideEffects = Boolean(candidate.hasSideEffects);
	const hasToolSideEffects = steps.some((step) => sideEffectTools.has(step.tool));

	return {
		goal: String(candidate.goal ?? 'Complete user request'),
		steps,
		hasSideEffects: hasExplicitSideEffects || hasToolSideEffects,
		estimatedDuration: String(candidate.estimatedDuration ?? 'unknown'),
		risks: toStringArray(candidate.risks),
	};
}

export function parsePlanFromText(
	text: string,
	maxSteps = DEFAULT_MAX_STEPS,
): ExecutionPlan | null {
	const json = extractJsonBlock(text);
	if (!json) return null;

	try {
		const parsed = JSON.parse(json) as unknown;
		return normalizePlan(parsed, maxSteps);
	} catch {
		return null;
	}
}

export function createPlanner(deps: PlannerDeps): Planner {
	const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;

	async function createPlan(input: string, history: Message[]): Promise<ExecutionPlan | null> {
		const requestText = buildPlanningPrompt(input, history);
		const response = await deps.router.complete({
			messages: [{ role: 'user', content: requestText }],
			taskType: 'complex_reasoning',
			temperature: 0,
			maxTokens: 1400,
		});

		return parsePlanFromText(response.content, maxSteps);
	}

	return {
		shouldPlan: shouldPlanInput,
		createPlan,
	};
}
