export interface ReleaseManifest {
  version: 2;
  sourceCommit: string;
  toolchain: {
    bbPackage: string;
    bbVersion: string;
    nodeVersion: string;
    pluginSdkVersion: string;
  };
  loadAuthority: "inactive";
  artifactRoots: string[];
  files: Array<{ path: string; sha256: string }>;
  releaseDigest: string;
}

export function canonicalJson(value: unknown): string;
export function manifestFor(directory: string, commit?: string, sourceDirectory?: string): ReleaseManifest;
export const pinnedToolchain: ReleaseManifest["toolchain"];
export function verifyRelease(directory: string, manifestPath: string, sourceDirectory?: string): ReleaseManifest;
