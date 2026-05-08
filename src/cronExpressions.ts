import { parseExpression } from "cron-parser";

export type CronParseOptions = {
  currentDate: Date;
  tz?: string;
};

type CronIteratorState = {
  iterator: ReturnType<typeof parseExpression>;
  next: Date;
};

type CronDateLike = {
  toDate: () => Date;
};

export function splitCronExpressions(expression: string): string[] {
  return String(expression || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function validateCronExpressions(
  expression: string,
  options: CronParseOptions,
): void {
  const expressions = splitCronExpressions(expression);
  if (expressions.length === 0) {
    throw new Error("Cron expression is required");
  }

  for (const item of expressions) {
    parseExpression(item, options);
  }
}

export function getNextCronRun(
  expression: string,
  options: CronParseOptions,
): Date | undefined {
  const runs = getFirstDistinctCronRuns(expression, options, 1);
  return runs[0];
}

export function getFirstDistinctCronRuns(
  expression: string,
  options: CronParseOptions,
  count: number,
): Date[] {
  const expressions = splitCronExpressions(expression);
  if (expressions.length === 0 || count <= 0) {
    return [];
  }

  const states: CronIteratorState[] = expressions.map((item) => {
    const iterator = parseExpression(item, options);
    return {
      iterator,
      next: nextCronDate(iterator),
    };
  });

  const runs: Date[] = [];
  const seenMinuteKeys = new Set<number>();
  let guard = 0;
  const maxIterations = Math.max(1000, count * states.length * 20);

  while (runs.length < count && states.length > 0 && guard < maxIterations) {
    guard++;
    let earliest = states[0].next;
    for (const state of states) {
      if (state.next.getTime() < earliest.getTime()) {
        earliest = state.next;
      }
    }

    const earliestMinuteKey = minuteKey(earliest);
    if (!seenMinuteKeys.has(earliestMinuteKey)) {
      seenMinuteKeys.add(earliestMinuteKey);
      runs.push(earliest);
    }

    for (const state of states) {
      while (minuteKey(state.next) === earliestMinuteKey) {
        state.next = nextCronDate(state.iterator);
      }
    }
  }

  return runs;
}

function minuteKey(date: Date): number {
  return Math.floor(date.getTime() / 60000);
}

function nextCronDate(iterator: ReturnType<typeof parseExpression>): Date {
  return (iterator.next() as unknown as CronDateLike).toDate();
}
