/**
 * Bộ vật liệu của khung xem.
 *
 * Chữ và đế có màu riêng để nhìn ra ngay đâu là đâu — nhất là ở chế độ khắc
 * chìm, khi chỉ nhìn hình khối thì rất khó thấy chữ lõm tới đâu.
 *
 * Trạng thái rê chuột và đang chọn được thể hiện bằng **ánh phát sáng** cộng
 * thêm chứ không đổi màu nền. Người dùng tự chọn màu chữ và màu đế, nên nếu
 * trạng thái cũng là một màu cố định thì sẽ có lúc trùng với màu họ chọn và mất
 * hẳn tác dụng báo hiệu.
 */

import * as THREE from 'three';

export type Role = 'text' | 'plate';
export type State = 'solid' | 'hover' | 'selected';

/** Ánh phát sáng cộng thêm cho từng trạng thái. */
const GLOW: Record<State, number> = {
  solid: 0x000000,
  // Xám trung tính: nâng sáng mà không nhuộm màu người dùng đã chọn.
  hover: 0x3a3a3a,
  // Xanh bạc hà cho vùng đang chọn, đủ khác mọi màu vật liệu thông thường.
  selected: 0x1f6b4a,
};

/** Màu tay nắm lỗ móc khóa — cố định, vì nó là nút bấm chứ không phải model. */
const HANDLE_COLOR = 0xffb648;

export class Materials {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();
  readonly handle: THREE.MeshStandardMaterial;

  private colors: Record<Role, string> = { text: '#4da3ff', plate: '#c9d2dd' };

  constructor() {
    for (const role of ['text', 'plate'] as Role[]) {
      for (const state of ['solid', 'hover', 'selected'] as State[]) {
        for (const ghost of [false, true]) {
          this.cache.set(key(role, state, ghost), create(state, ghost));
        }
      }
    }

    this.handle = create('solid', false);
    this.handle.color.setHex(HANDLE_COLOR);
    this.handle.emissive.setHex(0x5a3800);

    this.applyColors();
  }

  /** Đổi màu chữ và màu đế. Các vật liệu được sửa tại chỗ nên mesh khỏi dựng lại. */
  setColors(text: string, plate: string): void {
    this.colors = { text, plate };
    this.applyColors();
  }

  get(role: Role, state: State, ghost: boolean): THREE.MeshStandardMaterial {
    return this.cache.get(key(role, state, ghost))!;
  }

  private applyColors(): void {
    for (const [id, material] of this.cache) {
      material.color.set(this.colors[id.split(':')[0] as Role]);
    }
  }
}

function key(role: Role, state: State, ghost: boolean): string {
  return `${role}:${state}:${ghost ? 'ghost' : 'solid'}`;
}

function create(state: State, ghost: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    roughness: 0.45,
    metalness: 0.05,
    // Model gồm nhiều vỏ lồng nhau; vẽ cả hai mặt để không bị "thủng" khi camera
    // lọt vào trong khối.
    side: THREE.DoubleSide,
    emissive: GLOW[state],
    // Khối mờ dùng bắt chuột ở chế độ khắc chìm: đủ thấy chỗ nào kéo được, mà
    // không che mất chỗ lõm bên dưới.
    transparent: ghost,
    opacity: ghost ? 0.24 : 1,
    depthWrite: !ghost,
  });
}
