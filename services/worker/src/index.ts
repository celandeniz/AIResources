import { Worker, Queue } from 'bullmq';
import { processActivity } from './process-activity';
import { runBacktest } from './backtest';
import { runWeeklyDigest } from './weekly-digest';
import { runDailyBrief } from './daily-brief';
import { runProactive, tickProactiveScheduler } from './proactive';
import { planAndStartMission, advanceMissionFromActivity } from './mission';
import { runStyleRelearn } from './style-relearn';

const ACTIVITY_QUEUE = 'activity.process';
const BACKTEST_QUEUE = 'backtest.run';
const PROACTIVE_QUEUE = 'proactive.run';
const MISSION_QUEUE = 'mission.plan';
const MISSION_ADVANCE_QUEUE = 'mission.advance';
const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = { url, maxRetriesPerRequest: null } as any;

const worker = new Worker(
  ACTIVITY_QUEUE,
  async (job) => {
    const { activityId } = job.data as { activityId: string };
    console.log(`[worker] processing activity ${activityId} (job ${job.id})`);
    await processActivity(activityId);
    // Mission-task activities advance their mission graph on completion.
    await advanceMissionFromActivity(activityId).catch((e) => console.error('[mission] advance failed:', e.message));
    console.log(`[worker] done activity ${activityId}`);
  },
  { connection, concurrency: 5 },
);

// Mission planning — decomposes a goal into a task graph, then starts execution.
const missionWorker = new Worker(
  MISSION_QUEUE,
  async (job) => {
    await planAndStartMission(job.data.missionId);
  },
  { connection, concurrency: 2 },
);

// Mission advancement — the API hands an approval-gated mission-task activity
// back here once its approvals resolve, so the task graph can keep moving.
const missionAdvanceWorker = new Worker(
  MISSION_ADVANCE_QUEUE,
  async (job) => {
    const { activityId } = job.data as { activityId: string };
    await advanceMissionFromActivity(activityId);
  },
  { connection, concurrency: 2 },
);

// Backtest runs are long (many sequential LLM calls) → low concurrency.
const backtestWorker = new Worker(
  BACKTEST_QUEUE,
  async (job) => {
    const { backtestId } = job.data as { backtestId: string };
    console.log(`[worker] running backtest ${backtestId} (job ${job.id})`);
    await runBacktest(backtestId);
    console.log(`[worker] backtest ${backtestId} done`);
  },
  { connection, concurrency: 1 },
);

// Proactive automation runs — low concurrency as each involves LLM calls.
const proactiveWorker = new Worker(
  PROACTIVE_QUEUE,
  async (job) => {
    await runProactive(job.data.automationId);
  },
  { connection, concurrency: 2 },
);

const proactiveQueue = new Queue(PROACTIVE_QUEUE, { connection: { url } as any });

for (const w of [worker, backtestWorker, proactiveWorker, missionWorker, missionAdvanceWorker]) {
  w.on('failed', (job, err) => console.error(`[worker] job ${job?.id} failed:`, err.message));
  w.on('completed', (job) => console.log(`[worker] job ${job.id} completed`));
}

console.log(`[worker] listening on "${ACTIVITY_QUEUE}" + "${BACKTEST_QUEUE}" + "${PROACTIVE_QUEUE}" + "${MISSION_QUEUE}" + "${MISSION_ADVANCE_QUEUE}" (redis ${url}, agent ${process.env.AGENT_URL})`);

let digestTimer: NodeJS.Timeout | undefined;
if (process.env.ENABLE_DIGEST === 'true') {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  digestTimer = setInterval(() => runWeeklyDigest().catch((e) => console.error('[digest] failed:', e.message)), weekMs);
  runWeeklyDigest().catch((e) => console.error('[digest] failed:', e.message));
}

let dailyBriefTimer: NodeJS.Timeout | undefined;
if (process.env.ENABLE_DAILY_BRIEF !== 'false') {
  const dayMs = 24 * 60 * 60 * 1000;
  dailyBriefTimer = setInterval(() => runDailyBrief().catch((e) => console.error('[daily-brief] failed:', e.message)), dayMs);
  setTimeout(() => runDailyBrief().catch((e) => console.error('[daily-brief] failed:', e.message)), 20000);
}

let proactiveTimer: NodeJS.Timeout | undefined;
if (process.env.ENABLE_PROACTIVE === 'true') {
  const tickMs = Number(process.env.PROACTIVE_TICK_MS ?? 300000);
  proactiveTimer = setInterval(
    () => tickProactiveScheduler(proactiveQueue).catch((e) => console.error('[proactive] tick failed:', e.message)),
    tickMs,
  );
  // Run first tick shortly after boot so due automations are picked up quickly.
  setTimeout(
    () => tickProactiveScheduler(proactiveQueue).catch((e) => console.error('[proactive] tick failed:', e.message)),
    15000,
  );
}

// Scheduled re-learn of the owner's reply style (default weekly). Re-harvests
// sent mail + re-distills the style profile so drafts stay current with the
// owner's evolving voice.
let styleRelearnTimer: NodeJS.Timeout | undefined;
if (process.env.ENABLE_STYLE_RELEARN !== 'false') {
  const tickMs = Number(process.env.STYLE_RELEARN_TICK_MS ?? 7 * 24 * 60 * 60 * 1000); // weekly
  styleRelearnTimer = setInterval(
    () => runStyleRelearn().catch((e) => console.error('[style-relearn] failed:', e.message)),
    tickMs,
  );
  console.log(`[style-relearn] scheduled every ${Math.round(tickMs / 3600000)}h`);
}

process.on('SIGTERM', async () => {
  if (digestTimer) clearInterval(digestTimer);
  if (dailyBriefTimer) clearInterval(dailyBriefTimer);
  if (proactiveTimer) clearInterval(proactiveTimer);
  if (styleRelearnTimer) clearInterval(styleRelearnTimer);
  await worker.close();
  await backtestWorker.close();
  await proactiveWorker.close();
  await missionWorker.close();
  await proactiveQueue.close();
  process.exit(0);
});
