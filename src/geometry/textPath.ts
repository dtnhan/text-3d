/**
 * Xếp chữ theo hình: vòng tròn, ô vuông, lượn sóng.
 *
 * ## Cách làm: đặt cứng từng chữ, không bẻ cong nét
 *
 * Có hai lối uốn chữ theo đường. Lối thứ nhất là kéo **từng điểm** của nét chữ
 * theo đường cong — chữ sẽ cong theo, phần trong bị nén lại còn phần ngoài giãn
 * ra. Lối thứ hai là giữ nguyên hình chữ, chỉ **xoay và dời** nó tới đúng chỗ
 * trên đường.
 *
 * Ở đây dùng lối thứ hai, vì hai lẽ. Một là đúng với cách nhà chữ vẫn làm: chữ
 * vòng quanh huy hiệu bao giờ cũng giữ nguyên dáng, chỉ xoay. Hai là quan trọng
 * hơn cho việc in: kéo từng điểm sẽ **bóp mỏng nét** ở phía trong đường cong,
 * mà nét mỏng thì gãy khi in.
 *
 * ## Vì sao mọi hình đều quy về một đường gấp khúc
 *
 * Vòng tròn tính được bằng công thức lượng giác, nhưng lượn sóng thì độ dài cung
 * không có công thức đóng, còn ô vuông thì có góc gãy. Thay vì viết ba lối tính
 * riêng, ta lấy mẫu dày mọi hình thành một đường gấp khúc rồi lập bảng độ dài
 * dồn. Tra một điểm chỉ còn là tìm nhị phân trong bảng — đúng cho cả ba hình,
 * và góc gãy của ô vuông tự nhiên rơi vào đúng chỗ đổi đoạn.
 */

import * as THREE from 'three';
import type { ModelParams } from '../state';

export type TextShape = 'straight' | 'circle' | 'wave' | 'square';

export interface Frame {
  point: THREE.Vector2;
  /** Hướng chữ chạy tới. */
  tangent: THREE.Vector2;
  /** Vuông góc với tangent, hướng lên trên đầu chữ. */
  normal: THREE.Vector2;
}

/** Số đoạn lấy mẫu cho mỗi hình — 0.1 mm mỗi đoạn ở cỡ thường dùng. */
const SAMPLES = 2000;

export class TextPath {
  private readonly lengths: number[] = [];

  private constructor(
    private readonly points: THREE.Vector2[],
    readonly closed: boolean,
  ) {
    let total = 0;
    this.lengths.push(0);
    for (let i = 1; i < points.length; i++) {
      total += points[i].distanceTo(points[i - 1]);
      this.lengths.push(total);
    }
  }

  /** Tổng chiều dài đường (mm). */
  get length(): number {
    return this.lengths[this.lengths.length - 1];
  }

  /**
   * Điểm và hướng tại vị trí `s` mm, đo từ mốc giữa của đường.
   *
   * Đường kín thì `s` chạy vòng lại; đường hở thì kẹp ở hai đầu — nhưng ta luôn
   * lấy mẫu rộng hơn bề ngang chữ nên không rơi vào trường hợp đó.
   */
  frameAt(s: number): Frame {
    const total = this.length;
    let target = s + (this.closed ? 0 : total / 2);
    if (this.closed) {
      target = ((target % total) + total) % total;
    } else {
      target = Math.max(0, Math.min(total, target));
    }

    // Tìm nhị phân đoạn chứa `target`.
    let low = 0;
    let high = this.lengths.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (this.lengths[mid] <= target) low = mid;
      else high = mid;
    }

    const span = this.lengths[high] - this.lengths[low];
    const t = span > 1e-9 ? (target - this.lengths[low]) / span : 0;

    const a = this.points[low];
    const b = this.points[high];
    const point = a.clone().lerp(b, t);
    const tangent = b.clone().sub(a);
    if (tangent.lengthSq() < 1e-18) tangent.set(1, 0);
    else tangent.normalize();

    return { point, tangent, normal: new THREE.Vector2(-tangent.y, tangent.x) };
  }

  // -------------------------------------------------------------------------

  /**
   * Dựng đường theo tham số. `textWidth` là bề ngang chữ ở dạng thẳng, dùng để
   * biết phải lấy mẫu đường hở rộng tới đâu.
   */
  static create(params: ModelParams, textWidth: number): TextPath | null {
    switch (params.textShape) {
      case 'straight':
        return null;
      case 'circle':
        return TextPath.circle(params);
      case 'square':
        return TextPath.square(params);
      case 'wave':
        return TextPath.wave(params, textWidth);
    }
  }

  /**
   * Vòng tròn, chữ bắt đầu từ đỉnh và chạy theo chiều kim đồng hồ.
   *
   * Lật thì chữ xuống đáy vòng tròn và chạy ngược lại — đó là kiểu chữ vòng dưới
   * của huy hiệu, đọc vẫn xuôi mà đầu chữ vẫn hướng ra ngoài tâm.
   */
  private static circle(params: ModelParams): TextPath {
    const radius = Math.max(params.shapeRadius, 1);
    const points: THREE.Vector2[] = [];

    for (let i = 0; i <= SAMPLES; i++) {
      // Mốc giữa nằm ở đỉnh vòng tròn, nên góc xuất phát là 90°.
      const along = (i / SAMPLES) * Math.PI * 2;
      const angle = params.shapeFlip ? -Math.PI / 2 + along : Math.PI / 2 - along;
      points.push(new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius));
    }

    // Đường kín: điểm cuối trùng điểm đầu nên `frameAt` chạy vòng được, và mốc
    // giữa nằm ngay tại s = 0 chứ không phải giữa bảng.
    return new TextPath(points, true);
  }

  /**
   * Ô vuông, chữ bắt đầu từ giữa cạnh trên và chạy theo chiều kim đồng hồ.
   *
   * Bốn góc được lấy mẫu trùng điểm nên hướng đổi đột ngột đúng tại góc — chữ
   * xoay dứt khoát chứ không bo tròn qua góc.
   */
  private static square(params: ModelParams): TextPath {
    const half = Math.max(params.shapeRadius, 1);
    const sign = params.shapeFlip ? -1 : 1;

    // Đi từ giữa cạnh trên, sang phải, vòng quanh, rồi về lại giữa cạnh trên.
    const corners = [
      new THREE.Vector2(0, half),
      new THREE.Vector2(half, half),
      new THREE.Vector2(half, -half),
      new THREE.Vector2(-half, -half),
      new THREE.Vector2(-half, half),
      new THREE.Vector2(0, half),
    ].map((p) => new THREE.Vector2(p.x * sign, p.y));

    const points: THREE.Vector2[] = [corners[0]];
    for (let i = 1; i < corners.length; i++) {
      const from = corners[i - 1];
      const to = corners[i];
      const steps = Math.max(2, Math.round((from.distanceTo(to) / (half * 8)) * SAMPLES));
      for (let k = 1; k <= steps; k++) points.push(from.clone().lerp(to, k / steps));
    }

    return new TextPath(points, true);
  }

  /** Hình sin. Mốc giữa nằm tại x = 0, nơi đường cắt trục và đang đi lên. */
  private static wave(params: ModelParams, textWidth: number): TextPath {
    const amplitude = params.waveAmplitude * (params.shapeFlip ? -1 : 1);
    const wavelength = Math.max(params.waveLength, 1);

    // Độ dài cung của hình sin luôn lớn hơn bề ngang theo trục x, nên lấy mẫu
    // rộng bằng bề ngang chữ là chắc chắn đủ; cộng thêm một bước sóng cho dư.
    const half = textWidth / 2 + wavelength;
    const points: THREE.Vector2[] = [];

    for (let i = 0; i <= SAMPLES; i++) {
      const x = -half + (i / SAMPLES) * half * 2;
      points.push(new THREE.Vector2(x, Math.sin((x / wavelength) * Math.PI * 2) * amplitude));
    }

    return new TextPath(points, false);
  }
}
