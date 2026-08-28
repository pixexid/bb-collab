export interface ReleaseManifest {
  version: 1;
  sourceCommit: string;
  toolchain: {
    bbPackage: string;
    bbVersion: string;
    nodeVersion: string;
    pluginSdkVersion: string;
  };
  files: Array<{ path: string; sha256: string }>;
  releaseDigest: string;
}

export function canonicalJson(value: unknown): string;
export function manifestFor(directory: string, commit?: string): ReleaseManifest;
export const pinnedToolchain: ReleaseManifest["toolchain"];
export function verifyRelease(directory: string, manifestPath: string, sourceDirectory?: string): ReleaseManifest;
