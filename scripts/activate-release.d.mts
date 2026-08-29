export interface ActivationOptions {
  releaseDirectory: string;
  sourceRoot: string;
  stateDirectory: string;
  projectId: string;
  schemaCutoverId?: string;
  adapter?: unknown;
}

export function activateRelease(options: ActivationOptions): Promise<{ outcome: "activated" | "already_active"; receipt: any }>;
export function assertNonOverlappingRoots(bindings: Array<{ pluginId: string; registeredRoot: string }>): void;
export function classifyBindings(options: any): any[];
export function defaultStateDirectory(dataDir: string): string;
export function proveLoaded(bindings: any[], installed: any[], sources: Map<string, any>): void;
export function proveRollback(changes: any[], adapter: any, receiptPath: string, priorReceiptBytes: Buffer | null): void;
export function systemAdapter(projectId: string, stateDirectory: string, runner?: (...args: any[]) => any): any;
export function verifyActiveReceipt(options: { stateDirectory: string; adapter?: unknown }): any;
