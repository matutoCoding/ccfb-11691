/** PLY 解析:支持 ASCII 与二进制(大/小端),提取坐标/颜色/强度/法线。
 *  坏文件抛出带具体原因的 PlyError(中文)。 */

import { PointCloud, makeCloud } from './types';

export class PlyError extends Error {}

type ScalarType =
  | 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

interface PlyProperty {
  name: string;
  type: ScalarType;
  isList: boolean;
  countType?: ScalarType;
  itemType?: ScalarType;
}

interface PlyElement {
  name: string;
  count: number;
  props: PlyProperty[];
}

const TYPE_SIZE: Record<ScalarType, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8,
};

const TYPE_ALIASES: Record<string, ScalarType> = {
  char: 'int8', uchar: 'uint8', short: 'int16', ushort: 'uint16',
  int: 'int32', uint: 'uint32', float: 'float32', double: 'float64',
  int8: 'int8', uint8: 'uint8', int16: 'int16', uint16: 'uint16',
  int32: 'int32', uint32: 'uint32', float32: 'float32', float64: 'float64',
};

// 常见属性名归一化
const COLOR_NAMES: Record<string, 0 | 1 | 2> = {
  red: 0, green: 1, blue: 2, r: 0, g: 1, b: 2,
  diffuse_red: 0, diffuse_green: 1, diffuse_blue: 2,
};
const INTENSITY_NAMES = new Set([
  'intensity', 'scalar_intensity', 'reflectance', 'scalar_reflectance', 'remission', 'scalar_remission',
]);
const NORMAL_NAMES: Record<string, 0 | 1 | 2> = { nx: 0, ny: 1, nz: 2 };

export function parsePly(input: ArrayBuffer | string): PointCloud {
  const buf = typeof input === 'string' ? new TextEncoder().encode(input).buffer as ArrayBuffer : input;
  if (buf.byteLength < 16) throw new PlyError('文件太小,不是有效的 PLY 文件');

  // ---- 头部解析(头部一定是 ASCII)----
  const headBytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 8192));
  let headText = '';
  let headerEnd = -1;
  // 找 "end_header" 行结束位置
  const fullHead = new TextDecoder('ascii').decode(headBytes);
  const m = /end_header[ \t]*(\r\n|\n|\r)/.exec(fullHead);
  if (!m) {
    // 头部可能超过 8KB,扩大窗口再找一次
    const bigger = new TextDecoder('ascii').decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 20)));
    const m2 = /end_header[ \t]*(\r\n|\n|\r)/.exec(bigger);
    if (!m2) throw new PlyError('找不到 end_header,文件头损坏或不是 PLY 文件');
    headText = bigger.slice(0, m2.index);
    headerEnd = m2.index + m2[0].length;
  } else {
    headText = fullHead.slice(0, m.index);
    headerEnd = m.index + m[0].length;
  }

  const lines = headText.split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => l && !l.startsWith('comment') && !l.startsWith('obj_info'));
  if (!lines.length || lines[0] !== 'ply') throw new PlyError('缺少 ply 魔数,不是 PLY 文件');

  let format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' | null = null;
  let version = '1.0';
  const elements: PlyElement[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'format') {
      const f = parts[1]!;
      version = parts[2] ?? '1.0';
      if (f !== 'ascii' && f !== 'binary_little_endian' && f !== 'binary_big_endian') {
        throw new PlyError(`不支持的编码格式 "${f}",仅支持 ascii / binary_little_endian / binary_big_endian`);
      }
      format = f;
    } else if (parts[0] === 'element') {
      const count = parseInt(parts[2] ?? '', 10);
      if (!parts[1] || Number.isNaN(count) || count < 0) throw new PlyError(`element 声明非法: "${line}"`);
      elements.push({ name: parts[1], count, props: [] });
    } else if (parts[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new PlyError('property 出现在任何 element 之前,文件头损坏');
      if (parts[1] === 'list') {
        const ct = TYPE_ALIASES[parts[2] ?? ''];
        const it = TYPE_ALIASES[parts[3] ?? ''];
        if (!ct || !it) throw new PlyError(`不支持的 list 属性类型: "${line}"`);
        el.props.push({ name: parts[4]!, type: it, isList: true, countType: ct, itemType: it });
      } else {
        const t = TYPE_ALIASES[parts[1] ?? ''];
        if (!t) throw new PlyError(`不支持的属性类型 "${parts[1]}"`);
        el.props.push({ name: parts[2]!, type: t, isList: false });
      }
    }
  }
  if (!format) throw new PlyError('文件头缺少 format 声明');

  const vertexEl = elements.find((e) => e.name === 'vertex');
  if (!vertexEl) throw new PlyError('文件中没有 vertex 元素,不是点云 PLY');
  if (vertexEl.count === 0) throw new PlyError('vertex 数量为 0,空点云');
  if (vertexEl.count > 200_000_000) throw new PlyError(`声明了 ${vertexEl.count} 个点,超出合理范围,文件头可能损坏`);

  const propIndex = (names: string[]) => vertexEl.props.findIndex((p) => !p.isList && names.includes(p.name));
  const ix = propIndex(['x']), iy = propIndex(['y']), iz = propIndex(['z']);
  if (ix < 0 || iy < 0 || iz < 0) throw new PlyError('vertex 元素缺少 x/y/z 坐标属性');

  const colorIdx: number[] = [-1, -1, -1];
  const normalIdx: number[] = [-1, -1, -1];
  let intensityIdx = -1;
  vertexEl.props.forEach((p, i) => {
    if (p.isList) return;
    const c = COLOR_NAMES[p.name];
    if (c !== undefined) colorIdx[c] = i;
    const n = NORMAL_NAMES[p.name];
    if (n !== undefined) normalIdx[n] = i;
    if (INTENSITY_NAMES.has(p.name.toLowerCase())) intensityIdx = i;
  });

  const n = vertexEl.count;
  const positions = new Float32Array(n * 3);
  const colors = colorIdx[0] >= 0 && colorIdx[1] >= 0 && colorIdx[2] >= 0 ? new Uint8Array(n * 3) : null;
  const normals = normalIdx[0] >= 0 && normalIdx[1] >= 0 && normalIdx[2] >= 0 ? new Float32Array(n * 3) : null;
  const intensities = intensityIdx >= 0 ? new Float32Array(n) : null;

  // ---- 数据区 ----
  if (format === 'ascii') {
    readAscii(buf, headerEnd, elements, vertexEl, { ix, iy, iz, colorIdx, normalIdx, intensityIdx, positions, colors, normals, intensities });
  } else {
    readBinary(buf, headerEnd, elements, vertexEl, format === 'binary_little_endian', { ix, iy, iz, colorIdx, normalIdx, intensityIdx, positions, colors, normals, intensities });
  }

  // 强度归一化到 0-1(按实际分布)
  if (intensities) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { const v = intensities[i]!; if (v < mn) mn = v; if (v > mx) mx = v; }
    const range = mx - mn;
    if (range > 1e-9) for (let i = 0; i < n; i++) intensities[i] = (intensities[i]! - mn) / range;
  }

  const cloud = makeCloud(n, positions, colors, intensities, normals);
  return cloud;
}

interface ReadCtx {
  ix: number; iy: number; iz: number;
  colorIdx: number[]; normalIdx: number[]; intensityIdx: number;
  positions: Float32Array; colors: Uint8Array | null;
  normals: Float32Array | null; intensities: Float32Array | null;
}

function readAscii(buf: ArrayBuffer, offset: number, elements: PlyElement[], vertexEl: PlyElement, ctx: ReadCtx) {
  // ASCII 体整体解码(大文件下 TextDecoder 流式也可,这里一次解码足够稳健)
  const text = new TextDecoder('ascii').decode(new Uint8Array(buf, offset));
  const tokens = text.split(/\s+/);
  let ti = 0;
  const next = (): number => {
    while (ti < tokens.length && tokens[ti] === '') ti++; // 跳过空 token(行尾换行)
    if (ti >= tokens.length) throw new PlyError('数据区比头部声明的短,文件被截断');
    const v = parseFloat(tokens[ti++]!);
    if (Number.isNaN(v)) throw new PlyError(`第 ${ti} 个数据项不是数字: "${tokens[ti - 1]}"`);
    return v;
  };
  for (const el of elements) {
    if (el === vertexEl) {
      fillVertices(el, ctx, () => next());
    } else {
      // 跳过非顶点元素(面片等)
      for (let i = 0; i < el.count; i++) {
        for (const p of el.props) {
          if (p.isList) { const c = next(); for (let k = 0; k < c; k++) next(); }
          else next();
        }
      }
    }
  }
}

function readBinary(
  buf: ArrayBuffer, offset: number, elements: PlyElement[], vertexEl: PlyElement,
  littleEndian: boolean, ctx: ReadCtx,
) {
  const view = new DataView(buf, offset);
  let pos = 0;
  const readers: Record<ScalarType, () => number> = {
    int8: () => view.getInt8(pos++),
    uint8: () => view.getUint8(pos++),
    int16: () => { const v = view.getInt16(pos, littleEndian); pos += 2; return v; },
    uint16: () => { const v = view.getUint16(pos, littleEndian); pos += 2; return v; },
    int32: () => { const v = view.getInt32(pos, littleEndian); pos += 4; return v; },
    uint32: () => { const v = view.getUint32(pos, littleEndian); pos += 4; return v; },
    float32: () => { const v = view.getFloat32(pos, littleEndian); pos += 4; return v; },
    float64: () => { const v = view.getFloat64(pos, littleEndian); pos += 8; return v; },
  };
  const read = (t: ScalarType): number => {
    if (pos + TYPE_SIZE[t] > view.byteLength) throw new PlyError('数据区比头部声明的短,文件被截断');
    return readers[t]();
  };
  for (const el of elements) {
    if (el === vertexEl) {
      fillVertices(el, ctx, () => read('float32'), (p) => read(p.type));
    } else {
      for (let i = 0; i < el.count; i++) {
        for (const p of el.props) {
          if (p.isList) { const c = read(p.countType!); for (let k = 0; k < c; k++) read(p.itemType!); }
          else read(p.type);
        }
      }
    }
  }
}

/** 逐顶点填充;next() 按属性顺序读一个标量 */
function fillVertices(
  el: PlyElement, ctx: ReadCtx,
  nextFallback: () => number,
  nextForProp?: (p: PlyProperty) => number,
) {
  const { ix, iy, iz, colorIdx, normalIdx, intensityIdx } = ctx;
  const n = el.count;
  const colorIsFloat = colorIdx[0] >= 0 && el.props[colorIdx[0]!]!.type.startsWith('float');
  for (let i = 0; i < n; i++) {
    for (let pi = 0; pi < el.props.length; pi++) {
      const p = el.props[pi]!;
      if (p.isList) {
        const read1 = nextForProp ? () => nextForProp({ ...p, type: p.countType! }) : nextFallback;
        const c = read1();
        for (let k = 0; k < c; k++) (nextForProp ? nextForProp(p) : nextFallback());
        continue;
      }
      const v = nextForProp ? nextForProp(p) : nextFallback();
      if (pi === ix) ctx.positions[i * 3] = v;
      else if (pi === iy) ctx.positions[i * 3 + 1] = v;
      else if (pi === iz) ctx.positions[i * 3 + 2] = v;
      else if (pi === colorIdx[0]) ctx.colors![i * 3] = colorIsFloat ? v * 255 : v;
      else if (pi === colorIdx[1]) ctx.colors![i * 3 + 1] = colorIsFloat ? v * 255 : v;
      else if (pi === colorIdx[2]) ctx.colors![i * 3 + 2] = colorIsFloat ? v * 255 : v;
      else if (pi === normalIdx[0]) ctx.normals![i * 3] = v;
      else if (pi === normalIdx[1]) ctx.normals![i * 3 + 1] = v;
      else if (pi === normalIdx[2]) ctx.normals![i * 3 + 2] = v;
      else if (pi === intensityIdx) ctx.intensities![i] = v;
    }
  }
}
