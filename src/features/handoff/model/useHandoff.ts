import { computed, ref } from "vue";
import type {
  HandoffPackage,
  ProjectState,
  RevisionMeta,
  StagedPackage,
} from "../lib/types";
import { PACKAGE_EXTENSION } from "../lib/types";
import { dataUrlToBlob, hashBlob, uuid } from "../lib/digest";
import { captureState, sameState } from "../lib/snapshot";
import { localPeer } from "../lib/identity";
import {
  assertSpace,
  commitMerge,
  commitRevision,
  deleteStaging,
  formatBytes,
  getHead,
  getProject,
  getResource,
  getRevision,
  listMerges,
  listProjects,
  listRevisions,
  listStaging,
  putStaging,
  type MergeRecord,
  type ProjectRecord,
  type ResourceRecord,
} from "../lib/library";
import { buildPackage, findMergeBase, validatePackage } from "../lib/packages";
import {
  applySelection,
  buildMergePlan,
  defaultSelection,
  unresolvedConflicts,
  type MergePlan,
  type Selection,
} from "../lib/merge";
import { restoreAsset } from "../lib/restore";
import { download } from "../../export/lib/download";
import { generate } from "../../mapping";
import type { Asset, StudioDocument } from "../../../shared/document";
import { useStudio } from "../../../shared/useStudio";

interface MergeSession {
  stagingId: string;
  pkg: HandoffPackage;
  plan: MergePlan;
  selection: Selection;
  baseRevisionId: string | null;
}

interface PreviewState {
  state: ProjectState;
  asset: Asset | null;
}

// 模块级单例：多个组件（面板 / 合并弹窗 / 追溯弹窗）共享同一份交接状态
const peer = localPeer();
const projects = ref<ProjectRecord[]>([]);
const revisions = ref<RevisionMeta[]>([]);
const merges = ref<MergeRecord[]>([]);
const staging = ref<StagedPackage[]>([]);
const busy = ref(false);
const mode = ref<"embedded" | "dedup">("embedded");

const showMerge = ref(false);
const session = ref<MergeSession | null>(null);
const preview = ref<PreviewState | null>(null);
const previewError = ref("");
const showHistory = ref(false);

export function useHandoff() {
  const { doc, notice, invalidate, currentProjectId } = useStudio();

  const currentProject = computed(() =>
    projects.value.find((p) => p.id === currentProjectId.value) ?? null,
  );
  const unresolved = computed(() =>
    session.value
      ? unresolvedConflicts(session.value.plan, session.value.selection)
      : [],
  );

  async function refreshLibrary() {
    projects.value = await listProjects();
    staging.value = await listStaging();
    if (currentProjectId.value) {
      revisions.value = await listRevisions(currentProjectId.value);
      merges.value = await listMerges(currentProjectId.value);
    } else {
      revisions.value = [];
      merges.value = [];
    }
  }

  // ---- 本机工程入库：内容寻址资源 + 修订链 --------------------------------
  async function ensureResourceForState(
    state: ProjectState,
    blobOverride?: Blob,
  ): Promise<ResourceRecord[]> {
    if (!state.asset) return [];
    const hash = state.asset.resource.hash;
    const existing = await getResource(hash);
    if (existing) return [];
    let blob = blobOverride;
    if (!blob && doc.asset) {
      const candidate = dataUrlToBlob(doc.asset.url);
      if ((await hashBlob(candidate)) === hash) blob = candidate;
    }
    if (!blob) {
      throw new Error("原图资源缺失，无法保存到作品库");
    }
    return [
      {
        hash,
        mediaType: state.asset.resource.mediaType,
        size: state.asset.resource.size,
        blob,
        createdAt: Date.now(),
      },
    ];
  }

  async function saveCurrent(note = "本机修订"): Promise<string> {
    if (!doc.asset) throw new Error("请先载入原图再保存工程");
    busy.value = true;
    try {
      const state = await captureState(doc);
      const head = currentProjectId.value
        ? await getHead(currentProjectId.value)
        : undefined;
      if (head) {
        const last = await getRevision(head.revisionId);
        if (last && sameState(last.state, state)) {
          notice.value = "没有需要保存的变化";
          return currentProjectId.value!;
        }
      }
      const blob = doc.asset ? dataUrlToBlob(doc.asset.url) : undefined;
      const resources = await ensureResourceForState(state, blob);
      const now = Date.now();
      let project: ProjectRecord;
      const revisionId = uuid();
      if (currentProjectId.value) {
        const existing = await getProject(currentProjectId.value);
        if (!existing) throw new Error("作品库中的工程已不存在");
        project = { ...existing, updatedAt: now };
      } else {
        project = {
          id: uuid(),
          name: doc.asset.name.replace(/\.[^.]+$/, ""),
          createdAt: now,
          updatedAt: now,
          localPeerId: peer.peerId,
        };
        currentProjectId.value = project.id;
      }
      const revision: RevisionMeta = {
        id: revisionId,
        parentId: head?.revisionId ?? null,
        peerId: peer.peerId,
        at: now,
        note,
        state,
      };
      const incomingBytes =
        resources.reduce((sum, r) => sum + r.size, 0) +
        JSON.stringify(revision).length;
      await assertSpace(incomingBytes);
      await commitRevision({ project, revision, resources });
      await refreshLibrary();
      notice.value = `已保存到本机作品库（修订 ${revisionId.slice(0, 8)}）`;
      return project.id;
    } finally {
      busy.value = false;
    }
  }

  // ---- 导出交接工程 -------------------------------------------------------
  async function exportHandoff() {
    if (!currentProjectId.value) {
      await saveCurrent("交接前保存");
    }
    const projectId = currentProjectId.value;
    if (!projectId) throw new Error("工程尚未入库，无法交接");
    busy.value = true;
    try {
      const project = await getProject(projectId);
      const head = await getHead(projectId);
      if (!project || !head) throw new Error("作品库记录不完整");
      const chain = await listRevisions(projectId);
      const pkg = await buildPackage({
        projectId,
        projectName: project.name,
        peerId: peer.peerId,
        peerName: peer.peerName,
        mode: mode.value,
        headId: head.revisionId,
        revisions: chain,
      });
      const blob = new Blob([JSON.stringify(pkg, null, 2)], {
        type: "application/json",
      });
      const safeName = project.name.replace(/[^\p{L}\p{N}_-]/gu, "_");
      download(blob, `${safeName}${PACKAGE_EXTENSION}`);
      notice.value =
        mode.value === "embedded"
          ? "完整内嵌工程已导出，可离线交接"
          : "去重引用工程已导出，接收方需持有相同原图资源";
    } finally {
      busy.value = false;
    }
  }

  // ---- 导入：先全部落入临时区校验 ----------------------------------------
  async function importFile(file?: File) {
    if (!file) return;
    busy.value = true;
    try {
      const raw = await file.text();
      const { pkg, issues, blobs } = await validatePackage(raw, file.name);
      const record: StagedPackage = {
        id: uuid(),
        fileName: file.name,
        receivedAt: Date.now(),
        pkg,
        issues,
        valid: !issues.some((i) => i.level === "error"),
        blobs,
      };
      await putStaging(record);
      await refreshLibrary();
      notice.value = record.valid
        ? `工程已进入临时区并通过校验：${file.name}`
        : `工程校验未通过，已保留在临时区：${file.name}`;
    } catch (e) {
      notice.value = e instanceof Error ? e.message : "工程读取失败";
    } finally {
      busy.value = false;
    }
  }

  // ---- 打开合并预览（取消不触碰作品库，双方工程完整保留） ----------------
  async function openMerge(record: StagedPackage) {
    if (!record.valid) {
      notice.value = "校验未通过的工程不能合并，请先处理临时区问题";
      return;
    }
    const localProject = await getProject(record.pkg.projectId);
    if (!localProject) {
      notice.value = "本机没有共同来源的工程，无法合并；可在临时区查看后移除";
      return;
    }
    const base = await findMergeBase(record.pkg.projectId, record.pkg.revisions);
    if (!base) {
      notice.value = "两条修订链没有共同来源，拒绝按时间覆盖式合并";
      return;
    }
    const head = await getHead(record.pkg.projectId);
    const localRevision = head
      ? ((await getRevision(head.revisionId)) ?? base)
      : base;
    const remoteRevision =
      record.pkg.revisions.find((r) => r.id === record.pkg.headId) ??
      record.pkg.revisions[record.pkg.revisions.length - 1]!;
    const plan = buildMergePlan(
      base.state,
      localRevision.state,
      remoteRevision.state,
    );
    session.value = {
      stagingId: record.id,
      pkg: record.pkg,
      plan,
      selection: defaultSelection(plan),
      baseRevisionId: base.id,
    };
    previewError.value = "";
    showMerge.value = true;
    await rebuildPreview();
  }

  function choose(key: string, side: "local" | "remote") {
    if (!session.value) return;
    session.value.selection[key] = side;
    void rebuildPreview();
  }

  // 合并预览：按当前逐项选择重新生成同布局的文本与图片，不影响工作台
  async function rebuildPreview() {
    if (!session.value) return;
    previewError.value = "";
    try {
      const state = applySelection(
        session.value.plan,
        session.value.selection,
      );
      const asset = await restoreAsset(
        state,
        session.value.pkg.mode === "embedded"
          ? (await stagingBlob(state))
          : undefined,
      );
      preview.value = { state, asset };
    } catch (e) {
      preview.value = null;
      previewError.value = e instanceof Error ? e.message : "预览生成失败";
    }
  }

  async function stagingBlob(state: ProjectState): Promise<Blob | undefined> {
    if (!state.asset) return undefined;
    const staged = staging.value.find((s) => s.id === session.value?.stagingId);
    return staged?.blobs[state.asset.resource.hash];
  }

  function previewDoc(): StudioDocument | null {
    if (!preview.value?.asset) return null;
    const state = preview.value.state;
    const d: StudioDocument = {
      asset: preview.value.asset,
      crop: { ...state.crop },
      settings: { ...state.settings },
      grid: null,
      revision: 0,
    };
    d.grid = generate(d);
    return d;
  }

  // ---- 提交合并：单事务原子写入，配额不足整体回滚 ------------------------
  async function commit() {
    if (!session.value) return;
    if (unresolved.value.length) {
      notice.value = `还有 ${unresolved.value.length} 项冲突必须显式选择`;
      return;
    }
    busy.value = true;
    try {
      const s = session.value;
      const mergedState = applySelection(s.plan, s.selection);
      const project = await getProject(s.pkg.projectId);
      if (!project) throw new Error("本机工程已不存在，合并已中止");
      const head = await getHead(project.id);
      if (!head) throw new Error("本机修订头缺失，合并已中止");

      // 收集需要新写入的资源（内容寻址，已存在则自动去重）
      const staged = staging.value.find((x) => x.id === s.stagingId);
      const resources: ResourceRecord[] = [];
      let newBytes = 0;
      const needed = new Set<string>();
      for (const revision of s.pkg.revisions) {
        if (revision.state.asset) needed.add(revision.state.asset.resource.hash);
      }
      if (mergedState.asset) needed.add(mergedState.asset.resource.hash);
      for (const hash of needed) {
        if (await getResource(hash)) continue;
        const blob = staged?.blobs[hash];
        if (!blob) {
          throw new Error(`资源 ${hash.slice(0, 8)} 引用断裂，合并已中止`);
        }
        const meta = s.pkg.resources.find((r) => r.hash === hash);
        if (!meta) {
          throw new Error(`资源 ${hash.slice(0, 8)} 缺少清单元数据，合并已中止`);
        }
        resources.push({
          hash,
          mediaType: meta.mediaType,
          size: blob.size,
          blob,
          createdAt: Date.now(),
        });
        newBytes += blob.size;
      }

      const foreign: RevisionMeta[] = [];
      for (const revision of s.pkg.revisions) {
        const exists = await getRevision(revision.id);
        if (!exists) foreign.push(revision);
      }
      const now = Date.now();
      const mergeRevisionId = uuid();
      const mergeRevision: RevisionMeta = {
        id: mergeRevisionId,
        parentId: head.revisionId,
        peerId: peer.peerId,
        at: now,
        note: `合并自 ${s.pkg.peerName}`,
        state: mergedState,
      };
      const entrySummary = s.plan.changes.map((entry) => ({
        key: entry.key,
        label: entry.label,
        status: entry.status,
        chosen: s.selection[entry.key] ?? null,
      }));
      const mergeRecord: MergeRecord = {
        id: uuid(),
        projectId: project.id,
        at: now,
        baseRevisionId: s.baseRevisionId,
        remotePeerId: s.pkg.peerId,
        remotePeerName: s.pkg.peerName,
        remoteHeadId: s.pkg.headId,
        selection: { ...s.selection },
        entrySummary,
        resultingState: mergedState,
        resultRevisionId: mergeRevisionId,
      };
      newBytes +=
        JSON.stringify(foreign).length +
        JSON.stringify(mergeRevision).length +
        JSON.stringify(mergeRecord).length;
      await assertSpace(newBytes);

      await commitMerge({
        resources,
        foreignRevisions: foreign,
        head: { projectId: project.id, revisionId: mergeRevisionId },
        project: { ...project, updatedAt: now },
        mergeRevision,
        mergeRecord,
        stagingId: s.stagingId,
      });

      // 提交成功后把结果带回工作台
      await loadProjectState(project.id, mergedState);
      showMerge.value = false;
      session.value = null;
      preview.value = null;
      await refreshLibrary();
      notice.value =
        s.plan.conflicts.length > 0
          ? `合并完成：${s.plan.conflicts.length} 项冲突已按你的选择解决，选择已存档可追溯`
          : "合并完成，非重叠修改已自动组合，选择已存档";
    } catch (e) {
      notice.value = e instanceof Error ? e.message : "合并失败，双方工程保持原样";
    } finally {
      busy.value = false;
    }
  }

  function cancelMerge() {
    // 仅关闭会话：临时区记录与双方工程都原样保留
    showMerge.value = false;
    session.value = null;
    preview.value = null;
    previewError.value = "";
    notice.value = "已取消合并，本机与对端工程均未改动";
  }

  async function discardStaging(id: string) {
    await deleteStaging(id);
    await refreshLibrary();
    notice.value = "临时区工程已移除（双方原始工程不受影响）";
  }

  // ---- 作品库操作 ---------------------------------------------------------
  async function openProject(id: string) {
    const head = await getHead(id);
    if (!head) throw new Error("工程修订头缺失");
    const revision = await getRevision(head.revisionId);
    if (!revision) throw new Error(`修订 ${head.revisionId.slice(0, 8)} 不存在`);
    await loadProjectState(id, revision.state);
    await refreshLibrary();
    notice.value = `已打开工程修订 ${revision.id.slice(0, 8)}`;
  }

  async function loadProjectState(id: string, state: ProjectState) {
    const asset = await restoreAsset(state);
    currentProjectId.value = id;
    doc.asset = asset;
    doc.crop = { ...state.crop };
    Object.assign(doc.settings, state.settings);
    invalidate();
  }

  return {
    peer,
    projects,
    revisions,
    merges,
    staging,
    busy,
    mode,
    showMerge,
    session,
    preview,
    previewError,
    unresolved,
    currentProject,
    showHistory,
    refreshLibrary,
    saveCurrent,
    exportHandoff,
    importFile,
    openMerge,
    choose,
    previewDoc,
    commit,
    cancelMerge,
    discardStaging,
    openProject,
    formatBytes,
  };
}
