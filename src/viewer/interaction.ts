/**
 * Chọn và kéo thả các nét chữ trong khung xem 3D.
 *
 * Tách khỏi `scene.ts` vì phần này thuần logic thao tác — chọn cái gì, kéo đi
 * đâu — còn bên kia lo dựng cảnh và vẽ. Hai việc đó thay đổi vì những lý do
 * khác nhau.
 *
 * ## Quy ước chọn
 *
 * - Bấm một nét → chọn riêng nét đó.
 * - Ctrl (hoặc Cmd) + bấm → thêm/bớt một nét khỏi vùng chọn.
 * - Shift + bấm → chọn cả cụm từ nét đã bấm trước tới nét vừa bấm, tính trọn
 *   ký tự ở hai đầu. Đây là cách chọn "một cụm ký tự" để kéo cả cụm.
 * - Bấm ra chỗ trống, hoặc phím Esc → bỏ chọn.
 *
 * Kéo một nét đang được chọn thì cả vùng chọn cùng đi; kéo một nét chưa chọn thì
 * nó tự trở thành vùng chọn mới.
 */

import * as THREE from 'three';

/** Bỏ qua những cú kéo ngắn hơn ngưỡng này (mm) — coi như bấm chứ không kéo. */
const MIN_DRAG_MM = 0.05;

/** Con trỏ xê dịch trong ngưỡng này (pixel) vẫn tính là một cú bấm. */
const CLICK_SLOP_PX = 4;

export interface DragTarget {
  object: THREE.Object3D;
  id: string;
  token?: string;
  isHandle: boolean;
}

export interface DragCommit {
  /** Các mảnh vừa được kéo, rỗng nếu đang kéo tay nắm lỗ. */
  parts: Array<{ id: string; token: string }>;
  /** Đang kéo tay nắm lỗ móc khóa. */
  hole: boolean;
  dx: number;
  dy: number;
}

interface Held {
  object: THREE.Object3D;
  origin: THREE.Vector3;
  id: string;
  token?: string;
}

/** Quản lý vùng chọn: thứ tự các nét, và phép chọn theo cụm. */
export class Selection {
  private ids = new Set<string>();
  /** Thứ tự các nét theo bố cục, để chọn cụm biết đâu là "ở giữa". */
  private order: string[] = [];
  private anchor: string | null = null;

  /** Cập nhật danh sách nét hiện có, giữ lại những lựa chọn còn hợp lệ. */
  setOrder(ids: string[]): void {
    this.order = ids;
    const alive = new Set(ids);
    for (const id of [...this.ids]) if (!alive.has(id)) this.ids.delete(id);
    if (this.anchor && !alive.has(this.anchor)) this.anchor = null;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }

  list(): string[] {
    return [...this.ids];
  }

  clear(): boolean {
    if (this.ids.size === 0) return false;
    this.ids.clear();
    this.anchor = null;
    return true;
  }

  only(id: string): void {
    this.ids = new Set([id]);
    this.anchor = id;
  }

  toggle(id: string): void {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.anchor = id;
  }

  /**
   * Chọn cả cụm từ nét neo tới nét vừa bấm.
   *
   * Vùng chọn được nới ra cho trọn ký tự ở hai đầu: người dùng nghĩ theo đơn vị
   * chữ chứ không theo từng đường bao, nên chọn nửa cái dấu mũ là vô nghĩa.
   */
  range(id: string): void {
    if (!this.anchor) {
      this.only(id);
      return;
    }

    const from = this.order.indexOf(this.anchor);
    const to = this.order.indexOf(id);
    if (from === -1 || to === -1) {
      this.only(id);
      return;
    }

    const lowGlyph = glyphOf(this.order[Math.min(from, to)]);
    const highGlyph = glyphOf(this.order[Math.max(from, to)]);
    const start = this.order.findIndex((other) => glyphOf(other) === lowGlyph);
    const end = this.order.findLastIndex((other) => glyphOf(other) === highGlyph);

    this.ids = new Set(this.order.slice(start, end + 1));
  }
}

/** Phần ký tự của mã định danh: `L0G3S1` → `L0G3`. */
function glyphOf(id: string): string {
  return id.replace(/S\d+$/, '');
}

/**
 * Trạng thái một lượt kéo đang diễn ra.
 *
 * Lưu ý: khi thả, các mesh được **giữ nguyên** ở chỗ vừa kéo tới chứ không trả
 * về vị trí cũ. Trước đây có trả về, và vì việc dựng lại model bị hoãn một nhịp
 * nên người dùng thấy chữ nháy về chỗ cũ rồi mới nhảy tới chỗ mới. Model dựng
 * lại sẽ thay toàn bộ mesh, nên để nguyên là đúng.
 */
export class Drag {
  private held: Held[] = [];
  private handle: THREE.Object3D | null = null;
  private start = new THREE.Vector3();
  private plane = new THREE.Plane();
  private moved = false;

  get active(): boolean {
    return this.held.length > 0 || this.handle !== null;
  }

  begin(targets: DragTarget[], point: THREE.Vector3): void {
    this.start.copy(point);
    // Mặt phẳng kéo nằm ngang, đi qua đúng điểm vừa chạm — nhờ vậy chỗ nắm
    // không bị trượt khỏi con trỏ dù camera đang nhìn nghiêng.
    this.plane.set(new THREE.Vector3(0, 0, 1), -point.z);
    this.moved = false;

    this.held = [];
    this.handle = null;

    for (const target of targets) {
      if (target.isHandle) this.handle = target.object;
      else {
        this.held.push({
          object: target.object,
          origin: target.object.position.clone(),
          id: target.id,
          token: target.token,
        });
      }
    }
    if (this.handle) this.handleOrigin = this.handle.position.clone();
  }

  private handleOrigin = new THREE.Vector3();

  getPlane(): THREE.Plane {
    return this.plane;
  }

  /** Dời các mesh đang kéo theo con trỏ, để phản hồi tức thì. */
  update(point: THREE.Vector3): void {
    const dx = point.x - this.start.x;
    const dy = point.y - this.start.y;
    if (Math.hypot(dx, dy) > MIN_DRAG_MM) this.moved = true;

    for (const item of this.held) {
      item.object.position.set(item.origin.x + dx, item.origin.y + dy, item.origin.z);
    }
    if (this.handle) {
      this.handle.position.set(
        this.handleOrigin.x + dx,
        this.handleOrigin.y + dy,
        this.handleOrigin.z,
      );
    }
  }

  /**
   * Kết thúc lượt kéo. Trả về phần dịch chuyển cần ghi lại, hoặc `null` nếu
   * người dùng chỉ bấm chứ không kéo đi đâu.
   */
  end(): DragCommit | null {
    const reference = this.held[0] ?? null;
    let dx = 0;
    let dy = 0;

    if (reference) {
      dx = reference.object.position.x - reference.origin.x;
      dy = reference.object.position.y - reference.origin.y;
    } else if (this.handle) {
      dx = this.handle.position.x - this.handleOrigin.x;
      dy = this.handle.position.y - this.handleOrigin.y;
    }

    const moved = this.moved;
    const parts = this.held.map((item) => ({ id: item.id, token: item.token ?? '' }));
    const hole = this.handle !== null;

    if (!moved) this.restore();
    this.held = [];
    this.handle = null;

    return moved ? { parts, hole, dx, dy } : null;
  }

  /** Trả mọi thứ về chỗ cũ — dùng khi huỷ giữa chừng hoặc chỉ bấm. */
  restore(): void {
    for (const item of this.held) item.object.position.copy(item.origin);
    if (this.handle) this.handle.position.copy(this.handleOrigin);
  }

  cancel(): void {
    this.restore();
    this.held = [];
    this.handle = null;
  }
}

/** Con trỏ có xê dịch quá ngưỡng một cú bấm không? */
export function movedBeyondClick(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) > CLICK_SLOP_PX;
}
