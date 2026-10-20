/** 파일 형식 판별, 열기, 저장 */
import { readHwp } from '../formats/hwp/reader';
import { writeHwp } from '../formats/hwp/writer';
import { readHwpx } from '../formats/hwpx/reader';
import { writeHwpx } from '../formats/hwpx/writer';
import type { HwpDocument } from '../model/types';
import { base64ToBytes } from '../model/util';
import { BLANK_HWPX_BASE64 } from '../templates/embedded';

export type FileFormat = 'hwp' | 'hwpx';

export function detectFormat(data: Uint8Array): FileFormat | null {
  if (data[0] === 0x50 && data[1] === 0x4b) return 'hwpx'; // 'PK' (zip)
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return 'hwp'; // CFB
  return null;
}

export async function openDocument(data: Uint8Array): Promise<HwpDocument> {
  const fmt = detectFormat(data);
  if (fmt === 'hwpx') return readHwpx(data);
  if (fmt === 'hwp') return readHwp(data);
  throw new Error('지원하지 않는 파일 형식입니다. (.hwp, .hwpx 만 열 수 있습니다)');
}

export function saveDocument(doc: HwpDocument, format: FileFormat): Promise<Uint8Array> {
  return format === 'hwp' ? writeHwp(doc) : writeHwpx(doc);
}

/** 새 빈 문서 */
export async function newDocument(): Promise<HwpDocument> {
  const doc = await readHwpx(base64ToBytes(BLANK_HWPX_BASE64));
  doc.source.format = 'new';
  return doc;
}

export function download(data: Uint8Array, filename: string) {
  const mime = filename.endsWith('.hwpx') ? 'application/hwp+zip' : 'application/x-hwp';
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
