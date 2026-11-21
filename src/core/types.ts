/** 全局核心类型:点云、站点、案件、测量 */

/** 点云数据(结构化的 typed array,便于传 Worker / 上传 GPU) */
export interface PointCloud {
  count: number;
  /** xyz 交错, Float32 */
  positions: Float32Array;
  /** rgb 每点 3 字节 0-255,可空 */
  colors: Uint8Array | null;
  /** 反射强度 0-1,可空 */
  intensities: Float32Array | null;
  /** 法线 xyz 交错,可空 */
  normals: Float32Array | null;
  /** 隔离层标记:0=正常 1=已隔离(删除进隔离层) 2=拖影候选 */
  flags: Uint8Array;
}

export function makeCloud(
  count: number,
  positions: Float32Array,
  colors: Uint8Array | null = null,
  intensities: Float32Array | null = null,
  normals: Float32Array | null = null,
): PointCloud {
  return { count, positions, colors, intensities, normals, flags: new Uint8Array(count) };
}

/** 一站扫描 */
export interface Station {
  id: string;
  name: string;
  fileName: string;
  cloud: PointCloud;
  /** 拼接到案件坐标系的刚体变换(行主序 4x4),未拼接为 identity */
  transform: number[];
  /** 靶球点(本站坐标系) */
  targets: [number, number, number][];
  /** 拼接残差(每个公共靶球一个),米 */
  residuals: number[];
  residualRms: number;
  overLimit: boolean;
}

export interface MeasureRecord {
  id: string;
  kind: 'distance' | 'angle' | 'curve' | 'speed';
  label: string;
  /** 世界坐标点序列 */
  points: [number, number, number][];
  /** 结果数值:米 / 度 / 米 / km-h */
  value: number;
  /** 附加说明(如附着系数) */
  note: string;
  createdAt: string;
}

export interface CaseFile {
  id: string;
  /** 事故编号,如 "公交认字[2026]第xxxx号" */
  code: string;
  title: string;
  createdAt: string;
  stations: Station[];
  measurements: MeasureRecord[];
  /** 路面附着系数(用于车速估算) */
  friction: number;
  /** 出图比例分母,如 200 表示 1:200 */
  printScale: number;
  /** 指北针角度(弧度,案件坐标系中北向) */
  northAngle: number;
}

export interface AppSettings {
  residualLimit: number;      // 拼接残差限差,米
  sorNeighbors: number;       // 统计离群点:邻域点数
  sorStdRatio: number;        // 统计离群点:标准差倍数
  voxelSize: number;          // 体素降采样边长,米(0=不启用)
  ghostHeight: number;        // 拖影识别:高出路面阈值,米
  ghostDensity: number;       // 拖影识别:局部密度阈值
  splatBaseSize: number;      // splat 基础尺寸(世界单位)
  lodErrorPx: number;         // LOD 屏幕误差阈值(像素)
  renderBudget: number;       // 每帧 splat 预算
}

export const defaultSettings: AppSettings = {
  residualLimit: 0.02,
  sorNeighbors: 16,
  sorStdRatio: 2.0,
  voxelSize: 0.01,
  ghostHeight: 0.15,
  ghostDensity: 0.35,
  splatBaseSize: 0.02,
  lodErrorPx: 1.5,
  renderBudget: 2_000_000,
};
