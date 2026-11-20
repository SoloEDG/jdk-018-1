import type { StudioDocument } from "../../../shared/document";
import type { AssetState, ProjectState } from "./types";
import { dataUrlToBlob, hashBlob } from "./digest";

// 把当前工作台文档序列化为可交接的纯数据状态（原图按内容哈希寻址）
export async function captureState(doc: StudioDocument): Promise<ProjectState> {
  let asset: AssetState | null = null;
  if (doc.asset) {
    const blob = dataUrlToBlob(doc.asset.url);
    const hash = await hashBlob(blob);
    asset = {
      name: doc.asset.name,
      width: doc.asset.width,
      height: doc.asset.height,
      resource: { hash, mediaType: blob.type, size: blob.size },
    };
  }
  return {
    asset,
    crop: { ...doc.crop },
    settings: { ...doc.settings },
  };
}

export function sameState(a: ProjectState, b: ProjectState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 状态里引用到的全部资源哈希
export function referencedHashes(state: ProjectState): string[] {
  return state.asset ? [state.asset.resource.hash] : [];
}
