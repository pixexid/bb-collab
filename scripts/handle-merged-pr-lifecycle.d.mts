export function parseBackfillPullRequestNumber(event: unknown): number;
export function validateBackfillPullRequest(pullRequest: unknown, expectedNumber: number): unknown;
export function handleMergedPullRequestLifecycle(input: {
  event: unknown;
  eventName?: string;
  token?: string;
  repository?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ message: string; actions: Array<{ kind: "close" | "comment"; target: number; body?: string }>; marker?: string }>;
