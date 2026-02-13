/** Result type for fallible operations */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** Channels where messages originate */
export type ChannelName = 'terminal' | 'telegram' | 'api';

/** A processed agent response */
export interface AgentResponse {
	content: string;
	model: string;
	provider: string;
	tokenUsage: {
		input: number;
		output: number;
	};
}
