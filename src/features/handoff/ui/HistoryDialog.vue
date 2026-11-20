<script setup lang="ts">
import { X, History, GitMerge } from "lucide-vue-next";
import { useHandoff } from "../model/useHandoff";

const h = useHandoff();

const statusText: Record<string, string> = {
  "local-only": "仅本机修改",
  "remote-only": "仅对端修改",
  auto: "双方一致",
  conflict: "冲突",
  unchanged: "未变化",
};
</script>

<template>
  <div v-if="h.showHistory.value" class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal history-modal">
      <header class="modal-header">
        <div>
          <span class="eyebrow"><History :size="12" /> AUDIT TRAIL</span>
          <h3>合并追溯 · 结果由哪些选择产生</h3>
          <small class="muted">
            每次合并的共同来源、对端修订与逐项选择均持久保存在本机作品库
          </small>
        </div>
        <button
          class="icon-button"
          aria-label="关闭追溯"
          @click="h.showHistory.value = false"
        >
          <X :size="17" />
        </button>
      </header>

      <div class="history-body">
        <article v-for="merge in h.merges.value" :key="merge.id" class="history-card">
          <header>
            <GitMerge :size="14" />
            <strong>{{ new Date(merge.at).toLocaleString() }}</strong>
            <span class="badge ok">{{ merge.remotePeerName }}</span>
          </header>
          <small class="mono muted">
            共同来源修订 {{ merge.baseRevisionId?.slice(0, 8) ?? "—" }} ·
            对端头 {{ merge.remoteHeadId.slice(0, 8) }} ·
            结果修订 {{ merge.resultRevisionId.slice(0, 8) }}
          </small>
          <table class="trace-table">
            <thead>
              <tr><th>参数</th><th>变化类型</th><th>最终采用</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in merge.entrySummary" :key="row.key">
                <td>{{ row.label }}</td>
                <td>
                  <span class="entry-status" :class="row.status">
                    {{ statusText[row.status] ?? row.status }}
                  </span>
                </td>
                <td>{{ row.chosen === "local" ? "本机" : row.chosen === "remote" ? "对端" : "—" }}</td>
              </tr>
            </tbody>
          </table>
        </article>
        <div v-if="!h.merges.value.length" class="preview-placeholder">
          该工程还没有合并记录
        </div>
      </div>
    </div>
  </div>
</template>
