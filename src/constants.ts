export const TOOL_NAME = "todo";
export const REALTIME_CHANNEL = "todo";

export const STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "blocked",
] as const;

export type TodoStatus = (typeof STATUSES)[number];

export const PRIORITIES = ["high", "medium", "low"] as const;
export type TodoPriority = (typeof PRIORITIES)[number];

export const ACTIONS = [
  "list",
  "set",
  "add",
  "update",
  "start",
  "complete",
  "cancel",
  "remove",
  "clear",
  "move",
  "depend",
  "mark",
  "assign",
  "dispatch",
  "dispatch-ready",
  "link",
  "release",
  "report",
] as const;

export type TodoAction = (typeof ACTIONS)[number];

export const TEXT_MAX = 240;
export const NOTES_MAX = 500;
export const REPORT_MAX = 4000;
export const MAX_ITEMS = 200;
export const MAX_DEPTH = 16;
export const MAX_DEPS = 32;
/** Keep low: many concurrent agent threads on one host tend to trip daemon disconnects. */
export const MAX_DISPATCH_BATCH = 3;
