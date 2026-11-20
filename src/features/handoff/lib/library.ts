import type {
  HandoffPackage,
  ProjectState,
  RevisionMeta,
  StagedPackage,
  ValidationIssue,
} from "./types";

// 内容寻址的本机作品库（IndexedDB）。所有写库操作走单事务，失败整体回滚，
// 保证空间不足等异常不会留下半个工程或半次合并。
const DB_NAME = "glyphtx-studio";
const DB_VERSION = 1;
const STORES = [
  "resources",
  "projects",
  "revisions",
  "heads",
  "merges",
  "staging",
] as const;

// 各对象仓库的主键路径；undefined 表示 out-of-line，由调用方显式提供键
const KEY_PATHS: Record<(typeof STORES)[number], string | undefined> = {
  resources: "hash",
  projects: "id",
  revisions: "id",
  heads: "projectId",
  merges: "id",
  staging: "id",
};

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  localPeerId: string;
}

export interface HeadRecord {
  projectId: string;
  revisionId: string;
}

export interface ResourceRecord {
  hash: string;
  mediaType: string;
  size: number;
  blob: Blob;
  createdAt: number;
}

export interface MergeRecord {
  id: string;
  projectId: string;
  at: number;
  baseRevisionId: string | null;
  remotePeerId: string;
  remotePeerName: string;
  remoteHeadId: string;
  // 逐项选择的留痕：重开后仍可追溯合并结果由哪些选择产生
  selection: Record<string, "local" | "remote">;
  entrySummary: Array<{
    key: string;
    label: string;
    status: string;
    chosen: "local" | "remote" | null;
  }>;
  resultingState: ProjectState;
  resultRevisionId: string;
}

export interface StagingRecord {
  id: string;
  fileName: string;
  receivedAt: number;
  pkg: HandoffPackage;
  issues: ValidationIssue[];
  valid: boolean;
  blobs: Record<string, Blob>;
}

// 入库时给修订补上所属工程，以便按 projectId 建索引；交接包内的修订不带该字段
export interface StoredRevision extends RevisionMeta {
  projectId: string;
}

function toStoredRevision(
  projectId: string,
  revision: RevisionMeta,
): StoredRevision {
  return { ...revision, projectId };
}

function toRevisionMeta(stored: StoredRevision): RevisionMeta {
  const { projectId: _projectId, ...revision } = stored;
  return revision;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境不支持本机作品库（IndexedDB 不可用）"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, {
            keyPath: KEY_PATHS[name],
          });
          if (name === "revisions") store.createIndex("projectId", "projectId");
          if (name === "merges") store.createIndex("projectId", "projectId");
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("无法打开本机作品库"));
  });
}

function tx(
  db: IDBDatabase,
  names: readonly (typeof STORES)[number][],
  mode: IDBTransactionMode,
  run: (stores: Record<string, IDBObjectStore>) => IDBRequest[],
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(names, mode);
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of names) stores[name] = transaction.objectStore(name);
    let requests: IDBRequest[];
    try {
      requests = run(stores);
    } catch (err) {
      // 同步异常（如内联键缺失）必须显式中止事务，否则已排队写入会自动提交
      try {
        transaction.abort();
      } catch {
        /* 事务可能已结束 */
      }
      reject(err instanceof Error ? err : new Error("作品库写入失败"));
      return;
    }
    const results: unknown[] = [];
    let settled = false;
    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(results);
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("作品库写入失败"));
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("作品库写入已中止"));
      }
    };
    for (const req of requests) {
      req.onsuccess = () => results.push(req.result);
    }
  });
}

function one(p: Promise<unknown[]>): Promise<unknown> {
  return p.then((r) => r[0]);
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  const db = await openDb();
  try {
    return (await one(
      tx(db, ["projects"], "readonly", (s) => [s.projects.get(id)]),
    )) as ProjectRecord | undefined;
  } finally {
    db.close();
  }
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const db = await openDb();
  try {
    const rows = (await tx(db, ["projects"], "readonly", (s) => [
      s.projects.getAll(),
    ])) as ProjectRecord[][];
    return (rows[0] ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

export async function listRevisions(
  projectId: string,
): Promise<RevisionMeta[]> {
  const db = await openDb();
  try {
    const rows = (await tx(db, ["revisions"], "readonly", (s) => [
      s.revisions.index("projectId").getAll(projectId),
    ])) as StoredRevision[][];
    return (rows[0] ?? [])
      .map(toRevisionMeta)
      .sort((a, b) => a.at - b.at);
  } finally {
    db.close();
  }
}

export async function getRevision(
  id: string,
): Promise<RevisionMeta | undefined> {
  const db = await openDb();
  try {
    const stored = (await one(
      tx(db, ["revisions"], "readonly", (s) => [s.revisions.get(id)]),
    )) as StoredRevision | undefined;
    return stored ? toRevisionMeta(stored) : undefined;
  } finally {
    db.close();
  }
}

export async function getHead(
  projectId: string,
): Promise<HeadRecord | undefined> {
  const db = await openDb();
  try {
    return (await one(
      tx(db, ["heads"], "readonly", (s) => [s.heads.get(projectId)]),
    )) as HeadRecord | undefined;
  } finally {
    db.close();
  }
}

export async function getResource(
  hash: string,
): Promise<ResourceRecord | undefined> {
  const db = await openDb();
  try {
    return (await one(
      tx(db, ["resources"], "readonly", (s) => [s.resources.get(hash)]),
    )) as ResourceRecord | undefined;
  } finally {
    db.close();
  }
}

export async function listMerges(projectId: string): Promise<MergeRecord[]> {
  const db = await openDb();
  try {
    const rows = (await tx(db, ["merges"], "readonly", (s) => [
      s.merges.index("projectId").getAll(projectId),
    ])) as MergeRecord[][];
    return (rows[0] ?? []).sort((a, b) => b.at - a.at);
  } finally {
    db.close();
  }
}

export async function listStaging(): Promise<StagingRecord[]> {
  const db = await openDb();
  try {
    const rows = (await tx(db, ["staging"], "readonly", (s) => [
      s.staging.getAll(),
    ])) as StagingRecord[][];
    return (rows[0] ?? []).sort((a, b) => b.receivedAt - a.receivedAt);
  } finally {
    db.close();
  }
}

// 临时区写入：尚未通过校验的包只允许停在这里，绝不触碰作品库
export async function putStaging(record: StagingRecord): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, ["staging"], "readwrite", (s) => [
      s.staging.put(record),
    ]);
  } finally {
    db.close();
  }
}

export async function deleteStaging(id: string): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, ["staging"], "readwrite", (s) => [s.staging.delete(id)]);
  } finally {
    db.close();
  }
}

export interface CommitInput {
  project: ProjectRecord;
  revision: RevisionMeta;
  resources: ResourceRecord[];
}

// 工程首次入库 / 本机新修订：单事务提交资源、修订、head、工程元数据
export async function commitRevision(input: CommitInput): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, ["resources", "projects", "revisions", "heads"], "readwrite", (s) => {
      const requests: IDBRequest[] = [];
      for (const resource of input.resources) {
        requests.push(s.resources.put(resource));
      }
      requests.push(
        s.revisions.put(toStoredRevision(input.project.id, input.revision)),
      );
      requests.push(
        s.heads.put({
          projectId: input.project.id,
          revisionId: input.revision.id,
        } satisfies HeadRecord),
      );
      requests.push(s.projects.put(input.project));
      return requests;
    });
  } finally {
    db.close();
  }
}

export interface MergeCommitInput {
  resources: ResourceRecord[];
  foreignRevisions: RevisionMeta[];
  head: HeadRecord;
  project: ProjectRecord;
  mergeRevision: RevisionMeta;
  mergeRecord: MergeRecord;
  stagingId: string;
}

// 合并提交：资源、对端修订链、合并修订、合并留痕、head 更新与临时区清理
// 在同一个事务内完成；任何一步失败（含配额异常）整体回滚，双方工程保持原样。
export async function commitMerge(input: MergeCommitInput): Promise<void> {
  const db = await openDb();
  try {
    await tx(
      db,
      ["resources", "revisions", "heads", "projects", "merges", "staging"],
      "readwrite",
      (s) => {
        const requests: IDBRequest[] = [];
        for (const resource of input.resources)
          requests.push(s.resources.put(resource));
        for (const revision of input.foreignRevisions)
          requests.push(
            s.revisions.put(toStoredRevision(input.project.id, revision)),
          );
        requests.push(
          s.revisions.put(toStoredRevision(input.project.id, input.mergeRevision)),
        );
        requests.push(s.heads.put(input.head));
        requests.push(s.projects.put(input.project));
        requests.push(s.merges.put(input.mergeRecord));
        requests.push(s.staging.delete(input.stagingId));
        return requests;
      },
    );
  } finally {
    db.close();
  }
}

// 合并前的容量预检：估算待写入字节，空间明显不足时直接拒绝，不产生任何写入
export async function assertSpace(bytes: number): Promise<void> {
  if (!navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  const quota = estimate.quota ?? 0;
  if (!quota) return;
  const remaining = quota - (estimate.usage ?? 0);
  // 预留 15% 余量给事务与后续修订
  if (remaining < bytes * 1.15) {
    throw new Error(
      `本机存储空间不足（需要约 ${formatBytes(
        bytes,
      )}），已取消合并，双方工程均未改动`,
    );
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export type { StagedPackage };
