import { uuid } from "./digest";

const PEER_KEY = "glyphtx.peer";

export interface PeerIdentity {
  peerId: string;
  peerName: string;
}

// 本机对端身份：跨工程稳定，用于修订链署名与合并留痕
export function localPeer(): PeerIdentity {
  try {
    const raw = localStorage.getItem(PEER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PeerIdentity>;
      if (parsed.peerId && parsed.peerName) {
        return { peerId: parsed.peerId, peerName: parsed.peerName };
      }
    }
  } catch {
    /* 忽略损坏的本地配置 */
  }
  const identity: PeerIdentity = {
    peerId: uuid(),
    peerName: `本机 ${Math.floor(Math.random() * 9000 + 1000)}`,
  };
  localStorage.setItem(PEER_KEY, JSON.stringify(identity));
  return identity;
}

export function renamePeer(peerName: string): PeerIdentity {
  const current = localPeer();
  const next = { ...current, peerName: peerName.trim() || current.peerName };
  localStorage.setItem(PEER_KEY, JSON.stringify(next));
  return next;
}
