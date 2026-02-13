export type ScheduleType = 'cron' | 'natural';

export interface ScheduleInput {
	type: ScheduleType;
	value: string;
}

export interface JobLastResult {
	success: boolean;
	output?: unknown;
	error?: string;
	finishedAt: string;
}

export interface Job {
	id: string;
	name: string;
	type: string;
	schedule: string;
	task: string;
	enabled: boolean;
	lastRun: Date | null;
	nextRun: Date | null;
	runCount: number;
	lastResult: JobLastResult | null;
}

export interface NewJob {
	name?: string;
	schedule: string;
	task: string;
	type?: string;
}

export interface JobRunResult {
	success: boolean;
	output?: unknown;
	error?: string;
}

export interface JobRunContext {
	jobId: string;
	jobName: string;
	task: string;
}

export interface ScheduleParser {
	parseNaturalLanguage(schedule: string): Promise<string | null>;
}
