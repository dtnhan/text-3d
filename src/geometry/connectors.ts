/**
 * Dựng các đoạn nối để giữ những mảnh rời của chữ lại với nhau.
 *
 * Trong tiếng Việt, dấu (`^`, `~`, `˘`, dấu thanh) là những đường bao tách hẳn
 * khỏi thân chữ, y như dấu chấm trên `i` và `j`. Ở chế độ chữ nổi đơn thuần,
 * chúng in ra thành từng mảnh riêng và rơi khỏi bàn in. Các chữ cái đứng cách
 * nhau cũng vậy.
 *
 * Ta nối chúng lại bằng những thanh nhỏ: gom các shape thành mảnh, dựng cây bao
 * trùm nhỏ nhất trên tập mảnh đó, rồi mỗi cạnh của cây thành một thanh nối đi
 * theo đoạn ngắn nhất giữa hai mảnh. Cây bao trùm bảo đảm mọi thứ dính vào nhau
 * mà số thanh thêm vào là ít nhất — mỗi thanh đều là chỗ phải gọt đi nếu người
 * dùng muốn model đẹp, nên càng ít càng tốt.
 */

import * as THREE from 'three';
import { findIslands, type Island } from './islands';

/**
 * Số điểm tối đa lấy mẫu trên mỗi mảnh khi tìm đoạn ngắn nhất. Đường bao chữ có
 * thể có hàng trăm điểm, mà so từng cặp thì tốn bình phương; lấy thưa ra vẫn cho
 * vị trí nối tốt vì ta chỉ cần một chỗ hợp lý chứ không cần điểm tối ưu tuyệt đối.
 */
const SAMPLE_LIMIT = 96;

/**
 * Dựng các thanh nối cho một tập shape. Trả về mảng rỗng nếu mọi thứ vốn đã
 * dính liền nhau.
 */
export function buildConnectors(shapes: THREE.Shape[], width: number): THREE.Shape[] {
  const islands = findIslands(shapes);
  if (islands.length <= 1 || width <= 0) return [];

  const samples = islands.map(sample);
  const bars: THREE.Shape[] = [];

  // Cây bao trùm nhỏ nhất theo thuật toán Prim: mỗi vòng lặp kéo thêm mảnh gần
  // nhất vào nhóm đã nối, và dựng thanh nối tương ứng.
  const joined = new Set<number>([0]);
  while (joined.size < islands.length) {
    let best: { from: number; to: number; a: THREE.Vector2; b: THREE.Vector2; d: number } | null =
      null;

    for (const from of joined) {
      for (let to = 0; to < islands.length; to++) {
        if (joined.has(to)) continue;
        // Khoảng cách giữa hai hộp bao luôn nhỏ hơn khoảng cách thật, nên nếu
        // nó đã lớn hơn kết quả tốt nhất thì khỏi cần đo chi tiết cặp này.
        if (best && boxGap(islands[from], islands[to]) >= best.d) continue;

        const [a, b, d] = closestPair(samples[from], samples[to]);
        if (!best || d < best.d) best = { from, to, a, b, d };
      }
    }

    if (!best) break;
    joined.add(best.to);

    const bar = makeBar(best.a, best.b, width);
    if (bar) bars.push(bar);
  }

  return bars;
}

/**
 * Thanh nối hình chữ nhật đi từ `a` tới `b`.
 *
 * Hai đầu được kéo dài thêm nửa bề rộng để cắm hẳn vào trong hai mảnh, bảo đảm
 * chúng thật sự chồng lên nhau chứ không chỉ chạm mép — hai khối chỉ chạm nhau
 * đúng một điểm thì khi in ra vẫn rời.
 */
export function makeBar(a: THREE.Vector2, b: THREE.Vector2, width: number): THREE.Shape | null {
  const along = b.clone().sub(a);
  const length = along.length();
  if (length < 1e-6) return null;

  along.divideScalar(length);
  const across = new THREE.Vector2(-along.y, along.x).multiplyScalar(width / 2);
  const grip = along.clone().multiplyScalar(width / 2);

  const start = a.clone().sub(grip);
  const end = b.clone().add(grip);

  return new THREE.Shape([
    start.clone().add(across),
    end.clone().add(across),
    end.clone().sub(across),
    start.clone().sub(across),
  ]);
}

/** Cặp điểm gần nhau nhất giữa hai tập điểm, kèm khoảng cách. */
export function closestPair(
  a: THREE.Vector2[],
  b: THREE.Vector2[],
): [THREE.Vector2, THREE.Vector2, number] {
  let best: [THREE.Vector2, THREE.Vector2, number] = [a[0], b[0], Infinity];

  for (const p of a) {
    for (const q of b) {
      const d = p.distanceToSquared(q);
      if (d < best[2]) best = [p, q, d];
    }
  }

  return [best[0], best[1], Math.sqrt(best[2])];
}

/** Lấy thưa các điểm của một mảnh, giữ đều khắp đường bao. */
function sample(island: Island): THREE.Vector2[] {
  const { points } = island;
  if (points.length <= SAMPLE_LIMIT) return points;

  const stride = Math.ceil(points.length / SAMPLE_LIMIT);
  const picked: THREE.Vector2[] = [];
  for (let i = 0; i < points.length; i += stride) picked.push(points[i]);
  return picked;
}

/** Khoảng hở giữa hai hộp bao — cận dưới của khoảng cách thật giữa hai mảnh. */
function boxGap(a: Island, b: Island): number {
  const dx = Math.max(0, a.box.min.x - b.box.max.x, b.box.min.x - a.box.max.x);
  const dy = Math.max(0, a.box.min.y - b.box.max.y, b.box.min.y - a.box.max.y);
  return Math.hypot(dx, dy);
}
