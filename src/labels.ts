/**
 * Linear label names, configurable via environment variables.
 * Override these if your Linear workspace uses different label names.
 */
export const LABEL = {
  AGENT: process.env.LABEL_AGENT || "agent",
  NO_QUESTIONS: process.env.LABEL_NO_QUESTIONS || "noQuestions",
  SKIP_QA: process.env.LABEL_SKIP_QA || "skipQA",
  SKIP_E2E: process.env.LABEL_SKIP_E2E || "skipE2E",
} as const;
