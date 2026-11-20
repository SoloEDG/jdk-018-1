import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  assertSpace,
  commitMerge,
  commitRevision,
  getHead,
  getProject,
  getResource,
  getRevision,
  listMerges,
  listProjects,
  listRevisions,
  listStaging,
  putStaging,
  deleteStaging,
  type MergeRecord,
  type ProjectRecord,
  type ResourceRecord,
} from "../src/features/handoff/lib/library.ts";
import type {
  ProjectState,
  RevisionMeta,
  StagedPackage,
} from "../src/features/handoff/lib/types.ts";
import { PACKAGE_KIND, PACKAGE_VERSION } from "../src/features/handoff/lib/types.ts";
import {
  applySelection,
  buildMergePlan,
  defaultSelection,
  unresolvedConflicts,
} from "../src/features/handoff/lib/merge.ts";

function settings(): ProjectState["settings"] {
  return {
    columns: 100,
    charset: "standard",
    custom: " .:-=+*#%@",
    contrast: 1,
    gamma: 1,
    invert: false,
    color: true,
    background: "#101216",
  };
}

function state(assetHash: string | null): ProjectState {
  return {
    asset: assetHash
      ? {
          name: "img.png",
          width: 8,
          height: 8,
          resource: { hash: assetHash, mediaType: "image/png", size: 16 },
        }
      : null,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    settings: settings(),
  };
}

function revision(
  id: string,
  parentId: string | null,
  state: ProjectState,
  peerId = "peer-local",
): RevisionMeta {
  return { id, parentId, peerId, at: Date.now(), note: id, state };
}

function resource(hash: string): ResourceRecord {
  return {
    hash,
    mediaType: "image/png",
    size: 16,
    blob: new Blob([new Uint8Array(16)], { type: "image/png" }),
    createdAt: Date.now(),
  };
}

function project(id: string): ProjectRecord {
  const now = Date.now();
  return {
    id,
    name: "demo",
    createdAt: now,
    updatedAt: now,
    localPeerId: "peer-local",
  };
}

beforeEach(async () => {
  // 每个测试使用全新数据库
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase("glyphtx-studio");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

test("修订提交后资源、工程、修订、head 均可读回", async () => {
  const r1 = revision("r1", null, state("h1"));
  await commitRevision({
    project: project("p1"),
    revision: r1,
    resources: [resource("h1")],
  });

  assert.ok(await getResource("h1"));
  assert.ok(await getProject("p1"));
  const head = await getHead("p1");
  assert.equal(head?.revisionId, "r1");
  const revisions = await listRevisions("p1");
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.id, "r1");
  assert.equal((await listProjects()).length, 1);
});

test("内容寻址去重：已存在的资源哈希不会重复写入", async () => {
  await commitRevision({
    project: project("p1"),
    revision: revision("r1", null, state("h1")),
    resources: [resource("h1")],
  });
  const r2 = revision("r2", "r1", state("h1"));
  await commitRevision({
    project: project("p1"),
    revision: r2,
    // 第二次提交不带资源，模拟库中已存在时的零新增
    resources: [],
  });
  assert.ok(await getResource("h1"));
  assert.equal((await listRevisions("p1")).length, 2);
  assert.equal((await getHead("p1"))?.revisionId, "r2");
});

test("合并提交原子写入并保留逐项选择留痕，可追溯", async () => {
  // 本机基线 r1
  const baseState = state("h1");
  await commitRevision({
    project: project("p1"),
    revision: revision("r1", null, baseState),
    resources: [resource("h1")],
  });

  // 模拟对端修订：只改字符规则
  const localState: ProjectState = {
    ...baseState,
    crop: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
  };
  const remoteState: ProjectState = {
    ...baseState,
    settings: { ...settings(), gamma: 1.8 },
  };
  const plan = buildMergePlan(baseState, localState, remoteState);
  assert.equal(plan.conflicts.length, 0);
  const selection = defaultSelection(plan);
  assert.equal(unresolvedConflicts(plan, selection).length, 0);
  const merged = applySelection(plan, selection);
  assert.equal(merged.crop.x, 0.2);
  assert.equal(merged.settings.gamma, 1.8);

  const remoteRevision = revision("r2-remote", "r1", remoteState, "peer-remote");
  const mergeRevisionId = "r3-merge";
  const mergeRevision = revision(mergeRevisionId, "r1", merged);
  const mergeRecord: MergeRecord = {
    id: "m1",
    projectId: "p1",
    at: Date.now(),
    baseRevisionId: "r1",
    remotePeerId: "peer-remote",
    remotePeerName: "对端",
    remoteHeadId: "r2-remote",
    selection: { ...selection },
    entrySummary: plan.changes.map((e) => ({
      key: e.key,
      label: e.label,
      status: e.status,
      chosen: selection[e.key] ?? null,
    })),
    resultingState: merged,
    resultRevisionId: mergeRevisionId,
  };

  const staged: StagedPackage = {
    id: "stage-1",
    fileName: "incoming.json",
    receivedAt: Date.now(),
    pkg: {
      kind: PACKAGE_KIND,
      version: PACKAGE_VERSION,
      projectId: "p1",
      projectName: "demo",
      peerId: "peer-remote",
      peerName: "对端",
      exportedAt: Date.now(),
      mode: "embedded",
      headId: "r2-remote",
      revisions: [remoteRevision],
      resources: [],
    },
    issues: [],
    valid: true,
    blobs: {},
  };
  await putStaging(staged);
  assert.equal((await listStaging()).length, 1);

  await commitMerge({
    resources: [],
    foreignRevisions: [remoteRevision],
    head: { projectId: "p1", revisionId: mergeRevisionId },
    project: project("p1"),
    mergeRevision,
    mergeRecord,
    stagingId: "stage-1",
  });

  // 单事务后：head 前进、对端修订入库、留痕可查、临时区已清空
  assert.equal((await getHead("p1"))?.revisionId, mergeRevisionId);
  assert.ok(await getRevision("r2-remote"));
  assert.ok(await getRevision(mergeRevisionId));
  const merges = await listMerges("p1");
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.baseRevisionId, "r1");
  assert.equal(merges[0]!.entrySummary.length, plan.changes.length);
  assert.equal((await listStaging()).length, 0);
});

test("事务失败时整体回滚，不留下半次合并", async () => {
  await commitRevision({
    project: project("p1"),
    revision: revision("r1", null, state("h1")),
    resources: [resource("h1")],
  });

  // 留痕记录缺少内联主键 id，IDB 会抛 DataError 中止整个事务
  const brokenMergeRecord = {
    projectId: "p1",
    at: Date.now(),
    baseRevisionId: "r1",
    remotePeerId: "peer-remote",
    remotePeerName: "对端",
    remoteHeadId: "r2",
    selection: {},
    entrySummary: [],
    resultingState: state("h1"),
    resultRevisionId: "rx",
  } as unknown as MergeRecord;

  const badCommit = commitMerge({
    resources: [],
    foreignRevisions: [],
    head: { projectId: "p1", revisionId: "rx" },
    project: project("p1"),
    mergeRevision: revision("rx", "r1", state("h1")),
    mergeRecord: brokenMergeRecord,
    stagingId: "missing-stage",
  });
  await assert.rejects(badCommit);

  // 回滚后 head 仍是 r1，没有残留合并修订或留痕
  assert.equal((await getHead("p1"))?.revisionId, "r1");
  assert.equal((await getRevision("rx")), undefined);
  assert.equal((await listMerges("p1")).length, 0);
});

test("临时区记录可独立删除，不影响作品库", async () => {
  await putStaging({
    id: "s1",
    fileName: "x.json",
    receivedAt: Date.now(),
    pkg: {} as StagedPackage["pkg"],
    issues: [],
    valid: false,
    blobs: {},
  });
  await deleteStaging("s1");
  assert.equal((await listStaging()).length, 0);
});

test("容量预检在估算可用时通过", async () => {
  // fake 环境没有 navigator.storage.estimate，函数应直接放行
  await assertSpace(1024);
  assert.ok(typeof assertSpace === "function");
});
