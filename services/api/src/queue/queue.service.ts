import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

export const ACTIVITY_QUEUE = 'activity.process';
export const BACKTEST_QUEUE = 'backtest.run';
export const PROACTIVE_QUEUE = 'proactive.run';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  readonly activityQueue: Queue;
  readonly backtestQueue: Queue;
  readonly proactiveQueue: Queue;

  constructor() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.activityQueue = new Queue(ACTIVITY_QUEUE, { connection: { url } as any });
    this.backtestQueue = new Queue(BACKTEST_QUEUE, { connection: { url } as any });
    this.proactiveQueue = new Queue(PROACTIVE_QUEUE, { connection: { url } as any });
  }

  async enqueueProactive(automationId: string) {
    const job = await this.proactiveQueue.add('run', { automationId }, { removeOnComplete: 200, removeOnFail: 200 });
    this.logger.log(`Enqueued proactive automation ${automationId} (job ${job.id})`);
    return job.id;
  }

  async enqueueBacktest(backtestId: string) {
    const job = await this.backtestQueue.add('run', { backtestId }, { removeOnComplete: 100, removeOnFail: 100 });
    this.logger.log(`Enqueued backtest ${backtestId} (job ${job.id})`);
    return job.id;
  }

  async enqueueActivity(activityId: string) {
    const job = await this.activityQueue.add(
      'process',
      { activityId },
      { removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    );
    this.logger.log(`Enqueued activity ${activityId} (job ${job.id})`);
    return job.id;
  }

  async onModuleDestroy() {
    await this.activityQueue.close();
    await this.backtestQueue.close();
    await this.proactiveQueue.close();
  }
}
