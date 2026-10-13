// Tipos de scripts/build-info.mjs (usado pelo vite.config.ts).
export interface BuildInfo {
  version: string
  build: string
}
export declare const BUILD_INFO_FILE: string
export declare function buildId(opts?: { root?: string; store?: boolean }): string
export declare function buildInfo(opts?: { root?: string; store?: boolean }): BuildInfo
