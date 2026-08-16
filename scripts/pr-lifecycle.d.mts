export type ParsedPullRequestDisposition =
  | { ok: true; kind: "closes" | "related" | "no-issue"; issueNumber: number | null; acceptance: string | null; disposition: string }
  | { ok: false; error: string };

export function parsePullRequestDisposition(input: { title?: string; body?: string }): ParsedPullRequestDisposition;
export function visibleMarkdown(text: string): string;
export function validateCommitMessages(parsed: ParsedPullRequestDisposition, commitMessages: unknown): { ok: true } | { ok: false; error: string };
export function validateIssueTarget(parsed: ParsedPullRequestDisposition, readIssue: (issueNumber: number) => Promise<unknown>): Promise<ParsedPullRequestDisposition | { ok: true; issue: unknown } | { ok: false; error: string }>;
export function hasLifecycleMarker(comments: Array<{ body?: unknown; user?: { login?: unknown; type?: unknown } }>, marker: string): boolean;
export function lifecycleMarker(pullRequestNumber: number, target: string, kind: string): string;
export function planMergedLifecycle(input: { pullRequestNumber: number; parsed: ParsedPullRequestDisposition; issueState: string | null; pullRequestComments?: Array<{ body?: unknown; user?: { login?: unknown; type?: unknown } }>; issueComments?: Array<{ body?: unknown; user?: { login?: unknown; type?: unknown } }> }): { marker: string; actions: Array<{ kind: "close" | "comment"; target: number; body?: string }> };
