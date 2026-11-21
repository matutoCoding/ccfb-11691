/** 全局应用状态:当前案件、设置、合并点云、渲染器单例。 */

import { AppSettings, CaseFile, PointCloud, defaultSettings, makeCloud } from '../core/types';
import { Octree, buildOctree } from '../core/octree';
import { mat4Transform, Mat4 } from '../core/math3';

const SETTINGS_KEY = 'crashscene.settings';

export const state = {
  currentCase: null as CaseFile | null,
  settings: loadSettings(),
  /** 合并到案件坐标系的点云(渲染/测量用) */
  merged: null as PointCloud | null,
  octree: null as Octree | null,
  /** 合并点云每个点 → [stationIdx, pointIdx] 回溯隔离层 */
  mergedOwner: null as Int32Array | null,
  listeners: new Set<() => void>(),
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch { /* 忽略损坏的设置 */ }
  return { ...defaultSettings };
}

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

export function notify() {
  for (const fn of state.listeners) fn();
}

/** 把各站按拼接变换合并成一个案件坐标系点云 */
export function rebuildMerged() {
  const c = state.currentCase;
  if (!c || c.stations.length === 0) {
    state.merged = null;
    state.octree = null;
    state.mergedOwner = null;
    return;
  }
  let total = 0;
  for (const s of c.stations) total += s.cloud.count;
  const positions = new Float32Array(total * 3);
  const colors = new Uint8Array(total * 3);
  const intensities = new Float32Array(total);
  const normals = new Float32Array(total * 3);
  const flags = new Uint8Array(total);
  const owner = new Int32Array(total * 2);
  let hasColor = false, hasInt = false, hasNrm = false;
  let o = 0;
  c.stations.forEach((s, si) => {
    const m = s.transform as unknown as Mat4;
    const cl = s.cloud;
    if (cl.colors) hasColor = true;
    if (cl.intensities) hasInt = true;
    if (cl.normals) hasNrm = true;
    for (let i = 0; i < cl.count; i++) {
      const [x, y, z] = mat4Transform(m, [cl.positions[i * 3]!, cl.positions[i * 3 + 1]!, cl.positions[i * 3 + 2]!]);
      positions[o * 3] = x; positions[o * 3 + 1] = y; positions[o * 3 + 2] = z;
      if (cl.colors) {
        colors[o * 3] = cl.colors[i * 3]!;
        colors[o * 3 + 1] = cl.colors[i * 3 + 1]!;
        colors[o * 3 + 2] = cl.colors[i * 3 + 2]!;
      }
      if (cl.intensities) intensities[o] = cl.intensities[i]!;
      if (cl.normals) {
        // 法线只旋转(刚体变换,取旋转部分)
        normals[o * 3] = m[0]! * cl.normals[i * 3]! + m[4]! * cl.normals[i * 3 + 1]! + m[8]! * cl.normals[i * 3 + 2]!;
        normals[o * 3 + 1] = m[1]! * cl.normals[i * 3]! + m[5]! * cl.normals[i * 3 + 1]! + m[9]! * cl.normals[i * 3 + 2]!;
        normals[o * 3 + 2] = m[2]! * cl.normals[i * 3]! + m[6]! * cl.normals[i * 3 + 1]! + m[10]! * cl.normals[i * 3 + 2]!;
      }
      flags[o] = cl.flags[i]!;
      owner[o * 2] = si;
      owner[o * 2 + 1] = i;
      o++;
    }
  });
  const merged = makeCloud(total, positions, hasColor ? colors : null, hasInt ? intensities : null, hasNrm ? normals : null);
  merged.flags.set(flags);
  state.merged = merged;
  state.mergedOwner = owner;
  state.octree = buildOctree(merged);
}

/** 把合并云上的隔离标记写回各站原始云 */
export function syncFlagsToStations() {
  const c = state.currentCase;
  if (!c || !state.merged || !state.mergedOwner) return;
  const owner = state.mergedOwner;
  const flags = state.merged.flags;
  for (let o = 0; o < state.merged.count; o++) {
    const si = owner[o * 2]!;
    const pi = owner[o * 2 + 1]!;
    c.stations[si]!.cloud.flags[pi] = flags[o]!;
  }
}
