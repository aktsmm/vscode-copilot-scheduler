/**
 * Overlapping automatic runs of a recurring task are allowed unless the task
 * explicitly turned them off. One-time tasks never overlap.
 */
export function isOverlapAllowed(task: {
  runAt?: string;
  allowOverlappingRuns?: boolean;
}): boolean {
  return !task.runAt && task.allowOverlappingRuns !== false;
}
