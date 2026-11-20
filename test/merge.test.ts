import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySelection,
  buildMergePlan,
  defaultSelection,
  unresolvedConflicts,
} from "../src/features/handoff/lib/merge.ts";
import type { ProjectState } from "../src/features/handoff/lib/types.ts";

function settings(over = {}): ProjectState["settings"] {
  return {
    columns: 100,
    charset: "standard",
    custom: " .:-=+*#%@",
    contrast: 1,
    gamma: 1,
    invert: false,
    color: true,
    background: "#101216",
    ...over,
  };
}

function state(over: Partial<ProjectState> = {}): ProjectState {
  return {
    asset: over.asset ?? null,
    crop: over.crop ?? { x: 0, y: 0, width: 1, height: 1 },
    settings: over.settings ?? settings(),
  };
}

const base = state({
  crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  settings: settings({ contrast: 1, gamma: 1, charset: "standard" }),
});

test("一方只改裁剪、另一方只改字符规则时自动组合，无冲突", () => {
  const local = state({
    crop: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
    settings: settings({ contrast: 1, gamma: 1 }),
  });
  const remote = state({
    crop: base.crop,
    settings: settings({ contrast: 1, gamma: 1.6, charset: "blocks" }),
  });
  const plan = buildMergePlan(base, local, remote);
  assert.equal(plan.conflicts.length, 0);

  const selection = defaultSelection(plan);
  assert.equal(unresolvedConflicts(plan, selection).length, 0);
  const merged = applySelection(plan, selection);

  // 本机裁剪 + 对端字符规则被组合到一起
  assert.deepEqual(merged.crop, local.crop);
  assert.equal(merged.settings.gamma, 1.6);
  assert.equal(merged.settings.charset, "blocks");
  assert.equal(merged.settings.contrast, 1);
});

test("双方改同一参数且取值不同时必须标记冲突，不能自动选择", () => {
  const local = state({ settings: settings({ gamma: 1.4 }) });
  const remote = state({ settings: settings({ gamma: 0.6 }) });
  const plan = buildMergePlan(base, local, remote);
  const gammaEntry = plan.entries.find((e) => e.key === "settings.gamma");
  assert.ok(gammaEntry);
  assert.equal(gammaEntry!.status, "conflict");

  const selection = defaultSelection(plan);
  assert.equal(selection["settings.gamma"], undefined);
  assert.equal(unresolvedConflicts(plan, selection).length, 1);

  // 未解决冲突前无法得到包含该字段选择的结果，显式选择后才落地
  selection["settings.gamma"] = "remote";
  assert.equal(unresolvedConflicts(plan, selection).length, 0);
  const merged = applySelection(plan, selection);
  assert.equal(merged.settings.gamma, 0.6);
});

test("双方都更换原图时按资源哈希判定冲突，而不是按导入时间覆盖", () => {
  const assetA = {
    name: "a.png",
    width: 10,
    height: 10,
    resource: { hash: "hash-a", mediaType: "image/png", size: 100 },
  };
  const assetB = {
    name: "b.png",
    width: 12,
    height: 12,
    resource: { hash: "hash-b", mediaType: "image/png", size: 120 },
  };
  const local = state({ asset: assetA });
  const remote = state({ asset: assetB });
  const plan = buildMergePlan(base, local, remote);
  const assetEntry = plan.entries.find((e) => e.key === "asset");
  assert.equal(assetEntry!.status, "conflict");
  const selection = defaultSelection(plan);
  assert.equal(selection.asset, undefined);

  selection.asset = "local";
  const merged = applySelection(plan, selection);
  assert.deepEqual(merged.asset, assetA);
});

test("仅一方更换原图属于单边修改，可直接采用且不产生冲突", () => {
  const assetA = {
    name: "a.png",
    width: 10,
    height: 10,
    resource: { hash: "hash-a", mediaType: "image/png", size: 100 },
  };
  const local = state();
  const remote = state({ asset: assetA });
  const plan = buildMergePlan(base, local, remote);
  assert.equal(plan.conflicts.length, 0);
  const selection = defaultSelection(plan);
  const merged = applySelection(plan, selection);
  assert.deepEqual(merged.asset, assetA);
});

test("双方做了相同修改时识别为一致修改而不是冲突", () => {
  const local = state({ settings: settings({ invert: true }) });
  const remote = state({ settings: settings({ invert: true }) });
  const plan = buildMergePlan(base, local, remote);
  const entry = plan.entries.find((e) => e.key === "settings.invert")!;
  assert.equal(entry.status, "auto");
  assert.equal(plan.conflicts.length, 0);
  const merged = applySelection(plan, defaultSelection(plan));
  assert.equal(merged.settings.invert, true);
});

test("逐项选择允许覆盖自动结果，合并结果完全由选择决定", () => {
  const local = state({
    crop: { ...base.crop, x: 0.3, width: 0.7 },
  });
  const remote = state({
    crop: { ...base.crop },
    settings: settings({ columns: 160 }),
  });
  const plan = buildMergePlan(base, local, remote);
  const selection = defaultSelection(plan);
  // 用户把自动采用本机的裁剪改选回对端（即基线裁剪）
  selection["crop.x"] = "remote";
  selection["crop.width"] = "remote";
  const merged = applySelection(plan, selection);
  assert.equal(merged.crop.x, base.crop.x);
  assert.equal(merged.crop.width, base.crop.width);
  assert.equal(merged.crop.y, base.crop.y);
  assert.equal(merged.crop.height, base.crop.height);
  assert.equal(merged.settings.columns, 160);
});
