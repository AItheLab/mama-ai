import type { PlanExecutionResult, PlanStepStatus } from './executor.js';
import type { ExecutionPlan } from './planner.js';

/** Result type for fallible operations */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** Channels where messages originate */
export type ChannelName = 'terminal' | 'telegram' | 'api';

export type AgentEvent =
	| {
			type: 'tool_call_started';
			callId: string;
			toolName: string;
	  }
	| {
			type: 'tool_call_finished';
			callId: string;
			toolName: string;
			success: boolean;
			error?: string;
	  }
	| {
			type: 'plan_created';
			plan: ExecutionPlan;
	  }
	| {
			type: 'plan_approval_requested';
			plan: ExecutionPlan;
	  }
	| {
			type: 'plan_step_started';
			stepId: number;
			description: string;
			tool: string;
	  }
	| {
			type: 'plan_step_finished';
			stepId: number;
			description: string;
			tool: string;
			status: PlanStepStatus;
			error?: string;
			attempts: number;
			percentComplete: number;
	  };

export interface AgentRunOptions {
	onEvent?: (event: AgentEvent) => void;
	onPlanApproval?: (plan: ExecutionPlan) => Promise<boolean>;
}

/** A processed agent response */
export interface AgentResponse {
	content: string;
	model: string;
	provider: string;
	tokenUsage: {
		input: number;
		output: number;
	};
	iterations: number;
	toolCallsExecuted: number;
	planExecution?: PlanExecutionResult;
}
