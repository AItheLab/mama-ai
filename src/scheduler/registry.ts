import type { CronScheduler } from './cron.js';

let scheduler: CronScheduler | null = null;

export function setScheduler(value: CronScheduler | null): void {
	scheduler = value;
}

export function getScheduler(): CronScheduler | null {
	return scheduler;
}
