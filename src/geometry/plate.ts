/**
 * Dựng tấm đế đỡ chữ, kèm lỗ treo cho móc khóa.
 *
 * Có bốn kiểu đế. Ba kiểu hình học đơn giản — chữ nhật, bo góc, oval — chỉ cần
 * hộp bao của chữ. Kiểu thứ tư, **bo sát chữ**, lấy chính đường bao chữ giãn ra
 * một khoảng, cho ra tấm đế ôm theo dáng chữ như hình dán; kiểu này cần đến
 * hình chữ thật chứ không chỉ hộp bao.
 *
 * Lỗ treo ở ba kiểu đầu chỉ là một đường tròn thêm vào danh sách lỗ của đế, đùn
 * ra là có ngay thành lỗ, không cần phép toán khối. Kiểu bo sát chữ không có
 * chỗ trống nào để khoan, nên được gắn thêm một khuyên tròn nối vào thân đế —
 * xem `attachRing()`.
 */

import * as THREE from 'three';
import { differenceShapes, offsetShapes, unionShapes } from './polygon2d';
import { buildConnectors, closestPair, makeBar } from './connectors';
import { holeOutline } from './holeShapes';
import { pointInPolygon } from './textShapes';
import type { HolePosition, ModelParams, PlateShape } from '../state';

/** Bề rộng tối thiểu của thanh nối các mảnh đế bo sát chữ (mm). */
const MIN_PLATE_BAR = 1.5;

/**
 * Bán kính vòng ngoài của lỗ — khoảng cách xa nhất từ tâm lỗ tới mép lỗ.
 *
 * Phải dùng con số này chứ không phải nửa đường kính lỗ mỗi khi tính chỗ chừa
 * vật liệu quanh lỗ: hình càng nhọn thì mép càng vươn xa khỏi vòng tròn nội
 * tiếp, mà lấy nhầm nửa đường kính thì góc nhọn của lỗ tam giác sẽ thò hẳn ra
 * ngoài mép đế.
 */
function holeReach(params: ModelParams): number {
  return holeOutline(params.holeShape, new THREE.Vector2(), params.holeDiameter).outerRadius;
}

/**
 * Khoét lỗ treo ra khỏi đế, **sau khi** mọi phần của đế đã ghép xong.
 *
 * Trước đây lỗ được gắn thẳng vào hình khuyên treo dưới dạng `shape.holes`, rồi
 * mới hợp khuyên với thân đế. Cách đó hỏng ngay khi khuyên chạm vào đế: phép
 * hợp coi vật liệu của đế là phần đặc và trám luôn vào lòng lỗ. Người dùng kéo
 * lỗ về phía chữ một chút là lỗ biến mất.
 *
 * Khoét sau cùng thì không còn phụ thuộc thứ tự ghép nữa: lỗ luôn thủng, dù bên
 * dưới nó là khuyên treo, là thân đế, hay là cả hai chồng lên nhau.
 */
function punchHole(
  shapes: THREE.Shape[],
  center: THREE.Vector2,
  params: ModelParams,
): THREE.Shape[] {
  const cutter = new THREE.Shape(holeOutline(params.holeShape, center, params.holeDiameter).points);
  return differenceShapes(shapes, [cutter]);
}

export interface PlateResult {
  /** Đế có thể gồm nhiều mảnh rời khi dùng kiểu bo sát chữ. */
  shapes: THREE.Shape[];
  /** Hộp bao của toàn bộ đế (mm). */
  box: THREE.Box2;
  /** Tâm lỗ móc khóa, `null` khi model không có lỗ. */
  holeCenter: THREE.Vector2 | null;
  /**
   * Lỗ đang bị nét chữ nằm đè lên.
   *
   * Lỗ vẫn được khoét thủng qua đế đúng như yêu cầu, nhưng chữ nổi bên trên bịt
   * mất nó nên xỏ vòng khóa không qua. Hay gặp nhất khi người dùng kéo lỗ vào
   * giữa model, hoặc kéo ở kiểu đế này rồi đổi sang kiểu đế khác.
   */
  holeBlocked: boolean;
}

export function buildPlate(
  textShapes: THREE.Shape[],
  textBox: THREE.Box2,
  params: ModelParams,
): PlateResult {
  const built =
    params.plateShape === 'outline'
      ? outlinePlate(textShapes, params)
      : boxPlate(textBox, params);

  const box = new THREE.Box2().makeEmpty();
  for (const shape of built.shapes) {
    for (const point of shape.getPoints(1)) box.expandByPoint(point);
  }

  return { ...built, box, holeBlocked: isHoleBlocked(textShapes, built.holeCenter, params) };
}

interface PlateShapes {
  shapes: THREE.Shape[];
  holeCenter: THREE.Vector2 | null;
}

/** Có nét chữ nào phủ lên lòng lỗ không? */
function isHoleBlocked(
  textShapes: THREE.Shape[],
  center: THREE.Vector2 | null,
  params: ModelParams,
): boolean {
  if (!center) return false;

  const reach = holeReach(params);
  const region = new THREE.Box2(
    new THREE.Vector2(center.x - reach, center.y - reach),
    new THREE.Vector2(center.x + reach, center.y + reach),
  );

  for (const shape of textShapes) {
    const points = shape.getPoints(1);
    if (!new THREE.Box2().setFromPoints(points).intersectsBox(region)) continue;

    // Hai chiều: nét chữ trùm cả lỗ, hoặc nét chữ thò một phần vào lòng lỗ.
    if (pointInPolygon(center, points)) return true;
    if (points.some((p) => p.distanceTo(center) < reach)) return true;
  }
  return false;
}

/**
 * Vị trí lỗ mà người dùng đã kéo tay, cộng vào vị trí mặc định.
 *
 * Dịch chuyển được cộng thêm chứ không thay thế, để hình dạng đế vẫn do các
 * tham số quyết định — nếu vị trí kéo tay thay luôn cả phần nới đế ra cho lỗ,
 * thì đế sẽ co lại ngay khi bắt đầu kéo và lỗ nhảy ra ngoài.
 */
function withHoleOffset(center: THREE.Vector2, params: ModelParams): THREE.Vector2 {
  return center.add(new THREE.Vector2(params.holeOffset.x, params.holeOffset.y));
}

// ---------------------------------------------------------------------------
// Đế bo sát chữ
// ---------------------------------------------------------------------------

/**
 * Đường bao chữ giãn ra `plateMargin`.
 *
 * Phải hợp các hình chữ lại trước khi giãn: font viết tay có các chữ đè lên
 * nhau, mà phép giãn trên những hình chồng chéo cho ra đường bao lộn xộn.
 *
 * Khi lề đủ lớn, phần giãn ra của các chữ chạm nhau và tự gộp thành một mảnh
 * liền. Lề nhỏ hơn thì không — chẳng hạn khoảng trắng giữa hai từ thường rộng
 * hơn hai lần lề. Một tấm đế rời làm mấy mảnh thì vô dụng, nên chỗ nào chưa
 * chạm được ta nối thêm bằng thanh, dùng đúng cơ chế nối dấu của chế độ chữ nổi.
 */
function outlinePlate(textShapes: THREE.Shape[], params: ModelParams): PlateShapes {
  const merged = unionShapes(textShapes);
  let plate = offsetShapes(merged, Math.max(params.plateMargin, 0.01));

  // Bề rộng thanh nối lấy theo lề, để nó trông cùng một hệ với phần bo ra.
  const bars = buildConnectors(plate, Math.max(params.plateMargin, MIN_PLATE_BAR));
  if (bars.length > 0) plate = unionShapes([...plate, ...bars]);

  if (params.mode !== 'keychain') return { shapes: plate, holeCenter: null };
  return attachRing(plate, params);
}

/**
 * Gắn một khuyên tròn có lỗ treo vào cạnh đế, nối bằng một thanh nhỏ.
 *
 * Đế bo sát chữ không có vùng đặc nào rộng để khoan lỗ mà không phạm vào nét
 * chữ, nên lỗ treo phải nằm trên một khuyên riêng đặt ngoài chữ.
 */
function attachRing(plate: THREE.Shape[], params: ModelParams): PlateShapes {
  const box = new THREE.Box2().makeEmpty();
  for (const shape of plate) for (const p of shape.getPoints(1)) box.expandByPoint(p);

  const reach = holeReach(params);
  const ringRadius = reach + params.holeMargin;
  const center = withHoleOffset(ringCenter(box, params.holePosition, ringRadius), params);

  // Khuyên dựng đặc, chưa có lỗ — lỗ được khoét ở bước cuối cùng.
  const shapes = [...plate, new THREE.Shape(ringPoints(center, ringRadius))];

  // Nối khuyên vào thân đế bằng một thanh chạy từ mép ngoài khuyên tới điểm gần
  // nhất trên đế.
  //
  // makeBar nới **cả hai đầu** thêm nửa bề rộng để cắm chắc vào hai bên. Nên
  // điểm xuất phát phải nằm ngoài lòng lỗ ít nhất chừng ấy, nếu không đầu bị nới
  // sẽ thò ngược vào và bịt mất lỗ. Bề rộng thanh đúng bằng hai lần khoảng cách
  // mép, nên mép trong của thanh rơi đúng vào `reach` — sát mép lỗ mà không lẹm.
  const outline = plate.flatMap((s) => s.getPoints(1));
  if (outline.length > 0) {
    const [, target] = closestPair([center], outline);
    const direction = target.clone().sub(center);
    const distance = direction.length();

    // ringCenter đã đặt khuyên hẳn ra ngoài đế nên điều kiện này luôn đúng; giữ
    // lại để phòng trường hợp người dùng kéo khuyên đè lên chữ, khi đó thà bỏ
    // thanh nối còn hơn dựng ra một cái thanh xuyên qua lỗ.
    if (distance > ringRadius) {
      const from = center.clone().addScaledVector(direction.divideScalar(distance), ringRadius);
      const bar = makeBar(from, target, params.holeMargin * 2);
      if (bar) shapes.push(bar);
    }
  }

  return { shapes: punchHole(unionShapes(shapes), center, params), holeCenter: center };
}

/**
 * Tâm khuyên treo, đặt hẳn ra ngoài hộp bao của đế theo phía người dùng chọn.
 *
 * Đặt hẳn ra ngoài chứ không cho chồng lên đế: chồng lên thì chỗ dính nhau là
 * phần giao của khuyên với một góc nhọn của chữ, mỏng dày bao nhiêu tuỳ chữ —
 * có khi chỉ còn một sợi chỉ. Tách hẳn ra rồi nối bằng thanh thì chỗ dính luôn
 * dày đúng bằng bề rộng thanh, không phụ thuộc chữ.
 */
function ringCenter(box: THREE.Box2, position: HolePosition, ringRadius: number): THREE.Vector2 {
  const center = box.getCenter(new THREE.Vector2());
  const gap = Math.max(1, ringRadius * 0.2);
  const offset = ringRadius + gap;

  switch (position) {
    case 'left':
      return new THREE.Vector2(box.min.x - offset, center.y);
    case 'right':
      return new THREE.Vector2(box.max.x + offset, center.y);
    case 'top':
      return new THREE.Vector2(center.x, box.max.y + offset);
  }
}

// ---------------------------------------------------------------------------
// Đế hình học đơn giản
// ---------------------------------------------------------------------------

function boxPlate(textBox: THREE.Box2, params: ModelParams): PlateShapes {
  const margin = params.plateMargin;
  const box = new THREE.Box2(
    new THREE.Vector2(textBox.min.x - margin, textBox.min.y - margin),
    new THREE.Vector2(textBox.max.x + margin, textBox.max.y + margin),
  );

  const needsHole = params.mode === 'keychain';
  const reach = needsHole ? holeReach(params) : 0;

  if (needsHole) {
    // Nới đế thêm về phía đặt lỗ để có chỗ khoan mà không ăn vào chữ.
    const tab = reach * 2 + params.holeMargin * 2;
    switch (params.holePosition) {
      case 'left':
        box.min.x -= tab;
        break;
      case 'right':
        box.max.x += tab;
        break;
      case 'top':
        box.max.y += tab;
        break;
    }
  }

  const shape = outlineShape(box, params.plateShape, params.plateRadius);
  if (!needsHole) return { shapes: [shape], holeCenter: null };

  const center = withHoleOffset(holeCenter(box, params, reach), params);
  return { shapes: punchHole([shape], center, params), holeCenter: center };
}

/** Đường bao ngoài của đế theo hình dạng người dùng chọn. */
function outlineShape(box: THREE.Box2, kind: PlateShape, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const { min, max } = box;

  switch (kind) {
    case 'rounded': {
      // Không cho bán kính bo vượt quá nửa cạnh ngắn, nếu không góc bo sẽ tự cắt.
      const r = Math.max(0, Math.min(radius, (max.x - min.x) / 2, (max.y - min.y) / 2));
      if (r === 0) return outlineShape(box, 'rect', 0);

      shape.moveTo(min.x + r, min.y);
      shape.lineTo(max.x - r, min.y);
      shape.absarc(max.x - r, min.y + r, r, -Math.PI / 2, 0, false);
      shape.lineTo(max.x, max.y - r);
      shape.absarc(max.x - r, max.y - r, r, 0, Math.PI / 2, false);
      shape.lineTo(min.x + r, max.y);
      shape.absarc(min.x + r, max.y - r, r, Math.PI / 2, Math.PI, false);
      shape.lineTo(min.x, min.y + r);
      shape.absarc(min.x + r, min.y + r, r, Math.PI, Math.PI * 1.5, false);
      break;
    }

    case 'oval': {
      const center = box.getCenter(new THREE.Vector2());
      // Hình elip nội tiếp hộp chữ nhật sẽ cắt vào bốn góc chữ, nên phóng bán
      // trục lên √2 lần để elip bao trọn hộp thay vì nằm lọt trong nó.
      const rx = ((max.x - min.x) / 2) * Math.SQRT2;
      const ry = ((max.y - min.y) / 2) * Math.SQRT2;
      shape.absellipse(center.x, center.y, rx, ry, 0, Math.PI * 2, false, 0);
      box.min.set(center.x - rx, center.y - ry);
      box.max.set(center.x + rx, center.y + ry);
      break;
    }

    // 'outline' không đi qua đây — nó được dựng riêng ở outlinePlate().
    case 'rect':
    case 'outline': {
      shape.moveTo(min.x, min.y);
      shape.lineTo(max.x, min.y);
      shape.lineTo(max.x, max.y);
      shape.lineTo(min.x, max.y);
      shape.closePath();
      break;
    }
  }

  return shape;
}

/**
 * Tâm lỗ treo, đặt sát mép đế theo phía người dùng chọn.
 *
 * Với đế chữ nhật hay bo góc, mép là đoạn thẳng nên chỉ cần lùi vào một đoạn
 * bằng bán kính cộng khoảng cách mép. Với đế oval thì không được: điểm ngoài
 * cùng của elip là một mũi nhọn, khoan lỗ ở đó sẽ thủng ra ngoài. Nên ta thu
 * nhỏ elip lại đúng bằng khoảng hở cần thiết rồi đặt tâm lỗ lên mép elip nhỏ đó.
 */
function holeCenter(box: THREE.Box2, params: ModelParams, reach: number): THREE.Vector2 {
  const center = box.getCenter(new THREE.Vector2());
  const offset = reach + params.holeMargin;

  if (params.plateShape === 'oval') {
    const innerX = Math.max(0, (box.max.x - box.min.x) / 2 - offset);
    const innerY = Math.max(0, (box.max.y - box.min.y) / 2 - offset);
    switch (params.holePosition) {
      case 'left':
        return new THREE.Vector2(center.x - innerX, center.y);
      case 'right':
        return new THREE.Vector2(center.x + innerX, center.y);
      case 'top':
        return new THREE.Vector2(center.x, center.y + innerY);
    }
  }

  switch (params.holePosition) {
    case 'left':
      return new THREE.Vector2(box.min.x + offset, center.y);
    case 'right':
      return new THREE.Vector2(box.max.x - offset, center.y);
    case 'top':
      return new THREE.Vector2(center.x, box.max.y - offset);
  }
}

/** Đường bao ngoài tròn của khuyên treo, ngược chiều kim đồng hồ. */
function ringPoints(center: THREE.Vector2, radius: number): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  const segments = 48;
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(
      new THREE.Vector2(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius),
    );
  }
  return points;
}
