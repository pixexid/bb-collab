export type IssueAcceptanceAudit = { openCompleted: string[]; openIncomplete: string[]; unknown: string[]; status: "pass" | "fail" | "unknown" };
export function auditGitHubFacts(input: { issues: Array<Record<string, unknown>>; mergedPullRequests: Array<Record<string, unknown>> }): IssueAcceptanceAudit;
export function collectGitHubAudit(input: { apiUrl?: string; repository?: string; token?: string }): Promise<{ issues: Array<Record<string, unknown>>; mergedPullRequests: Array<Record<string, unknown>> }>;
export function main(): Promise<void>;
