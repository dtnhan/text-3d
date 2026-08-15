/**
 * Nạp và quản lý các hình chèn thêm — logo, icon, hình trang trí.
 *
 * Cùng lối với `FontManager`: phần **tham số** chỉ giữ mã và kích thước (thứ
 * người dùng chỉnh được), còn hình đã phân tích thì nằm ở kho này. Nhờ vậy
 * `ModelParams` vẫn là dữ liệu thuần, so sánh được bằng tham chiếu — điều mà
 * đường tắt "chỉ đổi màu thì khỏi dựng lại" trong `main.ts` dựa vào.
 *
 * Hình được chuẩn hoá về **chiều cao bằng 1 và tâm tại gốc toạ độ** ngay lúc
 * nạp. Sau đó chỉ cần nhân với chiều cao tính bằng milimét người dùng đặt là ra
 * kích thước thật, y như cách chữ quy đổi theo chiều cao chữ hoa.
 */

import * as THREE from 'three';
import { parseSvg, SvgError } from './svgShapes';
import { traceBitmap, TraceError, type Bitmap, type TraceOptions } from './traceBitmap';

export interface LoadedGraphic {
  id: string;
  name: string;
  source: 'svg' | 'image';
  /** Hình đã chuẩn hoá: cao đúng 1 đơn vị, tâm tại gốc toạ độ. */
  shapes: THREE.Shape[];
  /** Bề ngang khi cao 1 đơn vị — dùng để tính bề ngang thật. */
  aspect: number;
  /** Số nét vẽ đã được nới thành vùng đặc, nếu có. */
  strokeCount: number;
}

export class GraphicStore {
  private items = new Map<string, LoadedGraphic>();

  get(id: string): LoadedGraphic | undefined {
    return this.items.get(id);
  }

  list(): LoadedGraphic[] {
    return [...this.items.values()];
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  /** Nạp một file người dùng chọn. Ném lỗi có lời giải thích nếu không dùng được. */
  async loadFile(file: File, trace?: TraceOptions): Promise<LoadedGraphic> {
    const name = file.name.replace(/\.[^.]+$/, '');
    const id = `g${Date.now().toString(36)}${this.items.size}`;

    const isSvg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
    const record = isSvg
      ? this.fromSvg(id, name, await file.text())
      : this.fromImage(id, name, await decodeImage(file), trace);

    this.items.set(id, record);
    return record;
  }

  /** Nạp thẳng từ chuỗi SVG — dùng cho hình đóng gói sẵn và cho phần kiểm thử. */
  addSvg(id: string, name: string, source: string): LoadedGraphic {
    const record = this.fromSvg(id, name, source);
    this.items.set(id, record);
    return record;
  }

  private fromSvg(id: string, name: string, source: string): LoadedGraphic {
    const { shapes, strokeCount } = parseSvg(source);
    return { id, name, source: 'svg', strokeCount, ...normalize(shapes) };
  }

  private fromImage(
    id: string,
    name: string,
    bitmap: Bitmap,
    trace?: TraceOptions,
  ): LoadedGraphic {
    const shapes = traceBitmap(bitmap, trace);
    return { id, name, source: 'image', strokeCount: 0, ...normalize(shapes) };
  }
}

export { SvgError, TraceError };

/** Đưa hình về chiều cao 1 đơn vị, tâm tại gốc toạ độ. */
function normalize(shapes: THREE.Shape[]): { shapes: THREE.Shape[]; aspect: number } {
  const box = new THREE.Box2().makeEmpty();
  for (const shape of shapes) {
    for (const p of shape.getPoints(1)) box.expandByPoint(p);
  }

  const size = box.getSize(new THREE.Vector2());
  if (size.y <= 0 || size.x <= 0) {
    throw new SvgError('Hình này không có kích thước — có thể file rỗng hoặc chỉ chứa đường thẳng.');
  }

  const scale = 1 / size.y;
  const center = box.getCenter(new THREE.Vector2());

  return {
    shapes: shapes.map((shape) => transform(shape, center, scale)),
    aspect: size.x / size.y,
  };
}

/**
 * Dời về tâm rồi thu phóng. Các shape ở đây dựng từ danh sách điểm nên chỉ chứa
 * LineCurve — đọc lại điểm rồi dựng shape mới là cách gọn nhất.
 */
function transform(shape: THREE.Shape, center: THREE.Vector2, scale: number): THREE.Shape {
  const apply = (points: THREE.Vector2[]) =>
    points.map((p) => new THREE.Vector2((p.x - center.x) * scale, (p.y - center.y) * scale));

  const result = new THREE.Shape(apply(shape.getPoints(1)));
  result.holes = shape.holes.map((hole) => new THREE.Path(apply(hole.getPoints(1))));
  return result;
}

/**
 * Giải mã ảnh raster thành mảng điểm ảnh.
 *
 * Ảnh quá lớn được thu nhỏ lại trước khi dò biên: chi tiết nhỏ hơn một đường đùn
 * thì in ra cũng không thấy, mà số điểm biên lại tăng theo bình phương.
 */
const MAX_TRACE_SIZE = 512;

async function decodeImage(file: File): Promise<Bitmap> {
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file);
  } catch (err) {
    throw new TraceError(
      `Không đọc được ảnh "${file.name}". Hãy dùng file PNG, JPG hoặc WebP. (${
        err instanceof Error ? err.message : err
      })`,
    );
  }

  const scale = Math.min(1, MAX_TRACE_SIZE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new TraceError('Trình duyệt không cho dựng canvas để đọc ảnh.');

  context.drawImage(source, 0, 0, width, height);
  source.close();

  const image = context.getImageData(0, 0, width, height);
  return { data: image.data, width, height };
}
