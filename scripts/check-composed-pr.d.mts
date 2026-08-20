export type ComposedPullRequestCheck =
  | { ok: true; disposition: string; reviewTier: "A" | "B" | "C" | null }
  | { ok: false; error: string };

export function validateComposedPullRequest(input: { title: string; body: string; files: readonly string[] }): ComposedPullRequestCheck;
