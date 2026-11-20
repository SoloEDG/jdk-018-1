import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePackage, buildPackage } from "../src/features/handoff/lib/packages.ts";
import {
  PACKAGE_KIND,
  PACKAGE_VERSION,
  type HandoffPackage,
  type ProjectState,
  type RevisionMeta,
} from "../src/features/handoff/lib/types.ts";

// Node 环境没有 indexedDB，去重分支会被跳过；内嵌校验与结构校验完整可测
function stateWithAsset(hash: string): ProjectState {
  return {
    asset: {
      name: "img.png",
      width: 4,
      height: 4,
      resource: { hash, mediaType: "image/png", size: 10 },
    },
    crop: { x: 0, y: 0, width: 1, height: 1 },
    settings: {
      columns: 100,
      charset: "standard",
      custom: " .",
      contrast: 1,
      gamma: 1,
      invert: false,
      color: true,
      background: "#000000",
    },
  };
}

function revision(state: ProjectState, parentId: string | null = null): RevisionMeta {
  return {
    id: crypto.randomUUID(),
    parentId,
    peerId: "peer-a",
    at: Date.now(),
    note: "r",
    state,
  };
}

function pkg(partial: Partial<HandoffPackage> = {}): HandoffPackage {
  const state = stateWithAsset("0".repeat(64));
  const r = revision(state);
  return {
    kind: PACKAGE_KIND,
    version: PACKAGE_VERSION,
    projectId: "p1",
    projectName: "demo",
    peerId: "peer-a",
    peerName: "A",
    exportedAt: Date.now(),
    mode: "embedded",
    headId: r.id,
    revisions: [r],
    resources: [],
    ...partial,
  };
}

test("非法 JSON 直接报格式错误", async () => {
  const result = await validatePackage("not-json{", "x.json");
  assert.ok(result.issues.some((i) => i.code === "format" && i.level === "error"));
  assert.equal(result.blobs && Object.keys(result.blobs).length, 0);
});

test("未来版本必须被拦截，不能进入作品库", async () => {
  const result = await validatePackage(
    JSON.stringify(pkg({ version: 999 })),
    "future.json",
  );
  assert.ok(result.issues.some((i) => i.code === "future-version"));
});

test("内嵌模式下声明了资源但缺少 data URL 判定为断裂引用", async () => {
  const p = pkg({
    resources: [
      { hash: "0".repeat(64), mediaType: "image/png" },
    ],
  });
  const result = await validatePackage(JSON.stringify(p), "broken.json");
  assert.ok(result.issues.some((i) => i.code === "broken-ref"));
});

test("资源 data URL 哈希不匹配判定为损坏文件", async () => {
  const p = pkg({
    resources: [
      {
        hash: "0".repeat(64),
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
    ],
  });
  const result = await validatePackage(JSON.stringify(p), "corrupt.json");
  assert.ok(result.issues.some((i) => i.code === "corrupt"));
});

test("修订引用了资源清单里不存在的哈希判定为断裂引用", async () => {
  const p = pkg({ resources: [] });
  const result = await validatePackage(JSON.stringify(p), "missing.json");
  assert.ok(result.issues.some((i) => i.code === "broken-ref"));
});

test("head 修订不在修订链中判定为结构错误", async () => {
  const p = pkg({ headId: "not-in-chain" });
  const result = await validatePackage(JSON.stringify(p), "head.json");
  assert.ok(result.issues.some((i) => i.code === "structure"));
});

test("buildPackage 在资源缺失或库不可用时拒绝导出", async () => {
  await assert.rejects(
    () =>
      buildPackage({
        projectId: "p1",
        projectName: "demo",
        peerId: "peer-a",
        peerName: "A",
        mode: "dedup",
        headId: "r1",
        revisions: [revision(stateWithAsset("a".repeat(64)))],
      }),
    /缺失|不支持/,
  );
});
