/** PLY 解析测试:ASCII / 二进制小端 / 二进制大端 / 颜色强度法线 / 各类坏文件报错 */

import { describe, it, expect } from 'vitest';
import { parsePly, PlyError } from '../src/core/ply';

function asciiPly(extraProps = '', extraData = '') {
  return `ply
format ascii 1.0
comment test
element vertex 2
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
property float intensity
property float nx
property float ny
property float nz
${extraProps}element face 1
property list uchar int vertex_indices
end_header
0 0 0 255 0 0 0.5 0 0 1
1 2 3 0 255 0 0.8 0 1 0
${extraData}3 0 1 0
`;
}

describe('PLY 解析', () => {
  it('解析 ASCII:坐标/颜色/强度/法线,跳过面片', () => {
    const c = parsePly(asciiPly());
    expect(c.count).toBe(2);
    expect(Array.from(c.positions.slice(3, 6))).toEqual([1, 2, 3]);
    expect(c.colors![0]).toBe(255);
    expect(c.colors![4]).toBe(255);
    // 强度归一化到 0-1
    expect(c.intensities![0]).toBeCloseTo(0, 5);
    expect(c.intensities![1]).toBeCloseTo(1, 5);
    expect(c.normals![4]).toBe(1);
  });

  it('解析二进制小端', () => {
    const header = `ply
format binary_little_endian 1.0
element vertex 2
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
property float scalar_Intensity
end_header
`;
    const head = new TextEncoder().encode(header);
    const body = new ArrayBuffer(2 * (12 + 3 + 4));
    const dv = new DataView(body);
    let o = 0;
    const put = (x: number, y: number, z: number, r: number, g: number, b: number, i: number) => {
      dv.setFloat32(o, x, true); dv.setFloat32(o + 4, y, true); dv.setFloat32(o + 8, z, true);
      dv.setUint8(o + 12, r); dv.setUint8(o + 13, g); dv.setUint8(o + 14, b);
      dv.setFloat32(o + 15, i, true);
      o += 19;
    };
    put(1.5, 2.5, 3.5, 10, 20, 30, 0.4);
    put(-1, -2, -3, 40, 50, 60, 0.9);
    const buf = new Uint8Array(head.length + body.byteLength);
    buf.set(head, 0);
    buf.set(new Uint8Array(body), head.length);
    const c = parsePly(buf.buffer);
    expect(c.count).toBe(2);
    expect(c.positions[0]).toBeCloseTo(1.5);
    expect(c.positions[5]).toBeCloseTo(-3);
    expect(c.colors![1]).toBe(20);
    expect(c.intensities![1]).toBeCloseTo(1, 5);
  });

  it('解析二进制大端', () => {
    const header = `ply
format binary_big_endian 1.0
element vertex 1
property double x
property double y
property double z
end_header
`;
    const head = new TextEncoder().encode(header);
    const body = new ArrayBuffer(24);
    const dv = new DataView(body);
    dv.setFloat64(0, 7.25, false);
    dv.setFloat64(8, -3.5, false);
    dv.setFloat64(16, 0.125, false);
    const buf = new Uint8Array(head.length + 24);
    buf.set(head, 0);
    buf.set(new Uint8Array(body), head.length);
    const c = parsePly(buf.buffer);
    expect(c.positions[0]).toBeCloseTo(7.25);
    expect(c.positions[1]).toBeCloseTo(-3.5);
    expect(c.positions[2]).toBeCloseTo(0.125);
  });

  it('坏文件:缺魔数', () => {
    expect(() => parsePly('not a ply file at all, too short')).toThrow(PlyError);
  });

  it('坏文件:不支持的格式', () => {
    expect(() => parsePly(`ply\nformat binary_middle_endian 1.0\nelement vertex 1\nproperty float x\nend_header\n`))
      .toThrow(/不支持的编码格式/);
  });

  it('坏文件:缺坐标属性', () => {
    expect(() => parsePly(`ply\nformat ascii 1.0\nelement vertex 1\nproperty float foo\nend_header\n1\n`))
      .toThrow(/缺少 x\/y\/z/);
  });

  it('坏文件:数据截断', () => {
    expect(() => parsePly(`ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n`))
      .toThrow(/截断/);
  });

  it('坏文件:空 buffer', () => {
    expect(() => parsePly(new ArrayBuffer(4))).toThrow(/太小/);
  });
});
