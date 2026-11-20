<script setup lang="ts">
import { onMounted } from "vue";
import {
  FolderGit2,
  PackageOpen,
  Save,
  Send,
  Upload,
  Trash2,
  GitMerge,
  History,
  HardDriveDownload,
} from "lucide-vue-next";
import { useHandoff } from "../model/useHandoff";

const h = useHandoff();
onMounted(() => void h.refreshLibrary());

function pickFile(e: Event) {
  const input = e.target as HTMLInputElement;
  void h.importFile(input.files?.[0]);
  input.value = "";
}
</script>

<template>
  <section class="panel handoff-panel">
    <div class="section-title">
      <span>04 / HANDOFF</span><FolderGit2 :size="15" />
    </div>

    <div class="handoff-project" v-if="h.currentProject.value">
      <small class="muted">当前作品库工程</small>
      <strong>{{ h.currentProject.value.name }}</strong>
      <small class="mono muted">
        {{ h.revisions.value.length }} 个修订 ·
        {{ h.merges.value.length }} 次合并
      </small>
      <button
        v-if="h.merges.value.length"
        class="secondary history-button"
        @click="h.showHistory.value = true"
      >
        <History :size="13" /> 查看合并追溯
      </button>
    </div>

    <div class="handoff-actions">
      <button class="secondary" :disabled="h.busy.value" @click="void h.saveCurrent()">
        <Save :size="14" /> 保存到作品库
      </button>
      <button class="primary" :disabled="h.busy.value" @click="void h.exportHandoff()">
        <Send :size="14" /> 导出交接工程
      </button>
    </div>

    <label class="mode-row">
      <span>资源模式</span>
      <select v-model="h.mode.value" aria-label="资源模式">
        <option value="embedded">完整内嵌（单文件可离线）</option>
        <option value="dedup">内容去重引用（需共享资源）</option>
      </select>
    </label>

    <label class="upload handoff-import">
      <Upload :size="18" />
      <strong>导入对端带回的工程</strong>
      <small>先进入临时区校验，不会直接覆盖本机作品</small>
      <input
        type="file"
        accept=".json,application/json"
        @change="pickFile"
      />
    </label>

    <div v-if="h.staging.value.length" class="handoff-list">
      <div class="list-heading">
        <HardDriveDownload :size="12" /> 临时区（{{ h.staging.value.length }}）
      </div>
      <article
        v-for="item in h.staging.value"
        :key="item.id"
        class="list-card"
        :class="{ invalid: !item.valid }"
      >
        <header>
          <strong>{{ item.fileName }}</strong>
          <span class="badge" :class="item.valid ? 'ok' : 'bad'">
            {{ item.valid ? "校验通过" : "校验失败" }}
          </span>
        </header>
        <small class="mono muted">
          {{ item.pkg?.peerName ?? "未知来源" }} ·
          {{ item.pkg?.mode === "dedup" ? "去重引用" : "完整内嵌" }} ·
          {{ item.pkg?.revisions?.length ?? 0 }} 修订
        </small>
        <ul v-if="item.issues.length" class="issue-list">
          <li
            v-for="(issue, i) in item.issues"
            :key="i"
            :class="issue.level"
          >
            {{ issue.level === "error" ? "✕" : "!" }} {{ issue.message }}
          </li>
        </ul>
        <div class="card-actions">
          <button
            class="secondary"
            :disabled="!item.valid"
            @click="void h.openMerge(item)"
          >
            <GitMerge :size="13" /> 合并预览
          </button>
          <button
            class="icon-button"
            aria-label="移除临时区工程"
            @click="void h.discardStaging(item.id)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
      </article>
    </div>

    <div v-if="h.projects.value.length" class="handoff-list">
      <div class="list-heading">
        <PackageOpen :size="12" /> 本机作品库（{{ h.projects.value.length }}）
      </div>
      <article
        v-for="project in h.projects.value"
        :key="project.id"
        class="list-card"
        :class="{
          active: project.id === h.currentProject.value?.id,
        }"
      >
        <header>
          <strong>{{ project.name }}</strong>
          <span v-if="project.id === h.currentProject.value?.id" class="badge ok">
            编辑中
          </span>
        </header>
        <small class="mono muted">
          {{ new Date(project.updatedAt).toLocaleString() }}
        </small>
        <div class="card-actions">
          <button
            class="secondary"
            :disabled="h.busy.value"
            @click="void h.openProject(project.id)"
          >
            <History :size="13" /> 打开
          </button>
        </div>
      </article>
    </div>
  </section>
</template>
