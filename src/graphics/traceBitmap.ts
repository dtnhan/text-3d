/**
 * Dò biên ảnh raster (PNG, JPG) thành THREE.Shape để đùn khối.
 *
 * Máy in 3D cần đường bao, mà ảnh raster chỉ có điểm ảnh — nên phải dò lấy
 * đường biên giữa vùng "đặc" và vùng "rỗng". Ba bước:
 *
 *  1. **Ngưỡng hoá** — mỗi điểm ảnh thành đặc hoặc rỗng. Ảnh có kênh trong suốt
 *     thì xét độ đục; ảnh đục hoàn toàn thì xét độ sáng, vì logo thường là hình
 *     tối trên nền trắng.
 *  2. **Marching squares** — quét từng ô bốn điểm ảnh, sinh ra các đoạn biên rồi
 *     nối lại thành những vòng khép kín. Cách này bắt được cả đường bao ngoài
 *     lẫn lỗ bên trong, đúng thứ mà thuật toán bao hàm cần để phân biệt.
 *  3. **Giản lược** — đường dò ra bám sát lưới điểm ảnh nên răng cưa và cực
 *     nhiều điểm. Thuật toán Ramer–Douglas–Peucker bỏ bớt điểm mà vẫn giữ dáng.
 *
 * Hàm chính nhận thẳng mảng điểm ảnh chứ không nhận đối tượng ảnh của trình
 * duyệt, để phần này kiểm thử được ngoài trình duyệt.
 */

import * as THREE from 'three';
import { shapesFromRings } from '../geometry/textShapes';
import { unionShapes } from '../geometry/polygon2d';

export interface Bitmap {
  /** RGBA, 4 byte mỗi điểm ảnh — đúng định dạng của `ImageData`. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface TraceOptions {
  /** Ngưỡng phân biệt đặc/rỗng, 0…1. */
  threshold: number;
  /** Sai số cho phép khi giản lược đường, tính theo điểm ảnh. */
  tolerance: number;
}

export const DEFAULT_TRACE: TraceOptions = { threshold: 0.5, tolerance: 0.8 };

export class TraceError extends Error {}

/** Vòng nào ngắn hơn chừng này điểm ảnh thì coi là nhiễu và bỏ đi. */
const MIN_RING_LENGTH = 8;

export function traceBitmap(bitmap: Bitmap, options: TraceOptions = DEFAULT_TRACE): THREE.Shape[] {
  const solid = threshold(bitmap, options.threshold);
  const rings = marchingSquares(solid, bitmap.width, bitmap.height);

  const simplified = rings
    .map((ring) => simplify(ring, options.tolerance))
    .filter((ring) => ring.length >= 3 && perimeter(ring) >= MIN_RING_LENGTH);

  if (simplified.length === 0) {
    throw new TraceError(
      'Không tìm thấy hình nào trong ảnh. Ảnh cần có hình rõ nét trên nền trong suốt hoặc nền trắng — ảnh chụp hay ảnh nhiều màu chuyển sắc thì không dò biên được.',
    );
  }

  return unionShapes(shapesFromRings(simplified));
}

// ---------------------------------------------------------------------------

/**
 * Ngưỡng hoá thành lưới đặc/rỗng, có viền rỗng bao quanh.
 *
 * Viền bao khiến mọi hình chạm mép ảnh vẫn khép kín được, khỏi phải xử lý riêng
 * trường hợp đường biên chạy ra khỏi lưới.
 */
function threshold(bitmap: Bitmap, level: number): Uint8Array {
  const { data, width, height } = bitmap;
  const w = width + 2;
  const grid = new Uint8Array(w * (height + 2));

  // Ảnh nào cũng đục hoàn toàn thì kênh trong suốt vô nghĩa, phải xét độ sáng.
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      transparent = true;
      break;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const value = transparent
        ? data[i + 3] / 255
        : // Hệ số theo cảm nhận sáng của mắt; đảo dấu vì hình tối mới là phần đặc.
          1 - (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
      if (value >= level) grid[(y + 1) * w + (x + 1)] = 1;
    }
  }

  return grid;
}

/**
 * Marching squares: mỗi ô hai-nhân-hai điểm ảnh sinh ra không, một hoặc hai đoạn
 * biên; nối các đoạn lại theo đầu mút chung để được những vòng khép kín.
 *
 * Toạ độ trả về đã lật trục Y (ảnh đánh số dòng từ trên xuống, model thì ngược
 * lại) và lấy gốc tại giữa ảnh.
 */
function marchingSquares(grid: Uint8Array, width: number, height: number): THREE.Vector2[][] {
  const w = width + 2;
  const h = height + 2;

  // Nối đoạn theo đầu mút: khoá là toạ độ nửa điểm ảnh, nhân đôi cho thành số nguyên.
  const edges = new Map<string, string[]>();
  const key = (x: number, y: number) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  const link = (a: string, b: string) => {
    const list = edges.get(a);
    if (list) list.push(b);
    else edges.set(a, [b]);
  };

  const points = new Map<string, THREE.Vector2>();
  const remember = (x: number, y: number) => {
    const k = key(x, y);
    if (!points.has(k)) points.set(k, new THREE.Vector2(x, y));
    return k;
  };

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = grid[y * w + x];
      const tr = grid[y * w + x + 1];
      const bl = grid[(y + 1) * w + x];
      const br = grid[(y + 1) * w + x + 1];
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      // Bốn điểm giữa cạnh của ô.
      const top = () => remember(x + 0.5, y);
      const right = () => remember(x + 1, y + 0.5);
      const bottom = () => remember(x + 0.5, y + 1);
      const left = () => remember(x, y + 0.5);

      // Hướng đi giữ cho phần đặc luôn nằm bên trái, nhờ vậy đường bao ngoài và
      // đường bao lỗ tự có chiều quay ngược nhau.
      switch (code) {
        case 1: link(left(), bottom()); break;
        case 2: link(bottom(), right()); break;
        case 3: link(left(), right()); break;
        case 4: link(right(), top()); break;
        case 5: link(left(), top()); link(right(), bottom()); break;
        case 6: link(bottom(), top()); break;
        case 7: link(left(), top()); break;
        case 8: link(top(), left()); break;
        case 9: link(top(), bottom()); break;
        case 10: link(top(), right()); link(bottom(), left()); break;
        case 11: link(top(), right()); break;
        case 12: link(right(), left()); break;
        case 13: link(right(), bottom()); break;
        case 14: link(bottom(), left()); break;
      }
    }
  }

  // Đi theo các đoạn đã nối để gom thành vòng khép kín.
  const rings: THREE.Vector2[][] = [];
  const cx = width / 2 + 1;
  const cy = height / 2 + 1;

  for (const start of [...edges.keys()]) {
    if (!edges.has(start)) continue;

    const ring: THREE.Vector2[] = [];
    let current = start;

    while (true) {
      const next = edges.get(current);
      if (!next || next.length === 0) break;

      const step = next.pop()!;
      if (next.length === 0) edges.delete(current);

      const p = points.get(current)!;
      // Lật Y và đưa gốc về giữa ảnh; đơn vị vẫn là điểm ảnh, chia tỉ lệ sau.
      ring.push(new THREE.Vector2(p.x - cx, cy - p.y));
      current = step;

      if (current === start) break;
    }

    if (ring.length >= 3) rings.push(ring);
  }

  return rings;
}

/** Giản lược đường theo Ramer–Douglas–Peucker, giữ nguyên tính khép kín. */
function simplify(ring: THREE.Vector2[], tolerance: number): THREE.Vector2[] {
  if (ring.length <= 3 || tolerance <= 0) return ring;

  // Vòng khép kín không có hai đầu cố định, nên tách tại điểm xa điểm đầu nhất
  // rồi giản lược hai nửa — làm vậy mới không bào mất một đoạn cung.
  let far = 0;
  let farDistance = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[0].distanceToSquared(ring[i]);
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  }

  const first = rdp(ring.slice(0, far + 1), tolerance);
  const second = rdp(ring.slice(far), tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function rdp(points: THREE.Vector2[], tolerance: number): THREE.Vector2[] {
  if (points.length < 3) return points;

  const start = points[0];
  const end = points[points.length - 1];
  let index = 0;
  let worst = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i], start, end);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }

  if (worst <= tolerance) return [start, end];

  return [
    ...rdp(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...rdp(points.slice(index), tolerance),
  ];
}

function distanceToSegment(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const lengthSq = a.distanceToSquared(b);
  if (lengthSq === 0) return p.distanceTo(a);

  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

function perimeter(ring: THREE.Vector2[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j].distanceTo(ring[i]);
  return sum;
}
