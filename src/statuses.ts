/**
 * Linear workflow state names, configurable via environment variables.
 * Override these if your Linear workspace uses different state names.
 */
export const STATUS = {
  BACKLOG: process.env.STATUS_BACKLOG || "Backlog",
  IN_PROGRESS: process.env.STATUS_IN_PROGRESS || "In Progress",
  IN_DEVELOPMENT: process.env.STATUS_IN_DEVELOPMENT || "In Development",
  IN_REVIEW: process.env.STATUS_IN_REVIEW || "In Review",
  E2E_TESTING: process.env.STATUS_E2E_TESTING || "E2E Testing",
  READY_FOR_REVIEW: process.env.STATUS_READY_FOR_REVIEW || "Ready for Review",
  DONE: process.env.STATUS_DONE || "Done",
  WAITING: process.env.STATUS_WAITING || "Waiting",
} as const;
