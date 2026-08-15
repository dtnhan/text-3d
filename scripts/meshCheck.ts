/**
 * Kiểm tra tính kín của lưới tam giác.
 *
 * Phép kiểm ngây thơ là "mỗi cạnh phải thuộc đúng hai tam giác". Nhưng phép đó
 * báo nhầm ở **điểm chữ T** — chỗ đỉnh của tam giác này rơi vào giữa cạnh của
 * tam giác kia. Khi ấy cạnh dài chỉ thuộc một mặt, còn các cạnh ngắn phủ lên nó
 * cũng vậy, dù bề mặt vẫn kín hoàn toàn về hình học và cắt lớp ra vẫn đúng.
 *
 * Điểm chữ T xuất hiện tự nhiên khi khoét nhiều chữ vào cùng một tấm: các chữ
 * cùng nằm trên một đường chân chữ, nên bộ tam giác hoá bắc cầu dọc đúng đường
 * thẳng đó. Không tránh được, và cũng vô hại.
 *
 * Nên ở đây ta chẻ mọi cạnh chưa ghép đôi tại những đỉnh nằm lọt bên trong nó,
 * rồi mới ghép lại. Cạnh nào sau khi chẻ vẫn lẻ mới thực sự là lỗ thủng.
 */

import * as THREE from 'three';

export interface MeshReport {
  triangles: number;
  /** Số cạnh thật sự chỉ có một mặt — lưới thủng. Phải bằng 0. */
  openEdges: number;
  /** Số điểm chữ T đã hoá giải được — vô hại, chỉ báo để biết. */
  tJunctions: number;
}

/** Làm tròn toạ độ tới 0.1 µm để gộp các đỉnh chỉ khác nhau do sai số dấu phẩy động. */
const QUANT = 1e4;
/** Đỉnh cách cạnh dưới ngưỡng này (mm) thì coi như nằm trên cạnh. */
const ON_EDGE_EPS = 1e-4;

export function checkMesh(geometry: THREE.BufferGeometry): MeshReport {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const corners = index ? index.count : position.count;

  const vertexOf = (corner: number) => {
    const v = index ? index.getX(corner) : corner;
    return new THREE.Vector3(position.getX(v), position.getY(v), position.getZ(v));
  };

  const keyOf = (p: THREE.Vector3) =>
    `${Math.round(p.x * QUANT)},${Math.round(p.y * QUANT)},${Math.round(p.z * QUANT)}`;

  const points = new Map<string, THREE.Vector3>();
  const counts = new Map<string, number>();

  const edgeId = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const bump = (id: string, by: number) => {
    const next = (counts.get(id) ?? 0) + by;
    if (next === 0) counts.delete(id);
    else counts.set(id, next);
  };

  for (let t = 0; t < corners / 3; t++) {
    const p = [0, 1, 2].map((k) => vertexOf(t * 3 + k));
    const k = p.map(keyOf);
    for (let i = 0; i < 3; i++) points.set(k[i], p[i]);
    for (let e = 0; e < 3; e++) {
      const a = k[e];
      const b = k[(e + 1) % 3];
      if (a !== b) bump(edgeId(a, b), 1);
    }
  }

  // Chẻ các cạnh lẻ tại những đỉnh nằm lọt bên trong chúng.
  const vertices = [...points.entries()];
  const unpaired = [...counts.entries()].filter(([, n]) => n % 2 !== 0).map(([id]) => id);
  let tJunctions = 0;

  for (const id of unpaired) {
    if ((counts.get(id) ?? 0) % 2 === 0) continue; // đã được cạnh khác chẻ ra và ghép xong

    const [ka, kb] = id.split('|');
    const a = points.get(ka)!;
    const b = points.get(kb)!;

    const inside = vertices.filter(([k, p]) => k !== ka && k !== kb && liesOnSegment(p, a, b));
    if (inside.length === 0) continue;

    // Sắp các đỉnh chen giữa theo thứ tự dọc cạnh rồi nối thành chuỗi cạnh con.
    inside.sort(([, p], [, q]) => p.distanceToSquared(a) - q.distanceToSquared(a));
    const chain = [ka, ...inside.map(([k]) => k), kb];

    bump(id, -1);
    for (let i = 0; i < chain.length - 1; i++) bump(edgeId(chain[i], chain[i + 1]), 1);
    tJunctions++;
  }

  let openEdges = 0;
  for (const n of counts.values()) if (n % 2 !== 0) openEdges++;

  return { triangles: corners / 3, openEdges, tJunctions };
}

/** Điểm p có nằm trên đoạn ab (không tính hai đầu mút) không? */
function liesOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): boolean {
  const ab = b.clone().sub(a);
  const ap = p.clone().sub(a);
  const lengthSq = ab.lengthSq();
  if (lengthSq === 0) return false;

  const t = ap.dot(ab) / lengthSq;
  if (t <= 0 || t >= 1) return false;

  return ap.cross(ab).length() / Math.sqrt(lengthSq) < ON_EDGE_EPS;
}
