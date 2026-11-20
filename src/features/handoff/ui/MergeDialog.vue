<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  X,
  GitMerge,
  AlertTriangle,
  CheckCircle2,
  FileImage,
  RefreshCw,
} from "lucide-vue-next";
import { useHandoff } from "../model/useHandoff";
import { drawGrid } from "../../preview";
import { gridRows } from "../../preview/lib/rows";
import type { MergeEntry } from "../lib/merge";
import type { AssetState } from "../lib/types";

const h = useHandoff();
const canvas = ref<HTMLCanvasElement>();

const previewDoc = computed(() =>
  h.showMerge.value && h.preview.value ? h.previewDoc() : null,
);
const textPreview = computed(() =>
  previewDoc.value?.grid
    ? gridRows(previewDoc.value.grid).join("\n")
    : "",
);

async function renderCanvas() {
  await nextTick();
  if (canvas.value && previewDoc.value?.grid) {
    drawGrid(
      canvas.value,
      previewDoc.value.grid,
      previewDoc.value.settings.color,
      previewDoc.value.settings.background,
    );
  }
}
watch(previewDoc, () => void renderCanvas(), { immediate: true });

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "（无原图）";
  if (typeof value === "boolean") return value ? "开" : "关";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "object") {
    const asset = value as AssetState;
    if (asset.resource) {
      return `${asset.name} · ${asset.width}×${asset.height} · ${asset.resource.hash.slice(0, 10)}`;
    }
  }
  return String(value);
}

const grouped = computed(() => {
  const plan = h.session.value?.plan;
  if (!plan) return [];
  const groups: Array<{ name: MergeEntry["group"]; entries: MergeEntry[] }> = [
    { name: "原图", entries: [] },
    { name: "裁剪", entries: [] },
    { name: "字符规则", entries: [] },
  ];
  for (const entry of plan.changes) {
    groups.find((g) => g.name === entry.group)!.entries.push(entry);
  }
  return groups.filter((g) => g.entries.length);
});

const statusText: Record<string, string> = {
  "local-only": "仅本机修改",
  "remote-only": "仅对端修改",
  auto: "双方一致修改",
  conflict: "冲突 · 必须选择",
  unchanged: "未变化",
};
</script>

<template>
  <div v-if="h.showMerge.value" class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal merge-modal">
      <header class="modal-header">
        <div>
          <span class="eyebrow"><GitMerge :size="12" /> THREE-WAY MERGE</span>
          <h3>合并预览 · 共同来源已校验</h3>
          <small class="muted">
            对端 {{ h.session.value?.pkg.peerName }} ·
            {{ h.session.value?.pkg.revisions.length }} 个修订 ·
            冲突不会按导入时间自动覆盖
          </small>
        </div>
        <button class="icon-button" aria-label="取消合并" @click="h.cancelMerge">
          <X :size="17" />
        </button>
      </header>

      <div v-if="h.session.value?.plan.conflicts.length" class="conflict-banner">
        <AlertTriangle :size="15" />
        {{ h.session.value.plan.conflicts.length }} 项双方修改了同一参数，必须逐项选择后才能提交
      </div>
      <div v-else class="ok-banner">
        <CheckCircle2 :size="15" /> 没有重叠修改，裁剪与字符规则变化将自动组合
      </div>

      <div class="merge-body">
        <div class="merge-entries">
          <section v-for="group in grouped" :key="group.name" class="merge-group">
            <h4>{{ group.name }}</h4>
            <article
              v-for="entry in group.entries"
              :key="entry.key"
              class="merge-entry"
              :class="{ conflict: entry.status === 'conflict' }"
            >
              <div class="entry-head">
                <span class="entry-label">
                  <FileImage v-if="entry.group === '原图'" :size="12" />
                  {{ entry.label }}
                </span>
                <span class="entry-status" :class="entry.status">
                  {{ statusText[entry.status] }}
                </span>
              </div>
              <div class="entry-options">
                <button
                  class="option"
                  :class="{
                    picked: h.session.value?.selection[entry.key] === 'local',
                  }"
                  @click="h.choose(entry.key, 'local')"
                >
                  <small>本机</small>
                  <span>{{ formatValue(entry.local) }}</span>
                </button>
                <button
                  class="option"
                  :class="{
                    picked: h.session.value?.selection[entry.key] === 'remote',
                  }"
                  @click="h.choose(entry.key, 'remote')"
                >
                  <small>对端</small>
                  <span>{{ formatValue(entry.remote) }}</span>
                </button>
              </div>
              <small v-if="entry.status === 'conflict'" class="base-note muted">
                共同来源值：{{ formatValue(entry.base) }}
              </small>
            </article>
          </section>
        </div>

        <div class="merge-preview">
          <div class="preview-mode-label">
            <RefreshCw :size="12" /> 选择变化后按同布局实时重新生成
          </div>
          <div v-if="h.previewError.value" class="preview-error">
            {{ h.previewError.value }}
          </div>
          <div v-else-if="previewDoc?.grid" class="merge-canvas-scroll">
            <canvas ref="canvas" />
            <pre class="merge-text">{{ textPreview }}</pre>
          </div>
          <div v-else class="preview-placeholder">正在生成合并预览…</div>
          <div class="preview-meta mono muted">
            {{ previewDoc?.grid?.columns ?? "--" }} COL ×
            {{ previewDoc?.grid?.rows ?? "--" }} ROW
          </div>
        </div>
      </div>

      <footer class="modal-footer">
        <small class="muted">
          取消后临时区与双方工程完整保留；提交为单事务原子写入，空间不足不会留下半次合并
        </small>
        <div class="footer-actions">
          <button class="secondary" @click="h.cancelMerge">取消</button>
          <button
            class="primary"
            :disabled="h.busy.value || h.unresolved.value.length > 0"
            @click="void h.commit()"
          >
            <GitMerge :size="14" />
            {{ h.unresolved.value.length
              ? `还有 ${h.unresolved.value.length} 项冲突待选`
              : "确认合并并入库" }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
