import type { InjectionKey, Ref } from "vue";
import type { StudioDocument } from "./document";
export interface StudioContext {
  doc: StudioDocument;
  busy: Ref<boolean>;
  notice: Ref<string>;
  invalidate: () => void;
  currentProjectId: Ref<string | null>;
}
export const studioKey: InjectionKey<StudioContext> = Symbol("studio");
