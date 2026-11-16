import TaskScheduler from '@modules/taskScheduler'

// The scheduler only runs a task on a tick that lands after nextStartAt. A tick equal to the interval arrives a few
// milliseconds early and gets skipped, which doubles the effective period, so the tick has to be much shorter.
export const TASK_CHECK_INTERVAL_MS = 5 * 1000

export class TaskSchedulerState extends TaskScheduler {
  private static instance: TaskSchedulerState

  private constructor() {
    super()
  }

  public static getInstance(): TaskSchedulerState {
    if (!TaskSchedulerState.instance) {
      TaskSchedulerState.instance = new TaskSchedulerState()
    }
    return TaskSchedulerState.instance
  }

  public reset(): void {
    this.stopAllTasks()
    this.tasks = {}
    this.taskRunners = {}
  }
}
