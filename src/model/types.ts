/**
 * 편집기 내부 문서 모델.
 *
 * HWP(바이너리)와 HWPX(OWPML) 모두 이 모델로 읽고 이 모델에서 씁니다.
 * 편집기가 아직 이해하지 못하는 요소(표, 그림, 각주 등)는 원본 그대로
 * `raw` 필드에 보관했다가 저장할 때 되돌려 써서 원본 손실을 막습니다.
 *
 * 길이 단위는 모두 HWPUNIT(1/7200 inch, 1pt = 100)입니다.
 */

/** 글꼴 언어 그룹 순서 (HWP CHAR_SHAPE / HWPX fontRef 공통) */
export const LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'] as const;
export type Lang = (typeof LANGS)[number];

/** 언어별 7개 값 */
export type PerLang<T> = [T, T, T, T, T, T, T];

export type Align = 'justify' | 'left' | 'right' | 'center' | 'distribute' | 'divide';
export type LineSpacingType = 'percent' | 'fixed' | 'between' | 'atLeast';

export interface CharProps {
  /** 언어별 글꼴 이름 */
  faces: PerLang<string>;
  /** 기준 크기 (HWPUNIT, 1000 = 10pt) */
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  superscript: boolean;
  subscript: boolean;
  /** '#RRGGBB' */
  color: string;
  /** 음영 색, 없으면 'none' */
  shade: string;
  /** 장평(%) */
  ratio: PerLang<number>;
  /** 자간(%) */
  spacing: PerLang<number>;
  /** 상대 크기(%) */
  relSize: PerLang<number>;
  /** 글자 위치(%) */
  offset: PerLang<number>;
}

export interface ParaProps {
  align: Align;
  lineSpacingType: LineSpacingType;
  /** percent 이면 %, 그 외에는 HWPUNIT */
  lineSpacing: number;
  /** 첫 줄 들여쓰기(+) / 내어쓰기(-) */
  indent: number;
  marginLeft: number;
  marginRight: number;
  spaceBefore: number;
  spaceAfter: number;
}

/** 원본 포맷별로 보존하는 원시 데이터 */
export interface RawSlot {
  /** HWPX 원본 XML 조각 */
  hwpx?: string;
  /** HWP 원본 레코드 페이로드 */
  hwp?: Uint8Array;
}

export interface CharShape {
  props: CharProps;
  raw?: RawSlot;
}

export interface ParaShape {
  props: ParaProps;
  raw?: RawSlot;
}

export interface Style {
  name: string;
  engName: string;
  type: 'para' | 'char';
  paraShapeId: number;
  charShapeId: number;
  nextStyleId: number;
  raw?: RawSlot;
}

export interface PageDef {
  width: number;
  height: number;
  landscape: boolean;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  marginHeader: number;
  marginFooter: number;
  marginGutter: number;
}

/** HWP 레코드 (태그, 레벨, 페이로드) */
export interface HwpRecord {
  tag: number;
  level: number;
  data: Uint8Array;
}

/**
 * 편집기가 아직 직접 편집하지 못하는 개체(표, 그림, 수식, 각주 등).
 * 원본 데이터를 그대로 들고 다니다가 같은 포맷으로 저장할 때 복원합니다.
 */
export interface OpaqueControl {
  /** 화면에 보일 이름 (예: '표', '그림') */
  label: string;
  /** 미리보기용 텍스트 */
  preview?: string;
  /** HWPX: hp:run 의 자식 요소 XML */
  hwpx?: string;
  /** HWP: 문단 텍스트 속 8 WCHAR 컨트롤 문자 */
  hwpChars?: Uint16Array;
  /** HWP: 해당 컨트롤의 레코드 트리 (레벨은 문단 기준 상대값) */
  hwpRecords?: HwpRecord[];
}

export interface TextRun {
  kind: 'text';
  charShapeId: number;
  /** 탭은 '\t', 강제 줄바꿈은 '\n' */
  text: string;
}

export interface ControlRun {
  kind: 'control';
  charShapeId: number;
  ctrl: OpaqueControl;
}

export type Run = TextRun | ControlRun;

export interface Paragraph {
  paraShapeId: number;
  styleId: number;
  runs: Run[];
  pageBreak?: boolean;
  columnBreak?: boolean;
  /** 문단 끝 글자 모양 (빈 문단에서 사용) */
  endCharShapeId?: number;
}

export interface Section {
  page: PageDef;
  paragraphs: Paragraph[];
  raw?: {
    /** HWPX: hp:secPr 및 첫 hp:ctrl(hp:colPr) XML */
    hwpxSecPr?: string;
    hwpxColPr?: string;
    /** HWP: 구역 정의(secd)와 단 정의(cold) 컨트롤 */
    hwpSecd?: OpaqueControl;
    hwpCold?: OpaqueControl;
  };
}

export interface DocMeta {
  title: string;
  creator: string;
  subject: string;
  description: string;
  keywords: string;
}

export type SourceFormat = 'hwp' | 'hwpx' | 'new';

export interface HwpDocument {
  meta: DocMeta;
  charShapes: CharShape[];
  paraShapes: ParaShape[];
  styles: Style[];
  sections: Section[];
  /** 원본 파일 정보 (저장 시 손실 없는 왕복 변환에 사용) */
  source: {
    format: SourceFormat;
    /** HWPX: 원본 패키지의 모든 파일 */
    hwpxFiles?: Map<string, Uint8Array>;
    /** HWP: 원본 복합 파일 스트림과 DocInfo 레코드 */
    hwpStreams?: Map<string, Uint8Array>;
    hwpDocInfo?: HwpRecord[];
    hwpVersion?: number;
  };
}
