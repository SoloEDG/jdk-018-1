import type { Asset } from "../../../shared/document";
import type { ProjectState } from "./types";
import { getResource } from "./library";
import { blobToDataUrl } from "./digest";

// 从作品库资源还原可渲染的原图对象
export async function restoreAsset(
  state: ProjectState,
  blobOverride?: Blob,
): Promise<Asset | null> {
  if (!state.asset) return null;
  const stored = blobOverride ?? (await getResource(state.asset.resource.hash))?.blob;
  if (!stored) {
    throw new Error(
      `原图资源 ${state.asset.resource.hash.slice(0, 8)} 在本机库缺失`,
    );
  }
  const dataUrl = await blobToDataUrl(stored);
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return {
    name: state.asset.name,
    url: dataUrl,
    width: state.asset.width,
    height: state.asset.height,
    image,
  };
}
