/**
 * Kiểm tra model trước khi in và đưa ra cảnh báo.
 *
 * Phép kiểm quan trọng nhất là **dò mảnh rời**. Trong tiếng Việt, các dấu (`ầ`,
 * `ể`, `ữ`…) là những đường bao tách hẳn khỏi thân chữ, y như dấu chấm trên chữ
 * `i`. Ở chế độ chữ nổi đơn thuần, chúng in ra thành từng mảnh riêng và rơi
 * khỏi bàn in. Đây là lỗi khiến người dùng in hỏng cả bản mà không hiểu vì sao,
 * nên phải nói rõ ngay trên màn hình chứ không chờ họ tự phát hiện.
 */

import * as THREE from 'three';
import type { Font } from 'opentype.js';
import { findMissingChars } from './fonts/metrics';
import { findIslands } from './geometry/islands';
import type { BuildResult } from './geometry/build';
import type { ModelParams } from './state';

export type IssueLevel = 'error' | 'warning' | 'info';

export interface Issue {
  level: IssueLevel;
  message: string;
}

/** Bề rộng nét tối thiểu nên in (mm) — khoảng hai đường đùn với vòi 0.4 mm. */
const MIN_STROKE_MM = 0.8;
/** Cạnh bàn in phổ thông (mm), dùng để nhắc khi model quá khổ. */
const TYPICAL_BED_MM = 220;

export function validate(result: BuildResult, params: ModelParams, font: Font): Issue[] {
  const issues: Issue[] = [];
  const { size, layout } = result;

  issues.push({
    level: 'info',
    message: `Kích thước: ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm`,
  });

  if (Math.max(size.x, size.y) > TYPICAL_BED_MM) {
    issues.push({
      level: 'warning',
      message: `Model rộng hơn bàn in phổ thông (${TYPICAL_BED_MM} mm). Hãy giảm chiều cao chữ hoặc chia nhỏ ra in nhiều lần.`,
    });
  }

  const missing = findMissingChars(font, params.text);
  if (missing.length > 0) {
    issues.push({
      level: 'error',
      message: `Font này không có ký tự: ${missing.join(' ')}. Hãy chọn font khác có hỗ trợ tiếng Việt.`,
    });
  }

  // --- Mảnh rời ---
  // Xét trên tập hình quyết định model có rời không: chữ cộng thanh nối ở chế
  // độ chữ nổi, hình đế ở các chế độ còn lại. Đế chữ nhật/bo góc/oval luôn liền
  // một mảnh, nhưng đế bo sát chữ thì có thể tách rời khi lề quá nhỏ.
  const parts = countIslands(result.parts);
  if (parts > 1) {
    issues.push({
      level: 'warning',
      message:
        params.mode === 'text'
          ? params.connectors
            ? `Vẫn còn ${parts} mảnh rời dù đã bật thanh nối — có mảnh ở quá xa để nối tới. Hãy giảm giãn chữ, hoặc chuyển sang chế độ có đế.`
            : `Chữ tách thành ${parts} mảnh rời nhau — khi in chúng sẽ rụng ra. Dấu tiếng Việt và các chữ cái đứng riêng đều bị vậy. Hãy bật "Thanh nối giữ dấu", hoặc chuyển sang chế độ có đế.`
          : `Đế tách thành ${parts} mảnh rời nhau. Hãy tăng "Lề quanh chữ" để các phần bo sát chạm được vào nhau, hoặc đổi sang kiểu đế khác.`,
    });
  }

  // --- Nét quá mảnh ---
  const stroke = estimateMinStroke(layout.shapes);
  if (stroke !== null && stroke < MIN_STROKE_MM) {
    issues.push({
      level: 'warning',
      message: `Nét chữ mảnh nhất chỉ khoảng ${fmt(stroke)} mm, dễ gãy hoặc in không ra. Hãy tăng chiều cao chữ, hoặc đổi sang font nét dày hơn.`,
    });
  }

  if (params.bevelEnabled && stroke !== null && params.bevelSize * 2 >= stroke) {
    issues.push({
      level: 'warning',
      message: `Vát cạnh ${fmt(params.bevelSize)} mm quá lớn so với nét chữ ${fmt(stroke)} mm — mặt vát hai bên sẽ chồng lên nhau và làm méo chữ.`,
    });
  }

  // --- Ràng buộc riêng của từng chế độ ---
  if (params.mode === 'deboss' && params.debossDepth >= params.plateThickness) {
    issues.push({
      level: 'error',
      message: `Độ sâu khắc (${fmt(params.debossDepth)} mm) phải nhỏ hơn độ dày đế (${fmt(params.plateThickness)} mm), nếu không sẽ khắc thủng qua đế.`,
    });
  }

  if (params.mode === 'text' && params.connectors && params.connectorWidth < MIN_STROKE_MM) {
    issues.push({
      level: 'warning',
      message: `Thanh nối rộng ${fmt(params.connectorWidth)} mm là quá mảnh để giữ được dấu. Nên để từ ${fmt(MIN_STROKE_MM)} mm trở lên.`,
    });
  }

  // --- Chữ dựng đứng ---
  const upright = params.textAngle > 0 && params.mode !== 'deboss';
  if (upright) {
    // Chữ dựng lên thì chỉ còn tì lên đế bằng bề dày đùn của nó. Tỉ lệ cao trên
    // dày quá lớn là chữ mảnh như lưỡi dao, gãy ngay khi lấy khỏi bàn in.
    const slenderness = params.capHeight / Math.max(params.textDepth, 0.01);
    if (slenderness > 8) {
      issues.push({
        level: 'warning',
        message: `Chữ dựng đứng cao gấp ${slenderness.toFixed(0)} lần bề dày, mảnh như lưỡi dao và rất dễ gãy. Hãy tăng "Độ dày chữ" lên khoảng ${fmt(params.capHeight / 8)} mm trở lên, hoặc giảm chiều cao chữ.`,
      });
    }

    if (params.mode === 'text') {
      issues.push({
        level: 'warning',
        message: 'Chữ dựng đứng mà không có đế thì mỗi chữ chỉ tì lên bàn in bằng một vệt mỏng — gần như chắc chắn đổ khi in. Hãy chuyển sang chế độ có đế.',
      });
    }

    // Đuôi chữ `g`, `y`, `p` thòng xuống dưới đường chân nên chui vào trong đế.
    // Đế đặc thì không sao, miễn là đủ dày để giấu hết.
    const descender = result.layout.pieces.reduce((deepest, piece) => {
      const bottom = new THREE.Box2().setFromPoints(piece.shape.getPoints(1)).min.y;
      return Math.min(deepest, bottom - piece.baselineY);
    }, 0);
    const sunk = -descender * Math.sin((params.textAngle * Math.PI) / 180) + params.uprightSink;

    if (params.mode !== 'text' && sunk > params.plateThickness) {
      issues.push({
        level: 'warning',
        message: `Nét thòng của chữ (đuôi g, y, p…) ăn sâu ${fmt(sunk)} mm nên xuyên qua đáy đế dày ${fmt(params.plateThickness)} mm. Hãy tăng độ dày đế lên ${fmt(Math.ceil(sunk * 2) / 2)} mm, hoặc dùng chữ hoa.`,
      });
    }

    if (params.text.includes('\n')) {
      issues.push({
        level: 'warning',
        message: 'Chữ dựng đứng nhiều dòng thì chỉ dòng thấp nhất chạm được đế, các dòng trên treo lơ lửng. Hãy để một dòng.',
      });
    }

    if (params.textAngle >= 45) {
      issues.push({
        level: 'info',
        message: `Chữ nghiêng ${params.textAngle}° có nhiều chỗ hẫng (đỉnh chữ O, e, a…). Nhớ bật support trong phần mềm cắt lớp.`,
      });
    }
  }

  // Chữ khắc chìm là chỗ lõm chứ không phải khối đặc, nên nó không thể bịt lỗ.
  if (params.keyring && params.mode !== 'deboss' && result.holeBlocked) {
    issues.push({
      level: 'warning',
      message:
        'Lỗ móc khóa đang nằm dưới nét chữ nên bị bịt mất — vòng khóa xỏ không qua. Hãy kéo lỗ ra chỗ trống, hoặc bấm "Bỏ hết chỉnh tay" để đưa lỗ về vị trí mặc định.',
    });
  }

  if (params.keyring && params.holeDiameter < 3) {
    issues.push({
      level: 'info',
      message: 'Lỗ nhỏ hơn 3 mm thường khó xỏ vòng khóa thông dụng.',
    });
  }

  if (params.mode !== 'text' && params.plateThickness < 1.2) {
    issues.push({
      level: 'warning',
      message: `Đế dày ${fmt(params.plateThickness)} mm là khá mỏng, dễ cong vênh. Nên để từ 1.5 mm trở lên.`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------

/** Đếm số mảnh rời nhau. Phép gom mảnh dùng chung với phần dựng thanh nối. */
export function countIslands(shapes: THREE.Shape[]): number {
  return findIslands(shapes).length;
}

/**
 * Ước lượng bề rộng nét mảnh nhất, theo tỉ số diện tích trên chu vi.
 *
 * Với một dải dài bề rộng w, diện tích ≈ w·L còn chu vi ≈ 2L, nên 2·diện
 * tích/chu vi ≈ w. Nét chữ về cơ bản đúng là những dải như vậy, nên công thức
 * này cho ước lượng đủ dùng mà không cần tính trục trung vị.
 */
export function estimateMinStroke(shapes: THREE.Shape[]): number | null {
  let min: number | null = null;

  for (const shape of shapes) {
    const outer = shape.getPoints(1);
    let area = Math.abs(polygonArea(outer));
    let perimeter = polygonPerimeter(outer);

    for (const hole of shape.holes) {
      const points = hole.getPoints(1);
      area -= Math.abs(polygonArea(points));
      perimeter += polygonPerimeter(points);
    }

    if (perimeter <= 0 || area <= 0) continue;
    const width = (2 * area) / perimeter;
    if (min === null || width < min) min = width;
  }

  return min;
}

function polygonArea(points: THREE.Vector2[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y);
  }
  return sum / 2;
}

function polygonPerimeter(points: THREE.Vector2[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j].distanceTo(points[i]);
  }
  return sum;
}

function fmt(value: number): string {
  return value.toFixed(1);
}
