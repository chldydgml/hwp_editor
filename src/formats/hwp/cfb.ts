import CFB from 'cfb';
import { inflateRaw, deflateRaw } from 'pako';

export const HWP_SIGNATURE = 'HWP Document File';

/** 복합 파일(CFB)을 스트림 경로 → 데이터 맵으로 읽습니다. 경로 예: 'BodyText/Section0' */
export function readCompound(data: Uint8Array): Map<string, Uint8Array> {
  const cfb = CFB.read(data, { type: 'array' });
  const out = new Map<string, Uint8Array>();
  cfb.FileIndex.forEach((entry, i) => {
    if (entry.type !== 2) return; // 2 = stream
    const path = cfb.FullPaths[i].replace(/^[^/]*\//, '');
    const content = entry.content as unknown as ArrayLike<number> | undefined;
    out.set(path, content ? Uint8Array.from(content) : new Uint8Array(0));
  });
  return out;
}

export function writeCompound(streams: Map<string, Uint8Array>): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  // cfb_new 가 만드는 더미 스트림 제거
  CFB.utils.cfb_del(cfb, '\u0001Sh33tJ5');
  for (const [path, data] of streams) CFB.utils.cfb_add(cfb, '/' + path, data);
  const out = CFB.write(cfb, { type: 'array', fileType: 'cfb' }) as unknown as ArrayLike<number>;
  return Uint8Array.from(out);
}

export const inflate = (d: Uint8Array): Uint8Array => inflateRaw(d);
export const deflate = (d: Uint8Array): Uint8Array => deflateRaw(d, { level: 6 });

export interface FileHeader {
  version: number;
  compressed: boolean;
  encrypted: boolean;
  distribution: boolean;
  raw: Uint8Array;
}

export function readFileHeader(data: Uint8Array): FileHeader {
  const sig = new TextDecoder('ascii').decode(data.subarray(0, 17));
  if (sig !== HWP_SIGNATURE) throw new Error('HWP 5.0 파일이 아닙니다.');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const props = dv.getUint32(36, true);
  return {
    version: dv.getUint32(32, true),
    compressed: !!(props & 1),
    encrypted: !!(props & 2),
    distribution: !!(props & 4),
    raw: data,
  };
}

/** 버전 숫자 → '5.1.1.0' */
export const versionString = (v: number) => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
