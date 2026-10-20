/**
 * 최소 구현 CFB(Compound File Binary, v3 / 512바이트 섹터) 작성기.
 * 경로('BodyText/Section0' 등) → 데이터 맵을 받아 복합 파일을 만듭니다.
 */

const SECTOR = 512;
const MINI = 64;
const MINI_CUTOFF = 4096;
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;

interface Node {
  name: string;
  type: 1 | 2 | 5;
  children: Node[];
  data?: Uint8Array;
  id: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

const node = (name: string, type: 1 | 2 | 5, data?: Uint8Array): Node => ({
  name, type, children: [], data, id: -1, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, start: END, size: 0,
});

/** CFB 규칙: 이름 길이 우선, 같으면 대문자 기준 비교 */
const compareNames = (a: string, b: string) => {
  if (a.length !== b.length) return a.length - b.length;
  const A = a.toUpperCase(), B = b.toUpperCase();
  return A < B ? -1 : A > B ? 1 : 0;
};

/** 정렬된 형제들을 균형 이진 트리로 연결하고 루트 id 를 돌려줍니다. */
function linkSiblings(nodes: Node[]): number {
  if (nodes.length === 0) return NOSTREAM;
  const mid = nodes.length >> 1;
  const n = nodes[mid];
  n.left = linkSiblings(nodes.slice(0, mid));
  n.right = linkSiblings(nodes.slice(mid + 1));
  return n.id;
}

export function buildCompoundFile(streams: Map<string, Uint8Array>): Uint8Array {
  const root = node('Root Entry', 5);
  for (const [path, data] of streams) {
    const parts = path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.children.find((c) => c.name === parts[i] && c.type === 1);
      if (!next) { next = node(parts[i], 1); cur.children.push(next); }
      cur = next;
    }
    cur.children.push(node(parts[parts.length - 1], 2, data));
  }

  // 디렉터리 항목 번호 매기기 (너비 우선)
  const all: Node[] = [];
  const queue = [root];
  while (queue.length) {
    const n = queue.shift()!;
    n.id = all.length;
    all.push(n);
    n.children.sort((a, b) => compareNames(a.name, b.name));
    queue.push(...n.children);
  }
  for (const n of all) n.child = linkSiblings(n.children);

  // 미니 스트림과 일반 스트림 배치
  const miniFat: number[] = [];
  const miniChunks: Uint8Array[] = [];
  const bigStreams: Node[] = [];
  for (const n of all) {
    if (n.type !== 2) continue;
    const data = n.data!;
    n.size = data.length;
    if (data.length === 0) { n.start = END; continue; }
    if (data.length < MINI_CUTOFF) {
      const count = Math.ceil(data.length / MINI);
      n.start = miniFat.length;
      for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END : miniFat.length + 1);
      const padded = new Uint8Array(count * MINI);
      padded.set(data);
      miniChunks.push(padded);
    } else bigStreams.push(n);
  }
  const miniStream = concat(miniChunks);

  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const allocChain = (data: Uint8Array): number => {
    if (data.length === 0) return END;
    const count = Math.ceil(data.length / SECTOR);
    const start = sectors.length;
    for (let i = 0; i < count; i++) {
      const s = new Uint8Array(SECTOR);
      s.set(data.subarray(i * SECTOR, (i + 1) * SECTOR));
      sectors.push(s);
      fat.push(i === count - 1 ? END : start + i + 1);
    }
    return start;
  };
  for (const n of bigStreams) n.start = allocChain(n.data!);
  root.start = allocChain(miniStream);
  root.size = miniStream.length;
  const miniFatBytes = u32s(miniFat, FREE, SECTOR);
  const miniFatStart = miniFat.length ? allocChain(miniFatBytes) : END;
  const miniFatCount = miniFat.length ? miniFatBytes.length / SECTOR : 0;

  const dirBytes = new Uint8Array(Math.ceil(all.length / 4) * 4 * 128);
  all.forEach((n, i) => writeDirEntry(dirBytes, i * 128, n));
  // 빈 디렉터리 항목은 형제/자식 없음으로 표시
  for (let i = all.length; i < dirBytes.length / 128; i++) {
    const dv = new DataView(dirBytes.buffer, i * 128, 128);
    dv.setUint32(0x44, NOSTREAM, true); dv.setUint32(0x48, NOSTREAM, true); dv.setUint32(0x4c, NOSTREAM, true);
  }
  const dirStart = allocChain(dirBytes);

  // FAT 섹터 수 결정 (FAT/DIFAT 자신도 FAT 항목을 차지)
  const perSector = SECTOR / 4;
  let fatCount = 0, difatCount = 0;
  for (;;) {
    const total = sectors.length + fatCount + difatCount;
    const needFat = Math.ceil(total / perSector);
    const needDifat = needFat > 109 ? Math.ceil((needFat - 109) / (perSector - 1)) : 0;
    if (needFat === fatCount && needDifat === difatCount) break;
    fatCount = needFat;
    difatCount = needDifat;
  }
  const fatStart = sectors.length;
  for (let i = 0; i < fatCount; i++) fat.push(FATSECT);
  const difatStart = sectors.length + fatCount;
  for (let i = 0; i < difatCount; i++) fat.push(DIFSECT);
  const fatBytes = u32s(fat, FREE, SECTOR * fatCount);
  for (let i = 0; i < fatCount; i++) sectors.push(fatBytes.subarray(i * SECTOR, (i + 1) * SECTOR));
  const fatSectors = Array.from({ length: fatCount }, (_, i) => fatStart + i);
  for (let d = 0; d < difatCount; d++) {
    const s = new Uint8Array(SECTOR).fill(0xff);
    const dv = new DataView(s.buffer);
    const entries = fatSectors.slice(109 + d * (perSector - 1), 109 + (d + 1) * (perSector - 1));
    entries.forEach((v, i) => dv.setUint32(i * 4, v, true));
    dv.setUint32(SECTOR - 4, d === difatCount - 1 ? END : difatStart + d + 1, true);
    sectors.push(s);
  }

  const header = new Uint8Array(SECTOR);
  const hv = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  hv.setUint16(0x18, 0x003e, true);
  hv.setUint16(0x1a, 0x0003, true);
  hv.setUint16(0x1c, 0xfffe, true);
  hv.setUint16(0x1e, 9, true);
  hv.setUint16(0x20, 6, true);
  hv.setUint32(0x2c, fatCount, true);
  hv.setUint32(0x30, dirStart, true);
  hv.setUint32(0x38, MINI_CUTOFF, true);
  hv.setUint32(0x3c, miniFatStart, true);
  hv.setUint32(0x40, miniFatCount, true);
  hv.setUint32(0x44, difatCount ? difatStart : END, true);
  hv.setUint32(0x48, difatCount, true);
  for (let i = 0; i < 109; i++) hv.setUint32(0x4c + i * 4, i < fatCount ? fatSectors[i] : FREE, true);

  return concat([header, ...sectors]);
}

function writeDirEntry(buf: Uint8Array, off: number, n: Node) {
  const dv = new DataView(buf.buffer, off, 128);
  const name = n.name.slice(0, 31);
  for (let i = 0; i < name.length; i++) dv.setUint16(i * 2, name.charCodeAt(i), true);
  dv.setUint16(0x40, (name.length + 1) * 2, true);
  dv.setUint8(0x42, n.type);
  dv.setUint8(0x43, 1); // black
  dv.setUint32(0x44, n.left, true);
  dv.setUint32(0x48, n.right, true);
  dv.setUint32(0x4c, n.child, true);
  dv.setUint32(0x74, n.type === 1 ? 0 : n.start, true);
  dv.setUint32(0x78, n.type === 1 ? 0 : n.size, true);
}

function u32s(values: number[], fill: number, minBytes: number): Uint8Array {
  const len = Math.max(minBytes, Math.ceil((values.length * 4) / SECTOR) * SECTOR);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < len / 4; i++) dv.setUint32(i * 4, i < values.length ? values[i] : fill, true);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
