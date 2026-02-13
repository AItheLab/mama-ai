import type { Command } from 'commander';
import type { CronScheduler } from '../scheduler/cron.js';

interface RegisterJobsCommandOptions {
	resolveScheduler(configPath?: string): Promise<{
		scheduler: CronScheduler;
		close(): void;
	}>;
}

function writeError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Error: ${message}\n`);
}

async function withScheduler<T>(
	options: RegisterJobsCommandOptions,
	configPath: string | undefined,
	run: (scheduler: CronScheduler) => Promise<T>,
): Promise<T> {
	const services = await options.resolveScheduler(configPath);
	try {
		return await run(services.scheduler);
	} finally {
		services.close();
	}
}

function formatDate(value: Date | null): string {
	return value ? value.toISOString() : '-';
}

export function registerJobsCommands(program: Command, options: RegisterJobsCommandOptions): void {
	const jobs = program.command('jobs').description('Scheduled job operations');

	jobs
		.command('list')
		.option('-c, --config <path>', 'Path to config file')
		.option('--enabled', 'Show only enabled jobs')
		.description('List scheduled jobs')
		.action(async (commandOptions: { config?: string; enabled?: boolean }) => {
			try {
				const rows = await withScheduler(options, commandOptions.config, (scheduler) =>
					scheduler.listJobs(),
				);
				const jobsToPrint = commandOptions.enabled ? rows.filter((job) => job.enabled) : rows;
				if (jobsToPrint.length === 0) {
					process.stdout.write('No scheduled jobs found.\n');
					return;
				}
				for (const job of jobsToPrint) {
					process.stdout.write(
						`${job.id} | ${job.enabled ? 'enabled' : 'disabled'} | ${job.schedule} | ${job.name}\n`,
					);
					process.stdout.write(
						`  task="${job.task}" | runs=${job.runCount} | last=${formatDate(job.lastRun)} | next=${formatDate(job.nextRun)}\n`,
					);
				}
			} catch (error) {
				writeError(error);
				process.exitCode = 1;
			}
		});

	jobs
		.command('create')
		.argument('<schedule>', 'Cron expression or natural language schedule')
		.argument('<task>', 'Task description')
		.option('-n, --name <name>', 'Optional job name')
		.option('-c, --config <path>', 'Path to config file')
		.description('Create a scheduled job')
		.action(
			async (
				schedule: string,
				task: string,
				commandOptions: { name?: string; config?: string },
			) => {
				try {
					const id = await withScheduler(options, commandOptions.config, (scheduler) =>
						scheduler.createJob({ name: commandOptions.name, schedule, task }),
					);
					process.stdout.write(`Created job ${id}\n`);
				} catch (error) {
					writeError(error);
					process.exitCode = 1;
				}
			},
		);

	for (const action of ['enable', 'disable', 'delete'] as const) {
		jobs
			.command(action)
			.argument('<id>', 'Job id')
			.option('-c, --config <path>', 'Path to config file')
			.description(`${action[0]?.toUpperCase()}${action.slice(1)} a scheduled job`)
			.action(async (id: string, commandOptions: { config?: string }) => {
				try {
					await withScheduler(options, commandOptions.config, async (scheduler) => {
						if (action === 'enable') {
							await scheduler.enableJob(id);
						} else if (action === 'disable') {
							await scheduler.disableJob(id);
						} else {
							await scheduler.deleteJob(id);
						}
					});
					process.stdout.write(`${action}d job ${id}\n`);
				} catch (error) {
					writeError(error);
					process.exitCode = 1;
				}
			});
	}
}
