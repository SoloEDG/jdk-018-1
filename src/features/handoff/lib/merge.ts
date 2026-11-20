import type { CropState, ProjectState, SettingsState } from "./types";

// 字段级三方合并引擎：base 为共同来源，local 为本机，remote 为对端带回的工程
export type Side = "local" | "remote";
export type EntryStatus =
  | "unchanged"
  | "local-only"
  | "remote-only"
  | "auto"
  | "conflict";

export interface MergeEntry {
  key: string;
  label: string;
  group: "原图" | "裁剪" | "字符规则";
  path: string[];
  base: unknown;
  local: unknown;
  remote: unknown;
  status: EntryStatus;
  // 无冲突时的默认取值；冲突项为空，必须由用户显式选择
  autoSide: Side | null;
}

export interface MergePlan {
  entries: MergeEntry[];
  conflicts: MergeEntry[];
  changes: MergeEntry[];
  base: ProjectState | null;
  local: ProjectState;
  remote: ProjectState;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function leaf(
  key: string,
  label: string,
  group: MergeEntry["group"],
  path: string[],
  base: unknown,
  local: unknown,
  remote: unknown,
): MergeEntry {
  let status: EntryStatus;
  let autoSide: Side | null = null;
  if (eq(local, remote)) {
    status = eq(local, base) ? "unchanged" : "auto";
    if (status === "auto") autoSide = "local";
  } else if (eq(local, base)) {
    status = "remote-only";
    autoSide = "remote";
  } else if (eq(remote, base)) {
    status = "local-only";
    autoSide = "local";
  } else {
    // 双方都改了同一参数且取值不同：明确冲突，绝不按导入时间覆盖
    status = "conflict";
  }
  return { key, label, group, path, base, local, remote, status, autoSide };
}

function at(state: ProjectState, path: string[]): unknown {
  let cur: unknown = state;
  for (const p of path) cur = (cur as Record<string, unknown>)[p];
  return cur;
}

export function buildMergePlan(
  base: ProjectState | null,
  local: ProjectState,
  remote: ProjectState,
): MergePlan {
  const b = base ?? local; // 没有共同来源时以本机为基线，全部差异都会显式呈现
  const entries: MergeEntry[] = [];

  entries.push(
    leaf(
      "asset",
      "原图",
      "原图",
      ["asset"],
      b.asset,
      local.asset,
      remote.asset,
    ),
  );

  const cropFields: Array<[keyof CropState, string]> = [
    ["x", "裁剪起点 X"],
    ["y", "裁剪起点 Y"],
    ["width", "裁剪宽度"],
    ["height", "裁剪高度"],
  ];
  for (const [key, label] of cropFields) {
    entries.push(
      leaf(
        `crop.${key}`,
        label,
        "裁剪",
        ["crop", key],
        b.crop[key],
        local.crop[key],
        remote.crop[key],
      ),
    );
  }

  const settingFields: Array<[keyof SettingsState, string]> = [
    ["columns", "字符密度"],
    ["charset", "字符集"],
    ["custom", "自定义字符"],
    ["contrast", "对比度"],
    ["gamma", "伽马"],
    ["invert", "反转明暗"],
    ["color", "彩色输出"],
    ["background", "背景色"],
  ];
  for (const [key, label] of settingFields) {
    entries.push(
      leaf(
        `settings.${key}`,
        label,
        "字符规则",
        ["settings", key],
        b.settings[key],
        local.settings[key],
        remote.settings[key],
      ),
    );
  }

  const changes = entries.filter((e) => e.status !== "unchanged");
  const conflicts = entries.filter((e) => e.status === "conflict");
  return { entries, conflicts, changes, base, local, remote };
}

// 逐项选择：冲突项必须显式选择，其余项可沿用自动结果或改选任意一方
export type Selection = Record<string, Side>;

export function defaultSelection(plan: MergePlan): Selection {
  const selection: Selection = {};
  for (const entry of plan.entries) {
    if (entry.autoSide) selection[entry.key] = entry.autoSide;
  }
  return selection;
}

export function unresolvedConflicts(plan: MergePlan, selection: Selection) {
  return plan.conflicts.filter((c) => !selection[c.key]);
}

function writePath(state: ProjectState, path: string[], value: unknown) {
  const target = path.slice(0, -1).reduce<Record<string, unknown>>(
    (cur, key) => cur[key] as Record<string, unknown>,
    state as unknown as Record<string, unknown>,
  );
  target[path[path.length - 1]!] = value;
}

export function applySelection(
  plan: MergePlan,
  selection: Selection,
): ProjectState {
  const merged: ProjectState = JSON.parse(JSON.stringify(plan.local)) as ProjectState;
  for (const entry of plan.entries) {
    if (entry.status === "unchanged") continue;
    const side = selection[entry.key];
    // 未显式选择的条目回退到共同来源值，而不是隐式偏向本机
    const value = side
      ? side === "local"
        ? entry.local
        : entry.remote
      : entry.base;
    writePath(merged, entry.path, value);
  }
  return merged;
}

export { at as valueAt };
