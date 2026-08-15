/**
 * Đọc file SVG thành THREE.Shape để đùn khối.
 *
 * Dùng `SVGLoader` của Three.js để phân tích cú pháp — nó lo hết phần ngữ pháp
 * đường path, các phép biến đổi, và mọi loại thẻ hình học. Nhưng phần **phân
 * biệt đâu là phần đặc đâu là lỗ** thì ta tự làm, bằng đúng thuật toán bao hàm
 * đang dùng cho glyph (`shapesFromRings`). Lý do giống hệt bên font: các bộ dựng
 * hình dựa vào chiều quay đường bao đều sai với một phần đáng kể dữ liệu thật.
 *
 * ## Icon vẽ bằng nét
 *
 * Rất nhiều bộ icon phổ biến — Feather, Lucide, các bộ "outline" của Material —
 * không tô đặc hình nào cả, mà chỉ gồm những đường có `stroke-width`. Đưa thẳng
 * vào bộ đùn thì ra model rỗng không, và người dùng chỉ thấy "không có gì hiện
 * ra" mà không hiểu vì sao. Nên ta nới các đường đó ra đúng bề rộng nét của
 * chúng để thành vùng đặc in được.
 */

import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { shapesFromRings } from '../geometry/textShapes';
import { strokeToShapes, unionShapes } from '../geometry/polygon2d';

export interface SvgResult {
  shapes: THREE.Shape[];
  /** Số đường được dựng từ nét vẽ thay vì từ vùng tô đặc. */
  strokeCount: number;
}

export class SvgError extends Error {}

/** Số đoạn chia mỗi đường cong khi làm phẳng — SVG dùng nhiều cung tròn. */
const CURVE_DIVISIONS = 24;

/** Bề rộng nét dự phòng khi SVG không khai `stroke-width`. */
const DEFAULT_STROKE_WIDTH = 1;

export function parseSvg(source: string): SvgResult {
  let parsed: ReturnType<SVGLoader['parse']>;
  try {
    parsed = new SVGLoader().parse(source);
  } catch (err) {
    throw new SvgError(`Không đọc được file SVG: ${err instanceof Error ? err.message : err}`);
  }

  const filled: THREE.Vector2[][] = [];
  const strokes: Array<{ line: THREE.Vector2[]; width: number }> = [];

  for (const path of parsed.paths) {
    const style = (path.userData?.style ?? {}) as Record<string, unknown>;
    const hasFill = style.fill !== undefined && style.fill !== 'none';
    const hasStroke = style.stroke !== undefined && style.stroke !== 'none';

    for (const subPath of path.subPaths) {
      // SVG dùng trục Y hướng xuống, Three.js hướng lên.
      const points = subPath
        .getPoints(CURVE_DIVISIONS)
        .map((p) => new THREE.Vector2(p.x, -p.y));
      if (points.length < 2) continue;

      // Không khai gì cả thì SVG mặc định là tô đen — đó cũng là trường hợp phổ
      // biến nhất với icon xuất từ phần mềm vẽ.
      if (hasFill || !hasStroke) {
        filled.push(points);
      } else {
        strokes.push({ line: points, width: strokeWidth(style) });
      }
    }
  }

  const shapes = [...shapesFromRings(filled)];

  // Gom các nét cùng bề rộng lại để gọi phép nới ít lần nhất.
  const byWidth = new Map<number, THREE.Vector2[][]>();
  for (const { line, width } of strokes) {
    const group = byWidth.get(width);
    if (group) group.push(line);
    else byWidth.set(width, [line]);
  }
  for (const [width, lines] of byWidth) shapes.push(...strokeToShapes(lines, width));

  if (shapes.length === 0) {
    throw new SvgError(
      'File SVG này không có hình nào đặc để in. Nếu nó chỉ gồm ảnh nhúng hoặc chữ chưa chuyển thành đường, hãy mở bằng phần mềm vẽ và chuyển chữ sang dạng đường (convert to path) rồi lưu lại.',
    );
  }

  // Icon hay có nhiều nét chồng lên nhau; hợp lại để bộ tam giác hoá khỏi phải
  // xử lý những vùng giao nhau, đúng như đã làm với font viết tay.
  return { shapes: unionShapes(shapes), strokeCount: strokes.length };
}

function strokeWidth(style: Record<string, unknown>): number {
  const raw = style['stroke-width'] ?? style.strokeWidth;
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STROKE_WIDTH;
}
