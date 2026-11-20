// 离线作品交接的版本化数据结构
export const PACKAGE_KIND = "glyphtx-handoff" as const;
export const PACKAGE_VERSION = 1 as const;
export const PACKAGE_EXTENSION = ".glyphtx.json";

export type ResourceMode = "embedded" | "dedup";

export interface ResourceRef {
  hash: string;
  mediaType: string;
  size: number;
}

// 原图 / 裁剪 / 字符规则的可序列化状态（不含 HTMLImageElement）
export interface AssetState {
  name: string;
  width: number;
  height: number;
  resource: ResourceRef;
}

export interface CropState {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SettingsState {
  columns: number;
  charset: string;
  custom: string;
  contrast: number;
  gamma: number;
  invert: boolean;
  color: boolean;
  background: string;
}

export interface ProjectState {
  asset: AssetState | null;
  crop: CropState;
  settings: SettingsState;
}

export interface RevisionMeta {
  id: string;
  parentId: string | null;
  peerId: string;
  at: number;
  note: string;
  state: ProjectState;
}

export interface HandoffResource {
  hash: string;
  mediaType: string;
  // embedded 模式为 data URL；dedup 模式为空，由接收方按 hash 在本地库解析
  dataUrl?: string;
}

export interface HandoffPackage {
  kind: typeof PACKAGE_KIND;
  version: number;
  projectId: string;
  projectName: string;
  peerId: string;
  peerName: string;
  exportedAt: number;
  mode: ResourceMode;
  headId: string;
  revisions: RevisionMeta[];
  resources: HandoffResource[];
}

export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  level: IssueLevel;
  code:
    | "format"
    | "future-version"
    | "structure"
    | "broken-ref"
    | "corrupt"
    | "unknown-project"
    | "no-common-ancestor"
    | "size";
  message: string;
}

export interface StagedPackage {
  id: string;
  fileName: string;
  receivedAt: number;
  pkg: HandoffPackage;
  issues: ValidationIssue[];
  valid: boolean;
  // 临时区中已落地的 blob 资源（hash -> blob），仅校验通过后才进入作品库
  blobs: Record<string, Blob>;
}
