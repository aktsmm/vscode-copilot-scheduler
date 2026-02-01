/**
 * Cron Builder - Helper for building cron expressions from UI selections
 */

import { isJapanese } from "./i18n";

/**
 * Schedule frequency type
 */
export type ScheduleFrequency =
  | "minute"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly";

/**
 * Advanced schedule configuration
 */
export interface AdvancedScheduleConfig {
  frequency: ScheduleFrequency;
  minute: number; // 0-59
  hour: number; // 0-23
  dayOfWeek: number[]; // 0-6 (0=Sunday)
  dayOfMonth: number; // 1-31
  intervalMinutes?: number; // For "every X minutes"
}

/**
 * Day of week option
 */
export interface DayOfWeekOption {
  value: number;
  labelEn: string;
  labelJa: string;
}

/**
 * Get day of week options
 */
export function getDayOfWeekOptions(): DayOfWeekOption[] {
  return [
    { value: 0, labelEn: "Sunday", labelJa: "日曜" },
    { value: 1, labelEn: "Monday", labelJa: "月曜" },
    { value: 2, labelEn: "Tuesday", labelJa: "火曜" },
    { value: 3, labelEn: "Wednesday", labelJa: "水曜" },
    { value: 4, labelEn: "Thursday", labelJa: "木曜" },
    { value: 5, labelEn: "Friday", labelJa: "金曜" },
    { value: 6, labelEn: "Saturday", labelJa: "土曜" },
  ];
}

/**
 * Get localized day of week label
 */
export function getDayOfWeekLabel(value: number): string {
  const options = getDayOfWeekOptions();
  const option = options.find((o) => o.value === value);
  if (!option) return "";
  return isJapanese() ? option.labelJa : option.labelEn;
}

/**
 * Get hour options (0-23)
 */
export function getHourOptions(): { value: number; label: string }[] {
  const options: { value: number; label: string }[] = [];
  for (let i = 0; i < 24; i++) {
    options.push({
      value: i,
      label: `${i.toString().padStart(2, "0")}:00`,
    });
  }
  return options;
}

/**
 * Get minute options (0-59, in 5-minute intervals for UX)
 */
export function getMinuteOptions(): { value: number; label: string }[] {
  const options: { value: number; label: string }[] = [];
  for (let i = 0; i < 60; i += 5) {
    options.push({
      value: i,
      label: `:${i.toString().padStart(2, "0")}`,
    });
  }
  return options;
}

/**
 * Get all minute options (0-59)
 */
export function getAllMinuteOptions(): { value: number; label: string }[] {
  const options: { value: number; label: string }[] = [];
  for (let i = 0; i < 60; i++) {
    options.push({
      value: i,
      label: `:${i.toString().padStart(2, "0")}`,
    });
  }
  return options;
}

/**
 * Get day of month options (1-31)
 */
export function getDayOfMonthOptions(): { value: number; label: string }[] {
  const options: { value: number; label: string }[] = [];
  for (let i = 1; i <= 31; i++) {
    options.push({
      value: i,
      label: isJapanese() ? `${i}日` : `${i}`,
    });
  }
  return options;
}

/**
 * Build cron expression from advanced config
 * Cron format: minute hour dayOfMonth month dayOfWeek
 */
export function buildCronExpression(config: AdvancedScheduleConfig): string {
  const { frequency, minute, hour, dayOfWeek, dayOfMonth, intervalMinutes } =
    config;

  switch (frequency) {
    case "minute":
      // Every X minutes
      if (intervalMinutes && intervalMinutes > 1) {
        return `*/${intervalMinutes} * * * *`;
      }
      return "* * * * *"; // Every minute

    case "hourly":
      // At minute X of every hour
      return `${minute} * * * *`;

    case "daily":
      // At hour:minute every day
      return `${minute} ${hour} * * *`;

    case "weekly":
      // At hour:minute on specific days
      if (dayOfWeek.length === 0) {
        // Default to Monday if no day selected
        return `${minute} ${hour} * * 1`;
      }
      const days = dayOfWeek.sort((a, b) => a - b).join(",");
      return `${minute} ${hour} * * ${days}`;

    case "monthly":
      // At hour:minute on specific day of month
      return `${minute} ${hour} ${dayOfMonth} * *`;

    default:
      return "0 9 * * 1-5"; // Default: weekdays at 9am
  }
}

/**
 * Parse cron expression to advanced config (best effort)
 */
export function parseCronExpression(
  cronExpression: string,
): AdvancedScheduleConfig | null {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minutePart, hourPart, dayOfMonthPart, monthPart, dayOfWeekPart] =
    parts;

  try {
    // Every X minutes
    if (minutePart.startsWith("*/") && hourPart === "*") {
      const interval = parseInt(minutePart.substring(2), 10);
      return {
        frequency: "minute",
        minute: 0,
        hour: 0,
        dayOfWeek: [],
        dayOfMonth: 1,
        intervalMinutes: interval,
      };
    }

    // Hourly
    if (hourPart === "*" && dayOfMonthPart === "*" && dayOfWeekPart === "*") {
      return {
        frequency: "hourly",
        minute: parseInt(minutePart, 10) || 0,
        hour: 0,
        dayOfWeek: [],
        dayOfMonth: 1,
      };
    }

    // Weekly (specific days)
    if (dayOfMonthPart === "*" && dayOfWeekPart !== "*") {
      const days = dayOfWeekPart
        .split(",")
        .map((d) => {
          if (d.includes("-")) {
            // Handle ranges like 1-5
            const [start, end] = d.split("-").map((n) => parseInt(n, 10));
            const range: number[] = [];
            for (let i = start; i <= end; i++) {
              range.push(i);
            }
            return range;
          }
          return [parseInt(d, 10)];
        })
        .flat();

      return {
        frequency: "weekly",
        minute: parseInt(minutePart, 10) || 0,
        hour: parseInt(hourPart, 10) || 9,
        dayOfWeek: days,
        dayOfMonth: 1,
      };
    }

    // Monthly
    if (dayOfMonthPart !== "*" && dayOfWeekPart === "*") {
      return {
        frequency: "monthly",
        minute: parseInt(minutePart, 10) || 0,
        hour: parseInt(hourPart, 10) || 9,
        dayOfWeek: [],
        dayOfMonth: parseInt(dayOfMonthPart, 10) || 1,
      };
    }

    // Daily
    if (dayOfMonthPart === "*" && dayOfWeekPart === "*") {
      return {
        frequency: "daily",
        minute: parseInt(minutePart, 10) || 0,
        hour: parseInt(hourPart, 10) || 9,
        dayOfWeek: [],
        dayOfMonth: 1,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get human-readable description of cron expression
 */
export function describeCronExpression(cronExpression: string): string {
  const config = parseCronExpression(cronExpression);
  if (!config) {
    return isJapanese()
      ? `カスタム: ${cronExpression}`
      : `Custom: ${cronExpression}`;
  }

  const isJa = isJapanese();
  const timeStr = `${config.hour.toString().padStart(2, "0")}:${config.minute.toString().padStart(2, "0")}`;

  switch (config.frequency) {
    case "minute":
      if (config.intervalMinutes && config.intervalMinutes > 1) {
        return isJa
          ? `${config.intervalMinutes}分ごと`
          : `Every ${config.intervalMinutes} minutes`;
      }
      return isJa ? "毎分" : "Every minute";

    case "hourly":
      return isJa
        ? `毎時${config.minute}分`
        : `Hourly at :${config.minute.toString().padStart(2, "0")}`;

    case "daily":
      return isJa ? `毎日 ${timeStr}` : `Daily at ${timeStr}`;

    case "weekly":
      const dayLabels = config.dayOfWeek
        .map((d) => getDayOfWeekLabel(d))
        .join(isJa ? "・" : ", ");
      return isJa
        ? `毎週${dayLabels} ${timeStr}`
        : `Weekly on ${dayLabels} at ${timeStr}`;

    case "monthly":
      return isJa
        ? `毎月${config.dayOfMonth}日 ${timeStr}`
        : `Monthly on day ${config.dayOfMonth} at ${timeStr}`;

    default:
      return cronExpression;
  }
}
