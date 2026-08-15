/**
 * Khung cảnh 3D để xem trước model, và để chỉnh tay bằng kéo thả.
 *
 * Model nằm trong hệ toạ độ máy in: mặt bàn là mặt phẳng XY, chiều cao là +Z.
 * Ta đặt `camera.up` theo trục Z để thao tác xoay khớp với cảm nhận thông
 * thường khi nhìn một vật đặt trên bàn.
 *
 * Mỗi mảnh model là một mesh riêng mang mã định danh, nên tia dò từ con trỏ biết
 * được người dùng đang chạm vào nét chữ nào. Phần logic chọn và kéo nằm ở
 * `interaction.ts`; ở đây chỉ lo dựng cảnh, bắt sự kiện chuột, và tô màu.
 *
 * Lỗ móc khóa là chỗ rỗng nên không có gì để tia dò trúng; nó được gắn một
 * chiếc khuyên nổi làm tay nắm. Khuyên này chỉ là thứ để thao tác, không thuộc
 * model nên không có mặt trong file xuất ra.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Drag, Selection, movedBeyondClick, type DragTarget } from './interaction';
import { Materials } from './materials';
import type { Piece } from '../geometry/build';

/** Cạnh lưới bàn in tham chiếu (mm). */
const BED_SIZE = 220;

/** Mã quy ước của tay nắm lỗ móc khóa. Có dấu cách để không đụng mã nét chữ. */
const HOLE_HANDLE = ' hole';

export interface ViewerCallbacks {
  /** Người dùng vừa thả một hoặc nhiều nét chữ ở vị trí mới. */
  onMoveParts: (parts: Array<{ id: string; token: string }>, dx: number, dy: number) => void;
  /** Người dùng vừa thả lỗ móc khóa ở vị trí mới. */
  onMoveHole: (dx: number, dy: number) => void;
  /** Số nét đang được chọn vừa thay đổi. */
  onSelectionChange: (count: number) => void;
}

export class Viewer {
  readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly modelGroup = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;

  private readonly materials = new Materials();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private readonly selection = new Selection();
  private readonly drag = new Drag();

  private handle: THREE.Mesh | null = null;
  private hovered: THREE.Mesh | null = null;
  /** Vị trí con trỏ lúc nhấn, để phân biệt bấm với kéo. */
  private pressedAt: { x: number; y: number } | null = null;
  /** Nét đã được chọn sẵn lúc nhấn — bấm mà không kéo thì thu vùng chọn về nó. */
  private pendingReduce: string | null = null;

  constructor(canvas: HTMLCanvasElement, private readonly callbacks: ViewerCallbacks) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.background = new THREE.Color(0x1a1d21);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(60, -110, 80);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.addLights();
    this.addBed();
    this.scene.add(this.modelGroup);

    this.bindPointer();
    this.observeResize(canvas);
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** Thay model đang hiển thị. Geometry cũ được giải phóng. */
  setPieces(pieces: Piece[]): void {
    this.hovered = null;
    for (const child of [...this.modelGroup.children]) {
      this.modelGroup.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }

    for (const piece of pieces) {
      const mesh = new THREE.Mesh(piece.geometry, this.materials.get(piece.role, 'solid', false));
      // Chỉ nét chữ mới kéo được; đế và thanh nối do tham số quyết định.
      mesh.userData = {
        id: piece.id,
        role: piece.role,
        token: piece.token,
        draggable: piece.token !== undefined,
        pickOnly: piece.pickOnly === true,
      };
      this.modelGroup.add(mesh);
    }

    // Vùng chọn sống sót qua các lần dựng lại, nhưng phải bỏ những nét không còn.
    const before = this.selection.size;
    this.selection.setOrder(
      pieces.filter((p) => p.token !== undefined).map((p) => p.id),
    );
    this.paint();
    if (this.selection.size !== before) this.callbacks.onSelectionChange(this.selection.size);
  }

  /** Đặt tay nắm cho lỗ móc khóa, hoặc bỏ đi khi model không có lỗ. */
  setHoleHandle(center: THREE.Vector2 | null, topZ: number, diameter: number): void {
    if (this.handle) {
      this.scene.remove(this.handle);
      this.handle.geometry.dispose();
      this.handle = null;
    }
    if (!center) return;

    const tube = Math.max(0.5, diameter * 0.12);
    this.handle = new THREE.Mesh(
      new THREE.TorusGeometry(diameter / 2 + tube, tube, 10, 40),
      this.materials.handle,
    );
    // TorusGeometry nằm sẵn trong mặt phẳng XY, đúng hướng ta cần.
    this.handle.position.set(center.x, center.y, topZ + tube);
    this.handle.userData = { id: HOLE_HANDLE, draggable: true, handle: true };
    this.scene.add(this.handle);
  }

  /** Đổi màu chữ và màu đế. Không cần dựng lại hình học. */
  setColors(text: string, plate: string): void {
    this.materials.setColors(text, plate);
  }

  /** Bỏ chọn tất cả. */
  clearSelection(): void {
    if (!this.selection.clear()) return;
    this.paint();
    this.callbacks.onSelectionChange(0);
  }

  /** Đưa camera về vị trí bao trọn model hiện tại. */
  frameModel(): void {
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);

    const direction = new THREE.Vector3(0.4, -1, 0.75).normalize();
    this.camera.position.copy(center).addScaledVector(direction, distance * 1.25);
    this.camera.near = Math.max(distance / 100, 0.1);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(center);
    this.controls.update();
  }

  // -------------------------------------------------------------------------
  // Chuột và bàn phím
  // -------------------------------------------------------------------------

  private bindPointer(): void {
    // Bắt ở pha "capture" để chặn được OrbitControls: nếu con trỏ đang chạm vào
    // một thứ kéo được thì ta giữ lấy sự kiện, không cho nó xoay camera.
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true });
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', () => this.drag.cancel());
    this.canvas.addEventListener('pointerleave', () => this.clearHover());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.clearSelection();
    });
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;

    this.pressedAt = { x: event.clientX, y: event.clientY };
    this.pendingReduce = null;

    const hit = this.pick(event);
    const object = hit?.object;
    if (!object || !object.userData.draggable) return;

    const id = object.userData.id as string;
    const isHandle = object.userData.handle === true;

    if (!isHandle) this.updateSelectionOnPress(event, id);

    // Kéo một nét đang được chọn thì cả vùng chọn cùng đi.
    const targets: DragTarget[] = isHandle
      ? [{ object, id, isHandle: true }]
      : this.selectedTargets();

    this.drag.begin(targets, hit.point);
    this.controls.enabled = false;
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';

    event.stopPropagation();
    event.preventDefault();
  }

  private updateSelectionOnPress(event: PointerEvent, id: string): void {
    const before = this.selection.size;

    if (event.ctrlKey || event.metaKey) this.selection.toggle(id);
    else if (event.shiftKey) this.selection.range(id);
    else if (!this.selection.has(id)) this.selection.only(id);
    // Nét đã nằm trong vùng chọn: giữ nguyên để kéo cả cụm, nhưng nếu người dùng
    // chỉ bấm chứ không kéo thì lúc thả sẽ thu vùng chọn về riêng nét này.
    else this.pendingReduce = id;

    this.paint();
    if (this.selection.size !== before) this.callbacks.onSelectionChange(this.selection.size);
  }

  private selectedTargets(): DragTarget[] {
    const chosen = new Set(this.selection.list());
    return this.modelGroup.children
      .filter((child) => chosen.has(child.userData.id))
      .map((object) => ({
        object,
        id: object.userData.id as string,
        token: object.userData.token as string | undefined,
        isHandle: false,
      }));
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.drag.active) {
      this.updateHover(event);
      return;
    }

    const point = this.projectToPlane(event, this.drag.getPlane());
    if (point) this.drag.update(point);
  }

  private onPointerUp(event: PointerEvent): void {
    const wasDragging = this.drag.active;

    if (wasDragging) {
      this.canvas.releasePointerCapture(event.pointerId);
      this.controls.enabled = true;
      this.canvas.style.cursor = 'default';

      const commit = this.drag.end();
      if (commit) {
        // Các mesh được giữ nguyên ở chỗ vừa thả; model dựng lại sẽ thay hết.
        if (commit.hole) this.callbacks.onMoveHole(commit.dx, commit.dy);
        else this.callbacks.onMoveParts(commit.parts, commit.dx, commit.dy);
        this.pressedAt = null;
        return;
      }

      // Bấm chứ không kéo: thu vùng chọn về đúng nét vừa bấm.
      if (this.pendingReduce) {
        this.selection.only(this.pendingReduce);
        this.paint();
        this.callbacks.onSelectionChange(this.selection.size);
      }
      this.pressedAt = null;
      return;
    }

    // Bấm vào chỗ trống thì bỏ chọn — nhưng xoay camera thì không, nên phải
    // phân biệt bằng việc con trỏ có xê dịch hay không.
    const pressed = this.pressedAt;
    this.pressedAt = null;
    if (!pressed || movedBeyondClick(pressed, { x: event.clientX, y: event.clientY })) return;
    if (!this.pick(event)) this.clearSelection();
  }

  private pick(event: PointerEvent): THREE.Intersection | null {
    this.setPointer(event);
    const targets: THREE.Object3D[] = [...this.modelGroup.children];
    if (this.handle) targets.push(this.handle);
    return this.raycaster.intersectObjects(targets, false)[0] ?? null;
  }

  private projectToPlane(event: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
    this.setPointer(event);
    const point = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, point) ? point : null;
  }

  private setPointer(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private updateHover(event: PointerEvent): void {
    const hit = this.pick(event);
    const mesh = hit && hit.object.userData.draggable ? (hit.object as THREE.Mesh) : null;

    if (mesh === this.hovered) return;
    this.hovered = mesh;
    this.paint();
    this.canvas.style.cursor = mesh ? 'grab' : 'default';
  }

  private clearHover(): void {
    if (!this.hovered) return;
    this.hovered = null;
    this.paint();
    if (!this.drag.active) this.canvas.style.cursor = 'default';
  }

  /** Tô lại màu mọi mesh theo trạng thái chọn và rê chuột hiện tại. */
  private paint(): void {
    for (const child of this.modelGroup.children) {
      const mesh = child as THREE.Mesh;
      const { id, role, pickOnly } = mesh.userData as {
        id: string;
        role: 'text' | 'plate';
        pickOnly: boolean;
      };

      let state: 'solid' | 'hover' | 'selected' = 'solid';
      if (this.selection.has(id)) state = 'selected';
      else if (mesh === this.hovered) state = 'hover';

      mesh.material = this.materials.get(role, state, pickOnly);
    }
  }

  // -------------------------------------------------------------------------

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x33393f, 2.0));

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(80, -120, 160);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-100, 60, 40);
    this.scene.add(fill);
  }

  /** Lưới tham chiếu cỡ bàn in, giúp ước lượng model có vừa bàn hay không. */
  private addBed(): void {
    const grid = new THREE.GridHelper(BED_SIZE, BED_SIZE / 10, 0x5a6470, 0x2e353d);
    // GridHelper nằm trong mặt phẳng XZ, xoay về mặt phẳng XY của máy in.
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
  }

  private observeResize(canvas: HTMLCanvasElement): void {
    const apply = () => {
      const { clientWidth, clientHeight } = canvas;
      if (clientWidth === 0 || clientHeight === 0) return;
      this.renderer.setSize(clientWidth, clientHeight, false);
      this.camera.aspect = clientWidth / clientHeight;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(apply).observe(canvas);
    apply();
  }

  private tick(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
