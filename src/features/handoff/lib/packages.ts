import {
  PACKAGE_KIND,
  PACKAGE_VERSION,
  type HandoffPackage,
  type HandoffResource,
  type ProjectState,
  type RevisionMeta,
  type ValidationIssue,
} from "./types";
import {
  blobToDataUrl,
  dataUrlToBlob,
  hashBlob,
  sha256Bytes,
} from "./digest";
import { getHead, getResource, getRevision } from "./library";

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const ALLOWED_MEDIA = ["image/png", "image/jpeg", "image/webp"];

function issue(
  level: ValidationIssue["level"],
  code: ValidationIssue["code"],
  message: string,
): ValidationIssue {
  return { level, code, message };
}

// 在临时区完成全部校验：格式、未来版本、结构、引用完整性、损坏文件、容量
export async function validatePackage(
  raw: string,
  fileName: string,
): Promise<{ pkg: HandoffPackage; issues: ValidationIssue[]; blobs: Record<string, Blob> }> {
  const issues: ValidationIssue[] = [];
  const byteSize = new Blob([raw]).size;
  if (byteSize > MAX_PACKAGE_BYTES) {
    issues.push(
      issue("error", "size", `工程包超过 256 MB 上限（${fileName}）`),
    );
  }

  let pkg: HandoffPackage;
  try {
    pkg = JSON.parse(raw) as HandoffPackage;
  } catch {
    return {
      pkg: null as unknown as HandoffPackage,
      issues: [issue("error", "format", "不是合法的 JSON 工程文件")],
      blobs: {},
    };
  }

  if (pkg?.kind !== PACKAGE_KIND) {
    issues.push(issue("error", "format", "文件标识不是 glyphtx 交接工程"));
  }
  if (typeof pkg?.version !== "number") {
    issues.push(issue("error", "format", "缺少工程版本号"));
  } else if (pkg.version > PACKAGE_VERSION) {
    issues.push(
      issue(
        "error",
        "future-version",
        `工程来自更新的版本（v${pkg.version}），请先升级本机应用`,
      ),
    );
  } else if (pkg.version < PACKAGE_VERSION) {
    issues.push(
      issue("warning", "format", `旧版工程（v${pkg.version}），将按兼容方式读取`),
    );
  }
  if (!pkg?.projectId || !pkg?.peerId || !Array.isArray(pkg?.revisions)) {
    issues.push(issue("error", "structure", "工程结构不完整，缺少项目或修订链"));
  }
  if (!Array.isArray(pkg?.resources)) {
    issues.push(issue("error", "structure", "缺少资源清单"));
  }
  if (issues.some((i) => i.code === "format" || i.code === "structure")) {
    return { pkg, issues, blobs: {} };
  }

  // 资源清单与哈希校验
  const blobs: Record<string, Blob> = {};
  const resourceByHash = new Map<string, HandoffResource>();
  for (const resource of pkg.resources ?? []) {
    if (!resource?.hash || !resource.mediaType) {
      issues.push(issue("error", "structure", "存在缺少哈希或类型的资源条目"));
      continue;
    }
    resourceByHash.set(resource.hash, resource);
    if (!ALLOWED_MEDIA.includes(resource.mediaType)) {
      issues.push(
        issue("error", "corrupt", `资源 ${resource.hash.slice(0, 8)} 类型不受支持`),
      );
      continue;
    }
    if (pkg.mode === "embedded") {
      if (!resource.dataUrl) {
        issues.push(
          issue("error", "broken-ref", `资源 ${resource.hash.slice(0, 8)} 声明内嵌但缺少数据`),
        );
        continue;
      }
      try {
        const blob = dataUrlToBlob(resource.dataUrl);
        const actualHash = await hashBlob(blob);
        if (actualHash !== resource.hash) {
          issues.push(
            issue("error", "corrupt", `资源 ${resource.hash.slice(0, 8)} 已损坏，哈希不匹配`),
          );
          continue;
        }
        blobs[resource.hash] = blob;
      } catch {
        issues.push(
          issue("error", "corrupt", `资源 ${resource.hash.slice(0, 8)} 无法解码，文件已损坏`),
        );
      }
    }
  }

  // 修订链结构与引用完整性
  const seen = new Set<string>();
  let parentOk = true;
  for (const revision of pkg.revisions) {
    if (!revision?.id || seen.has(revision.id)) {
      issues.push(issue("error", "structure", "修订链存在重复或缺失的修订 ID"));
      parentOk = false;
    }
    seen.add(revision.id);
    if (!revision.state) {
      issues.push(issue("error", "structure", `修订 ${revision?.id ?? "?"} 缺少状态快照`));
      continue;
    }
    for (const ref of collectRefs(revision.state)) {
      if (!resourceByHash.has(ref.hash)) {
        issues.push(
          issue("error", "broken-ref", `修订 ${revision.id.slice(0, 8)} 引用了清单中不存在的资源`),
        );
        continue;
      }
      if (pkg.mode === "dedup") {
        // 去重引用模式：接收方必须在本机库中持有同一内容，否则视为断裂引用
        const local = await getResource(ref.hash);
        if (!local) {
          issues.push(
            issue(
              "error",
              "broken-ref",
              `去重引用 ${ref.hash.slice(0, 8)} 在本机作品库中缺失，无法解析`,
            ),
          );
        } else if (local.mediaType !== ref.mediaType || local.size !== ref.size) {
          issues.push(
            issue("error", "corrupt", `去重引用 ${ref.hash.slice(0, 8)} 元数据与本机资源不一致`),
          );
        }
      } else if (!blobs[ref.hash]) {
        issues.push(
          issue("error", "broken-ref", `内嵌资源 ${ref.hash.slice(0, 8)} 未能通过校验`),
        );
      }
    }
  }

  if (!seen.has(pkg.headId)) {
    issues.push(issue("error", "structure", "工程头修订不在修订链中"));
    parentOk = false;
  }
  if (parentOk) {
    const byId = new Map(pkg.revisions.map((r) => [r.id, r]));
    for (const revision of pkg.revisions) {
      if (revision.parentId && !byId.has(revision.parentId)) {
        issues.push(
          issue("error", "structure", `修订 ${revision.id.slice(0, 8)} 的父修订断裂`),
        );
      }
    }
  }

  // 可解码性与尺寸校验（损坏图片在此拦截，不允许进入作品库）
  for (const [hash, blob] of Object.entries(blobs)) {
    try {
      const buffer = await blob.arrayBuffer();
      const actual = await sha256Bytes(new Uint8Array(buffer));
      if (actual !== hash) throw new Error("hash");
      const dimensions = await decodeDimensions(blob);
      if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
        issues.push(
          issue("error", "size", `资源 ${hash.slice(0, 8)} 超过 4000 万像素限制`),
        );
      }
    } catch {
      issues.push(
        issue("error", "corrupt", `资源 ${hash.slice(0, 8)} 图片无法解码，文件已损坏`),
      );
      delete blobs[hash];
    }
  }

  return { pkg, issues, blobs };
}

function collectRefs(state: ProjectState) {
  return state.asset ? [state.asset.resource] : [];
}

async function decodeDimensions(
  blob: Blob,
): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth) throw new Error("bad image");
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface BuildInput {
  projectId: string;
  projectName: string;
  peerId: string;
  peerName: string;
  mode: "embedded" | "dedup";
  headId: string;
  revisions: RevisionMeta[];
}

// 导出交接工程：embedded 携带全部内嵌 data URL；dedup 仅保留内容哈希引用
export async function buildPackage(input: BuildInput): Promise<HandoffPackage> {
  const hashes = new Set<string>();
  for (const revision of input.revisions) {
    for (const ref of collectRefs(revision.state)) hashes.add(ref.hash);
  }
  const resources: HandoffResource[] = [];
  for (const hash of hashes) {
    const stored = await getResource(hash);
    if (!stored) {
      throw new Error(`资源 ${hash.slice(0, 8)} 在本机库缺失，无法交接`);
    }
    if (input.mode === "embedded") {
      resources.push({
        hash,
        mediaType: stored.mediaType,
        dataUrl: await blobToDataUrl(stored.blob),
      });
    } else {
      resources.push({ hash, mediaType: stored.mediaType });
    }
  }
  return {
    kind: PACKAGE_KIND,
    version: PACKAGE_VERSION,
    projectId: input.projectId,
    projectName: input.projectName,
    peerId: input.peerId,
    peerName: input.peerName,
    exportedAt: Date.now(),
    mode: input.mode,
    headId: input.headId,
    revisions: input.revisions,
    resources,
  };
}

// 在本机修订链与对端修订链之间定位共同来源（最近共同祖先）
export async function findMergeBase(
  projectId: string,
  incoming: RevisionMeta[],
): Promise<RevisionMeta | null> {
  const incomingIds = new Set(incoming.map((r) => r.id));
  const head = await getHead(projectId);
  if (!head) return null;
  let cursor: string | null = head.revisionId;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    if (incomingIds.has(cursor)) {
      const revision = await getRevision(cursor);
      return revision ?? null;
    }
    const current = await getRevision(cursor);
    cursor = current?.parentId ?? null;
  }
  return null;
}
