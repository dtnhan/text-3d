/**
 * Hình dạng lỗ móc khóa.
 *
 * ## "Đường kính lỗ" nghĩa là gì với hình không tròn
 *
 * Mọi hình ở đây được dựng sao cho **vòng tròn lớn nhất lọt vừa lòng lỗ** có
 * đúng đường kính người dùng đặt. Với móc khóa thì đó mới là con số có nghĩa:
 * điều người ta cần biết là cái vòng khóa có xỏ qua được hay không.
 *
 * Cách hiểu còn lại — lấy đường kính làm bề ngang của hình — nghe thì tự nhiên
 * hơn nhưng dùng thì hỏng: một lỗ tam giác bề ngang 5 mm chỉ cho lọt vòng khóa
 * chưa tới 1.7 mm, tức là đặt 5 mm mà thực tế xỏ không qua.
 *
 * Hệ quả là hình càng nhọn thì càng chiếm nhiều chỗ trên đế so với lỗ tròn cùng
 * cỡ. Nên mỗi hình còn báo về `outerRadius` — khoảng cách xa nhất từ tâm tới mép
 * — để phần dựng đế biết phải chừa bao nhiêu vật liệu quanh lỗ.
 */

import * as THREE from 'three';

export type HoleShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'hexagon'
  | 'semicircle'
  | 'teardrop';

export interface HoleOutline {
  /** Các điểm của lỗ, theo chiều kim đồng hồ. */
  points: THREE.Vector2[];
  /** Khoảng cách xa nhất từ tâm tới mép lỗ (mm). */
  outerRadius: number;
}

/** Số đoạn chia một vòng tròn đầy đủ — đủ mịn để in ra không thấy cạnh gãy. */
const CIRCLE_SEGMENTS = 48;

/**
 * Dựng đường bao lỗ.
 *
 * `insideDiameter` là đường kính vòng tròn lọt vừa lòng lỗ, không phải bề ngang
 * của hình.
 */
export function holeOutline(
  shape: HoleShape,
  center: THREE.Vector2,
  insideDiameter: number,
): HoleOutline {
  const r = Math.max(insideDiameter, 0.1) / 2;
  const local = outlineFor(shape, r);

  // Vẽ theo chiều kim đồng hồ — ngược với đường bao ngoài — để bộ tam giác hoá
  // khoét đúng phần bên trong.
  local.reverse();

  let outerRadius = 0;
  for (const p of local) outerRadius = Math.max(outerRadius, p.length());

  return {
    points: local.map((p) => p.clone().add(center)),
    outerRadius,
  };
}

/** Đường bao quanh gốc toạ độ, ngược chiều kim đồng hồ, bán kính nội tiếp `r`. */
function outlineFor(shape: HoleShape, r: number): THREE.Vector2[] {
  switch (shape) {
    case 'circle':
      return arc(0, 0, r, 0, Math.PI * 2, CIRCLE_SEGMENTS);

    case 'square':
      // Đường tròn nội tiếp hình vuông chạm bốn cạnh, nên cạnh dài đúng 2r.
      return [
        new THREE.Vector2(-r, -r),
        new THREE.Vector2(r, -r),
        new THREE.Vector2(r, r),
        new THREE.Vector2(-r, r),
      ];

    case 'triangle':
      // Tam giác đều: bán kính ngoại tiếp gấp đôi bán kính nội tiếp.
      return polygon(3, 2 * r, Math.PI / 2);

    case 'hexagon':
      // Lục giác đều: bán kính ngoại tiếp = bán kính nội tiếp chia cos(30°).
      return polygon(6, (2 * r) / Math.sqrt(3), 0);

    case 'semicircle': {
      // Nửa đĩa bán kính R có vòng tròn nội tiếp bán kính R/2, tâm cách cạnh
      // phẳng đúng R/2. Muốn vòng nội tiếp bằng r thì R phải bằng 2r, và cạnh
      // phẳng nằm dưới tâm một đoạn r.
      const flatY = -r;
      const points = arc(0, flatY, 2 * r, 0, Math.PI, CIRCLE_SEGMENTS / 2);
      // arc() đã đi từ mép phải sang mép trái; nối thẳng về là xong cạnh phẳng.
      return points;
    }

    case 'teardrop': {
      // Vòng tròn bán kính r, thêm một mũi nhọn phía trên. Hai cạnh của mũi là
      // tiếp tuyến của vòng tròn tại 135° và 45°, gặp nhau tại (0, r√2).
      //
      // Cung phải chạy từ 135° ngược chiều kim đồng hồ một vòng ba phần tư về
      // tới 45°, tức là **chừa lại** đúng cái nêm phía trên cho mũi nhọn. Đi
      // hướng ngược lại thì cung phủ luôn phần đỉnh và hình sẽ tự cắt.
      const points = arc(0, 0, r, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5, 36);
      points.push(new THREE.Vector2(0, r * Math.SQRT2));
      return points;
    }
  }
}

/** Đa giác đều `sides` cạnh, bán kính ngoại tiếp `radius`, xoay `rotation`. */
function polygon(sides: number, radius: number, rotation: number): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i / sides) * Math.PI * 2;
    points.push(new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius));
  }
  return points;
}

/** Cung tròn từ `from` tới `to`, ngược chiều kim đồng hồ. */
function arc(
  cx: number,
  cy: number,
  radius: number,
  from: number,
  to: number,
  segments: number,
): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  // Vòng tròn đầy đủ thì điểm cuối trùng điểm đầu, nên bỏ bớt một điểm.
  const closed = Math.abs(to - from - Math.PI * 2) < 1e-9;
  const count = closed ? segments : segments + 1;

  for (let i = 0; i < count; i++) {
    const angle = from + ((to - from) * i) / segments;
    points.push(new THREE.Vector2(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius));
  }
  return points;
}
