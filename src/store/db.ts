/** IndexedDB 持久化:案件元数据 + 点云二进制分开存。 */

import { CaseFile, PointCloud, Station } from '../core/types';

const DB_NAME = 'crashscene';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cases')) db.createObjectStore('cases', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('clouds')) db.createObjectStore('clouds', { keyPath: 'stationId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface CaseMetaRow {
  id: string;
  code: string;
  title: string;
  createdAt: string;
  friction: number;
  printScale: number;
  northAngle: number;
  measurements: CaseFile['measurements'];
  stations: {
    id: string; name: string; fileName: string;
    transform: number[]; targets: [number, number, number][];
    residuals: number[]; residualRms: number; overLimit: boolean;
    count: number;
  }[];
}

export async function listCases(): Promise<CaseMetaRow[]> {
  const db = await openDb();
  return tx(db, 'cases', 'readonly', (s) => s.getAll() as IDBRequest<CaseMetaRow[]>);
}

export async function createCase(code: string, title: string): Promise<CaseFile> {
  const db = await openDb();
  const c: CaseFile = {
    id: crypto.randomUUID(),
    code, title,
    createdAt: new Date().toISOString(),
    stations: [],
    measurements: [],
    friction: 0.7,
    printScale: 200,
    northAngle: 0,
  };
  await saveCaseMeta(c);
  return c;
}

export async function saveCaseMeta(c: CaseFile) {
  const db = await openDb();
  const row: CaseMetaRow = {
    id: c.id, code: c.code, title: c.title, createdAt: c.createdAt,
    friction: c.friction, printScale: c.printScale, northAngle: c.northAngle,
    measurements: c.measurements,
    stations: c.stations.map((s) => ({
      id: s.id, name: s.name, fileName: s.fileName, transform: s.transform,
      targets: s.targets, residuals: s.residuals, residualRms: s.residualRms,
      overLimit: s.overLimit, count: s.cloud.count,
    })),
  };
  await tx(db, 'cases', 'readwrite', (s) => s.put(row));
}

export async function saveStationCloud(caseId: string, s: Station) {
  const db = await openDb();
  await tx(db, 'clouds', 'readwrite', (st) => st.put({
    stationId: s.id,
    caseId,
    count: s.cloud.count,
    positions: s.cloud.positions,
    colors: s.cloud.colors,
    intensities: s.cloud.intensities,
    normals: s.cloud.normals,
    flags: s.cloud.flags,
  }));
}

interface CloudRow {
  stationId: string; count: number;
  positions: Float32Array; colors: Uint8Array | null;
  intensities: Float32Array | null; normals: Float32Array | null;
  flags: Uint8Array;
}

export async function loadCase(id: string): Promise<CaseFile | null> {
  const db = await openDb();
  const meta = await tx(db, 'cases', 'readonly', (s) => s.get(id) as IDBRequest<CaseMetaRow | undefined>);
  if (!meta) return null;
  const stations: Station[] = [];
  for (const sm of meta.stations) {
    const row = await tx(db, 'clouds', 'readonly', (s) => s.get(sm.id) as IDBRequest<CloudRow | undefined>);
    if (!row) continue;
    const cloud: PointCloud = {
      count: row.count, positions: row.positions, colors: row.colors,
      intensities: row.intensities, normals: row.normals, flags: row.flags,
    };
    stations.push({
      id: sm.id, name: sm.name, fileName: sm.fileName, cloud,
      transform: sm.transform, targets: sm.targets,
      residuals: sm.residuals, residualRms: sm.residualRms, overLimit: sm.overLimit,
    });
  }
  return {
    id: meta.id, code: meta.code, title: meta.title, createdAt: meta.createdAt,
    stations, measurements: meta.measurements ?? [],
    friction: meta.friction ?? 0.7, printScale: meta.printScale ?? 200, northAngle: meta.northAngle ?? 0,
  };
}

export async function deleteCase(id: string) {
  const db = await openDb();
  const meta = await tx(db, 'cases', 'readonly', (s) => s.get(id) as IDBRequest<CaseMetaRow | undefined>);
  if (meta) {
    for (const sm of meta.stations) {
      await tx(db, 'clouds', 'readwrite', (s) => s.delete(sm.id));
    }
  }
  await tx(db, 'cases', 'readwrite', (s) => s.delete(id));
}
