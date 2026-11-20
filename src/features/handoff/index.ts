export { default as HandoffPanel } from "./ui/HandoffPanel.vue";
export { default as MergeDialog } from "./ui/MergeDialog.vue";
export { default as HistoryDialog } from "./ui/HistoryDialog.vue";
export { useHandoff } from "./model/useHandoff";
export { buildMergePlan, applySelection } from "./lib/merge";
export {
  PACKAGE_KIND,
  PACKAGE_VERSION,
  PACKAGE_EXTENSION,
} from "./lib/types";
export type { HandoffPackage, StagedPackage, ValidationIssue } from "./lib/types";
