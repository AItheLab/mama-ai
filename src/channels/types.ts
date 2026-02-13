/** Message from Mama to a channel */
export interface OutgoingMessage {
	text: string;
	format?: 'plain' | 'markdown';
}

/** Message received from a channel */
export interface IncomingMessage {
	text: string;
	channelName: string;
	timestamp: Date;
}

/** Channel interface — all channels implement this */
export interface Channel {
	name: string;
	start(): Promise<void>;
	stop(): Promise<void>;
}
