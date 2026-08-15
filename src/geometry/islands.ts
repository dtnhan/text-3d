/**
 * Gom các shape thành từng "mảnh" — nhóm những shape dính liền nhau.
 *
 * Hai chỗ dùng đến: phần cảnh báo mảnh rời, và phần dựng đoạn nối. Cả hai phải
 * đồng ý với nhau về việc thế nào là dính liền, nếu không sẽ có cảnh báo mà
 * không có đoạn nối tương ứng, hoặc ngược lại.
 *
 * Phép xét dựa trên hộp bao có giao nhau hay không. Đây là phép xấp xỉ: hai
 * shape có hộp bao giao nhau chưa chắc đã thật sự chạm nhau (hay gặp ở font
 * nghiêng và font viết tay). Ta chấp nhận đánh giá thiên về phía "ít mảnh hơn
 * thực tế", vì mục tiêu chính là bắt những mảnh tách xa hẳn — dấu thanh, dấu
 * mũ, chữ đứng riêng — mà những trường hợp đó thì hộp bao rời nhau rõ ràng.
 */

import * as THREE from 'three';

export interface Island {
  /** Chỉ số của các shape thuộc mảnh này, theo mảng truyền vào. */
  indices: number[];
  /** Toàn bộ điểm đường bao ngoài của mảnh, dùng để đo khoảng cách. */
  points: THREE.Vector2[];
  box: THREE.Box2;
}

/** Gom shape thành các mảnh dính liền nhau. */
export function findIslands(shapes: THREE.Shape[]): Island[] {
  if (shapes.length === 0) return [];

  const outlines = shapes.map((s) => s.getPoints(1));
  const boxes = outlines.map((points) => new THREE.Box2().setFromPoints(points));
  const parent = boxes.map((_, i) => i);

  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (!boxes[i].intersectsBox(boxes[j])) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    }
  }

  const grouped = new Map<number, number[]>();
  for (let i = 0; i < shapes.length; i++) {
    const root = find(i);
    const list = grouped.get(root);
    if (list) list.push(i);
    else grouped.set(root, [i]);
  }

  return [...grouped.values()].map((indices) => {
    const box = new THREE.Box2().makeEmpty();
    const points: THREE.Vector2[] = [];
    for (const i of indices) {
      points.push(...outlines[i]);
      box.union(boxes[i]);
    }
    return { indices, points, box };
  });
}
