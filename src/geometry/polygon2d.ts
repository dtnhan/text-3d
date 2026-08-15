/**
 * Các phép toán trên đa giác phẳng: hợp, trừ, và giãn/co đường bao.
 *
 * Ba chỗ trong ứng dụng cần đến chúng:
 *
 *  - **Đế bo sát chữ** — giãn đường bao chữ ra một khoảng để lấy hình đế.
 *  - **Khắc chìm** — lấy hình đế trừ đi hình chữ để ra tấm mặt.
 *  - **Font viết tay** — các chữ vốn đè lên nhau, phải hợp lại trước khi khoét
 *    vì bộ tam giác hoá không nhận những lỗ chồng nhau.
 *
 * Dùng clipper-lib vì nó tính trên số nguyên nên bền với các trường hợp suy
 * biến, và có sẵn phép giãn đường bao — thứ mà thư viện boolean thuần không có.
 */

import * as THREE from 'three';
import ClipperLib from 'clipper-lib';
import { shapesFromRings } from './textShapes';

/**
 * Số nguyên hoá toạ độ: 1 mm = 1000 đơn vị, tức độ phân giải 1 µm. Mịn hơn mọi
 * máy in 3D vài bậc, mà vẫn còn xa giới hạn tràn số của clipper.
 */
const SCALE = 1000;

/** Sai số cung tròn khi bo góc lúc giãn đường bao (mm). */
const ARC_TOLERANCE_MM = 0.02;

/** Giới hạn nhọn của góc miter — clipper tự chuyển sang bo tròn khi vượt ngưỡng. */
const MITER_LIMIT = 2;

type ClipperPath = Array<{ X: number; Y: number }>;

/** Hợp các shape chồng lên nhau thành những vùng rời rạc không giao nhau. */
export function unionShapes(shapes: THREE.Shape[]): THREE.Shape[] {
  if (shapes.length === 0) return [];
  if (shapes.length === 1) return shapes;

  return runBoolean(ClipperLib.ClipType.ctUnion, shapes, []);
}

/** Trừ các shape trong `clip` ra khỏi các shape trong `subject`. */
export function differenceShapes(
  subject: THREE.Shape[],
  clip: THREE.Shape[],
): THREE.Shape[] {
  if (subject.length === 0) return [];
  if (clip.length === 0) return subject;

  return runBoolean(ClipperLib.ClipType.ctDifference, subject, clip);
}

/**
 * Giãn (delta > 0) hoặc co (delta < 0) đường bao của các shape.
 *
 * Kết quả có thể tách thành nhiều vùng, hoặc gộp lại thành ít vùng hơn đầu vào
 * khi các phần giãn ra chạm nhau — đó chính là điều ta muốn cho đế bo sát chữ.
 */
export function offsetShapes(shapes: THREE.Shape[], delta: number): THREE.Shape[] {
  if (shapes.length === 0) return [];
  if (delta === 0) return shapes;

  const offsetter = new ClipperLib.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE_MM * SCALE);
  offsetter.AddPaths(
    shapes.flatMap(toPaths),
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etClosedPolygon,
  );

  const solution: ClipperPath[] = [];
  offsetter.Execute(solution, delta * SCALE);
  return fromPaths(solution);
}

/**
 * Biến những đường **hở** thành vùng đặc, bằng cách nới chúng ra hai bên.
 *
 * Dùng cho icon vẽ bằng nét: rất nhiều bộ icon phổ biến (Feather, Lucide, các
 * bộ "outline" của Material) không tô màu hình nào cả, mà chỉ gồm các đường có
 * `stroke-width`. Đưa thẳng vào bộ đùn thì ra một model rỗng không. Nới đường ra
 * đúng bề rộng nét của nó thì được một vùng đặc in được.
 *
 * `width` là bề rộng nét, không phải khoảng nới — clipper nới về mỗi bên một
 * nửa.
 */
export function strokeToShapes(polylines: THREE.Vector2[][], width: number): THREE.Shape[] {
  const usable = polylines.filter((line) => line.length >= 2);
  if (usable.length === 0 || width <= 0) return [];

  const offsetter = new ClipperLib.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE_MM * SCALE);
  offsetter.AddPaths(
    usable.map((line) => line.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))),
    ClipperLib.JoinType.jtRound,
    // Bo tròn hai đầu: đầu vuông sẽ tạo góc nhọn thừa ra ở chỗ nét gãy khúc.
    ClipperLib.EndType.etOpenRound,
  );

  const solution: ClipperPath[] = [];
  offsetter.Execute(solution, (width / 2) * SCALE);
  return fromPaths(solution);
}

// ---------------------------------------------------------------------------

function runBoolean(
  clipType: number,
  subject: THREE.Shape[],
  clip: THREE.Shape[],
): THREE.Shape[] {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject.flatMap(toPaths), ClipperLib.PolyType.ptSubject, true);
  if (clip.length > 0) {
    clipper.AddPaths(clip.flatMap(toPaths), ClipperLib.PolyType.ptClip, true);
  }

  const solution: ClipperPath[] = [];
  // Quy tắc tô "khác không" đi cùng với quy ước chiều quay mà toPaths áp đặt:
  // đường bao ngoài ngược chiều kim đồng hồ, lỗ thì thuận chiều.
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );

  return fromPaths(solution);
}

/**
 * Đổi một shape thành các đường của clipper, ép đúng chiều quay: đường bao
 * ngoài ngược chiều kim đồng hồ, lỗ thuận chiều kim đồng hồ.
 */
function toPaths(shape: THREE.Shape): ClipperPath[] {
  return [
    toPath(shape.getPoints(1), true),
    ...shape.holes.map((hole) => toPath(hole.getPoints(1), false)),
  ];
}

function toPath(points: THREE.Vector2[], counterClockwise: boolean): ClipperPath {
  const ordered = isCounterClockwise(points) === counterClockwise ? points : [...points].reverse();
  return ordered.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}

function fromPaths(paths: ClipperPath[]): THREE.Shape[] {
  return shapesFromRings(
    paths.map((path) => path.map((p) => new THREE.Vector2(p.X / SCALE, p.Y / SCALE))),
  );
}

/** Công thức dây giày; dương ⇒ ngược chiều kim đồng hồ. */
function isCounterClockwise(points: THREE.Vector2[]): boolean {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y);
  }
  return sum > 0;
}
