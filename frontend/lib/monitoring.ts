import type { Job, Run, Schedule } from "./types";

export type ScheduledJob = {
  job: Job;
  schedules: Schedule[];
  enabledSchedules: Schedule[];
  latestRun?: Run;
  activeRuns: Run[];
  nextRun?: string;
  needsAttention: boolean;
};

export function scheduledJobs(
  jobs: Job[],
  schedules: Schedule[],
  runs: Run[],
): ScheduledJob[] {
  const byJob = new Map<string, Schedule[]>();
  for (const schedule of schedules) {
    const group = byJob.get(schedule.job_id) || [];
    group.push(schedule);
    byJob.set(schedule.job_id, group);
  }
  const automaticRuns = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.trigger_type !== "schedule") continue;
    const group = automaticRuns.get(run.job_id) || [];
    group.push(run);
    automaticRuns.set(run.job_id, group);
  }
  return jobs
    .filter((job) => byJob.has(job.id))
    .map((job) => {
      const jobSchedules = byJob.get(job.id)!;
      const enabledSchedules = jobSchedules.filter(
        (schedule) => schedule.enabled,
      );
      const jobRuns = (automaticRuns.get(job.id) || []).sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      );
      const latestRun = jobRuns[0];
      const nextRun = job.enabled
        ? enabledSchedules
            .filter((schedule) => schedule.next_run_at)
            .map((schedule) => schedule.next_run_at!)
            .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
        : undefined;
      return {
        job,
        schedules: jobSchedules,
        enabledSchedules,
        latestRun,
        nextRun,
        activeRuns: jobRuns.filter(
          (run) => run.status === "queued" || run.status === "running",
        ),
        needsAttention:
          !!latestRun &&
          ["failed", "timeout", "canceled"].includes(latestRun.status),
      };
    });
}

export function untilNext(value: string, now: number) {
  const seconds = Math.ceil((Date.parse(value) - now) / 1000);
  if (seconds <= 0) return "Due · awaiting scheduler";
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400)
    return `in ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `in ${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
