/**
 * Chuyển đường path của glyph (từ opentype.js) thành THREE.Shape dựng khối được.
 *
 * Đây là phần dễ sai nhất của dự án. Điểm mấu chốt: **không được** dùng chiều
 * quay (winding order) của contour để phân biệt phần đặc với phần lỗ. Font
 * TrueType và font CFF/PostScript dùng quy ước chiều quay ngược nhau, nên cách
 * đó sẽ sai với khoảng một nửa số font ngoài đời.
 *
 * Thay vào đó ta xét quan hệ bao hàm hình học: contour nằm trong một số **lẻ**
 * contour khác thì là lỗ, số **chẵn** thì là phần đặc. Cách này đúng cho mọi
 * định dạng font, và xử lý được cả trường hợp lồng nhiều tầng (đặc → lỗ → đặc).
 */

import * as THREE from 'three';

/** Lệnh vẽ path theo quy ước opentype.js. */
export interface PathCommand {
  type: 'M' | 'L' | 'C' | 'Q' | 'Z';
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

export interface Contour {
  points: THREE.Vector2[];
  /** Diện tích có dấu — dương là ngược chiều kim đồng hồ. */
  signedArea: number;
  /** Hộp bao 2D, dùng để lọc nhanh trước khi xét bao hàm. */
  box: THREE.Box2;
}

/** Bỏ qua contour nhỏ hơn ngưỡng này (đơn vị em bình phương) — nhiễu từ font. */
const MIN_AREA = 1e-9;
/** Hai điểm gần nhau hơn ngưỡng này (đơn vị em) coi như trùng. */
const EPS = 1e-7;

/**
 * Làm phẳng các lệnh path thành danh sách contour đa giác.
 *
 * Toạ độ vào theo quy ước opentype (trục Y hướng **xuống**); toạ độ ra theo quy
 * ước Three.js (trục Y hướng **lên**) — hàm này lật dấu Y.
 */
export function commandsToContours(commands: PathCommand[], curveSegments: number): Contour[] {
  const contours: Contour[] = [];
  let current: THREE.Vector2[] = [];
  let cursor = new THREE.Vector2();

  const push = (p: THREE.Vector2) => {
    const last = current[current.length - 1];
    if (last && last.distanceTo(p) < EPS) return;
    current.push(p);
  };

  const finish = () => {
    const contour = makeContour(current);
    if (contour) contours.push(contour);
    current = [];
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M': {
        finish();
        cursor = new THREE.Vector2(cmd.x!, -cmd.y!);
        current.push(cursor.clone());
        break;
      }
      case 'L': {
        cursor = new THREE.Vector2(cmd.x!, -cmd.y!);
        push(cursor.clone());
        break;
      }
      case 'Q': {
        const c = new THREE.Vector2(cmd.x1!, -cmd.y1!);
        const end = new THREE.Vector2(cmd.x!, -cmd.y!);
        const segs = segmentsFor([cursor, c, end], curveSegments);
        for (let i = 1; i <= segs; i++) push(quadraticAt(cursor, c, end, i / segs));
        cursor = end;
        break;
      }
      case 'C': {
        const c1 = new THREE.Vector2(cmd.x1!, -cmd.y1!);
        const c2 = new THREE.Vector2(cmd.x2!, -cmd.y2!);
        const end = new THREE.Vector2(cmd.x!, -cmd.y!);
        const segs = segmentsFor([cursor, c1, c2, end], curveSegments);
        for (let i = 1; i <= segs; i++) push(cubicAt(cursor, c1, c2, end, i / segs));
        cursor = end;
        break;
      }
      case 'Z': {
        finish();
        break;
      }
    }
  }
  finish();

  return contours;
}

/**
 * Nhóm các contour thành THREE.Shape, gắn đúng contour lỗ vào phần đặc bao nó.
 *
 * Với mỗi contour, đếm số contour khác chứa nó. Độ sâu chẵn → phần đặc; lẻ → lỗ,
 * và lỗ đó thuộc về phần đặc có độ sâu ngay trước nó bao quanh nó (contour nhỏ
 * nhất trong số các contour bao nó — để xử lý đúng trường hợp lồng nhiều tầng).
 */
export function contoursToShapes(contours: Contour[], scale = 1): THREE.Shape[] {
  if (contours.length === 0) return [];

  // parents[i] = chỉ số các contour bao quanh contour i
  const parents: number[][] = contours.map(() => []);
  for (let i = 0; i < contours.length; i++) {
    const probe = contours[i].points[0];
    for (let j = 0; j < contours.length; j++) {
      if (i === j) continue;
      const outer = contours[j];
      // Lọc nhanh: điểm nằm ngoài hộp bao thì chắc chắn nằm ngoài contour.
      if (!outer.box.containsPoint(probe)) continue;
      if (pointInPolygon(probe, outer.points)) parents[i].push(j);
    }
  }

  const shapes: THREE.Shape[] = [];
  // Ánh xạ chỉ số contour đặc → shape tương ứng, để gắn lỗ vào sau.
  const shapeOf = new Map<number, THREE.Shape>();

  for (let i = 0; i < contours.length; i++) {
    if (parents[i].length % 2 !== 0) continue; // độ sâu lẻ ⇒ là lỗ
    const shape = new THREE.Shape(orient(contours[i], true, scale));
    shapes.push(shape);
    shapeOf.set(i, shape);
  }

  for (let i = 0; i < contours.length; i++) {
    if (parents[i].length % 2 === 0) continue; // độ sâu chẵn ⇒ là phần đặc

    // Trong các contour bao quanh, contour đặc bao sát nhất chính là contour có
    // hộp bao nhỏ nhất — đó là chủ sở hữu của lỗ này.
    let owner = -1;
    let ownerArea = Infinity;
    for (const p of parents[i]) {
      if (!shapeOf.has(p)) continue;
      const area = Math.abs(contours[p].signedArea);
      if (area < ownerArea) {
        ownerArea = area;
        owner = p;
      }
    }
    if (owner === -1) continue;

    // Lỗ phải quay ngược chiều với đường bao ngoài để bộ tam giác hoá của
    // Three.js khoét đúng phần bên trong.
    shapeOf.get(owner)!.holes.push(new THREE.Path(orient(contours[i], false, scale)));
  }

  return shapes;
}

/**
 * Dựng shape từ những vòng điểm rời rạc, tự phân biệt đâu là phần đặc đâu là lỗ.
 *
 * Dùng cho kết quả trả về của các phép toán đa giác 2D (hợp, trừ, giãn): chúng
 * cho ra một mớ vòng phẳng không kèm thông tin lồng nhau, đúng bài toán mà
 * `contoursToShapes` đã giải.
 */
export function shapesFromRings(rings: THREE.Vector2[][]): THREE.Shape[] {
  const contours: Contour[] = [];
  for (const ring of rings) {
    // makeContour có thể bỏ bớt điểm cuối nên phải chép ra trước.
    const contour = makeContour([...ring]);
    if (contour) contours.push(contour);
  }
  return contoursToShapes(contours);
}

/**
 * Đường tắt: từ lệnh path thẳng ra danh sách shape.
 *
 * `scale` được áp lúc dựng shape chứ không áp lên toạ độ đầu vào, để phép xét
 * bao hàm và các ngưỡng sai số vẫn chạy trong đơn vị em như lúc thiết kế.
 */
export function pathToShapes(
  commands: PathCommand[],
  curveSegments: number,
  scale = 1,
): THREE.Shape[] {
  return contoursToShapes(commandsToContours(commands, curveSegments), scale);
}

// ---------------------------------------------------------------------------
// Hàm phụ trợ
// ---------------------------------------------------------------------------

function makeContour(points: THREE.Vector2[]): Contour | null {
  // Bỏ điểm cuối nếu nó trùng điểm đầu — THREE.Shape tự khép kín.
  if (points.length > 1 && points[0].distanceTo(points[points.length - 1]) < EPS) {
    points.pop();
  }
  if (points.length < 3) return null;

  const signedArea = polygonArea(points);
  if (Math.abs(signedArea) < MIN_AREA) return null;

  const box = new THREE.Box2().setFromPoints(points);
  return { points, signedArea, box };
}

/**
 * Trả về điểm của contour theo chiều quay yêu cầu (true = ngược kim đồng hồ),
 * đồng thời nhân toạ độ với hệ số `scale`.
 */
function orient(contour: Contour, counterClockwise: boolean, scale: number): THREE.Vector2[] {
  const isCCW = contour.signedArea > 0;
  const ordered = isCCW === counterClockwise ? contour.points : [...contour.points].reverse();
  return scale === 1 ? ordered.map((p) => p.clone()) : ordered.map((p) => p.clone().multiplyScalar(scale));
}

/** Công thức dây giày. Dương ⇒ ngược chiều kim đồng hồ. */
function polygonArea(points: THREE.Vector2[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y);
  }
  return sum / 2;
}

/** Kiểm tra điểm nằm trong đa giác bằng phương pháp phóng tia. */
export function pointInPolygon(p: THREE.Vector2, polygon: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Chọn số đoạn chia cho một đường cong dựa trên độ dài đa giác điều khiển, để
 * đường cong lớn được chia mịn hơn đường cong nhỏ. Toạ độ tính theo đơn vị em.
 */
function segmentsFor(controlPoints: THREE.Vector2[], curveSegments: number): number {
  let length = 0;
  for (let i = 1; i < controlPoints.length; i++) {
    length += controlPoints[i].distanceTo(controlPoints[i - 1]);
  }
  // 0.3 em ≈ độ dài một đường cong "cỡ trung bình" trong glyph thông thường.
  const scaled = Math.ceil((curveSegments * length) / 0.3);
  return Math.max(2, Math.min(scaled, curveSegments * 3));
}

function quadraticAt(p0: THREE.Vector2, p1: THREE.Vector2, p2: THREE.Vector2, t: number) {
  const u = 1 - t;
  return new THREE.Vector2(
    u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  );
}

function cubicAt(
  p0: THREE.Vector2,
  p1: THREE.Vector2,
  p2: THREE.Vector2,
  p3: THREE.Vector2,
  t: number,
) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return new THREE.Vector2(
    a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  );
}
