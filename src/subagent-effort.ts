export type SubagentTaskKind = "mechanical" | "hard-core";

export function resolveSubagentReasoningLevel(input: {
  taskKind: SubagentTaskKind;
  parentReasoningLevel: string;
  requestedReasoningLevel?: string;
}): string {
  return input.requestedReasoningLevel ?? (input.taskKind === "mechanical" ? "low" : input.parentReasoningLevel);
}
