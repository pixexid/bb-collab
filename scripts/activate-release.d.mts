export interface ActivationOptions {
  releaseDirectory: string;
  sourceRoot: string;
  stateDirectory: string;
  projectId: string;
  schemaCutoverId?: string;
  adapter?: unknown;
}

export function activateRelease(options: ActivationOptions): Promise<{ outcome: "activated" | "already_active"; receipt: any }>;
export function classifyBindings(options: any): any[];
export function defaultStateDirectory(dataDir: string): string;
export function proveLoaded(bindings: any[], installed: any[], sources: Map<string, any>): void;
export function proveRollback(changes: any[], installed: any[], sources: Map<string, any>): void;
export function verifyActiveReceipt(options: { stateDirectory: string; adapter?: unknown }): any;
