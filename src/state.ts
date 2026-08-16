/**
 * Toàn bộ tham số điều khiển model. Mọi giá trị chiều dài tính bằng **milimét**
 * (1 unit Three.js = 1 mm), khớp trực tiếp với đơn vị của file STL.
 */

export type BuildMode = 'text' | 'plate' | 'deboss';
export type PlateShape = 'rect' | 'rounded' | 'oval' | 'outline';
export type TextAlign = 'left' | 'center' | 'right';
export type HolePosition = 'left' | 'right' | 'top';

import type { HoleShape } from './geometry/holeShapes';
export type { HoleShape };

import type { TextShape } from './geometry/textPath';
export type { TextShape };

/**
 * Một hình chèn thêm — logo, icon, hình trang trí.
 *
 * Chỉ giữ phần người dùng chỉnh được; hình đã phân tích nằm ở `GraphicStore`,
 * tra theo `id`. Nhờ vậy ModelParams vẫn là dữ liệu thuần, so sánh được bằng
 * tham chiếu — điều mà đường tắt "chỉ đổi màu thì khỏi dựng lại" dựa vào.
 */
export interface GraphicRef {
  id: string;
  name: string;
  /** Chiều cao hình (mm). Bề ngang suy ra theo tỉ lệ gốc. */
  height: number;
}

/**
 * Dịch chuyển thủ công một mảnh, do người dùng kéo thả trong khung xem 3D.
 *
 * `token` là thứ đã sinh ra mảnh đó — ký tự với nét chữ, mã hình với hình chèn.
 * Khoá của bản ghi này dựa trên chỉ số, mà chỉ số thì trượt đi khi người dùng
 * sửa nội dung; giữ lại `token` để nhận ra chuyện đó và bỏ qua, thay vì đem dịch
 * chuyển áp nhầm sang một mảnh khác vừa trôi vào đúng vị trí ấy.
 */
export interface PartOffset {
  dx: number;
  dy: number;
  token: string;
}

export interface ModelParams {
  // --- Nội dung ---
  text: string;
  fontId: string;
  /** Giãn chữ, tính theo phần trăm chiều cao chữ hoa. */
  letterSpacing: number;
  /** Giãn dòng, hệ số nhân với chiều cao chữ hoa. */
  lineHeight: number;
  align: TextAlign;

  // --- Xếp chữ theo hình ---
  textShape: TextShape;
  /** Bán kính vòng tròn, hoặc nửa cạnh ô vuông (mm). */
  shapeRadius: number;
  /** Biên độ sóng (mm). */
  waveAmplitude: number;
  /** Bước sóng (mm). */
  waveLength: number;
  /** Lật hình: chữ xuống nửa dưới vòng tròn, hoặc đảo pha sóng. */
  shapeFlip: boolean;

  // --- Khối chữ ---
  /** Chiều cao chữ HOA (mm) — quy chiếu vật lý cho mọi dòng. */
  capHeight: number;
  /** Độ dày đùn của chữ (mm). */
  textDepth: number;
  bevelEnabled: boolean;
  /** Kích thước vát cạnh (mm), áp cho cả bề rộng lẫn chiều cao vát. */
  bevelSize: number;

  /**
   * Góc dựng chữ so với mặt đế (độ). 0 là chữ nằm phẳng như bình thường, 90 là
   * chữ đứng vuông góc với đế — kiểu biển tên để bàn. Chế độ khắc chìm bỏ qua
   * tham số này, vì khắc một hình chiếu thì chẳng ra chữ gì.
   */
  textAngle: number;

  /**
   * Chữ dựng đứng lún vào đế bao nhiêu (mm).
   *
   * Chữ đứng chỉ chạm đế bằng mép dưới của nét. Chữ có đáy phẳng như `B` thì
   * chạm cả một đoạn, nhưng chữ tròn như `O` chỉ chạm đúng một điểm — in ra là
   * rụng. Cho lún xuống một chút thì chỗ tròn ấy cắt thành một đoạn thẳng có bề
   * rộng thật, đủ để bám vào đế.
   */
  uprightSink: number;

  /**
   * Thêm thanh nối giữ các mảnh rời của chữ (dấu mũ, dấu ngã, chấm trên chữ i,
   * các chữ cái đứng cách nhau). Chỉ dùng ở chế độ chữ nổi đơn thuần — các chế
   * độ khác đã có đế giữ mọi thứ lại.
   */
  connectors: boolean;
  /** Bề rộng thanh nối (mm). */
  connectorWidth: number;

  // --- Chế độ ---
  mode: BuildMode;

  // --- Đế ---
  plateShape: PlateShape;
  /**
   * Lề bao quanh chữ (mm). Với đế bo sát chữ, đây là khoảng đường bao phình ra
   * khỏi nét chữ.
   */
  plateMargin: number;
  plateThickness: number;
  /** Bán kính bo góc (mm), chỉ dùng cho plateShape = 'rounded'. */
  plateRadius: number;

  // --- Móc khóa ---
  /**
   * Khoét lỗ treo trên đế.
   *
   * Tách khỏi tên chế độ chứ không gộp vào. Trước đây "móc khóa" là một chế độ
   * riêng, nên muốn móc khóa mà chữ khắc chìm thì không có cách nào diễn đạt —
   * phải đẻ thêm chế độ thứ năm, rồi thứ sáu cho mọi tổ hợp về sau. Lỗ treo vốn
   * độc lập với việc chữ nổi hay chữ chìm, nên để nó là một lựa chọn riêng.
   */
  keyring: boolean;
  /** Hình dạng lỗ treo. */
  holeShape: HoleShape;
  /**
   * Đường kính vòng tròn **lọt vừa** lòng lỗ (mm) — không phải bề ngang của
   * hình. Xem `holeShapes.ts` giải thích vì sao đo theo cách này.
   */
  holeDiameter: number;
  holePosition: HolePosition;
  /** Khoảng cách từ mép lỗ tới mép đế (mm). */
  holeMargin: number;

  // --- Khắc chìm ---
  debossDepth: number;

  // --- Hình chèn thêm ---
  graphics: GraphicRef[];

  // --- Chỉnh tay bằng kéo thả ---
  /** Dịch chuyển từng nét chữ, khoá theo `L<dòng>G<ký tự>S<nét>`. */
  partOffsets: Record<string, PartOffset>;
  /** Dịch chuyển lỗ móc khóa khỏi vị trí mặc định (mm). */
  holeOffset: { x: number; y: number };

  // --- Màu xem trước ---
  /**
   * Màu hiển thị, dạng `#rrggbb`. Chỉ ảnh hưởng khung xem — file STL và OBJ
   * không mang màu, màu thật là do cuộn nhựa nạp vào máy in quyết định.
   */
  textColor: string;
  plateColor: string;

  // --- Chất lượng ---
  /** Số đoạn thẳng dùng để làm phẳng mỗi đường cong Bézier của glyph. */
  curveSegments: number;
}

export const DEFAULT_PARAMS: ModelParams = {
  text: 'Xin chào',
  fontId: '',
  letterSpacing: 0,
  lineHeight: 1.4,
  align: 'center',

  textShape: 'straight',
  shapeRadius: 40,
  waveAmplitude: 8,
  waveLength: 60,
  shapeFlip: false,

  capHeight: 20,
  textDepth: 4,
  bevelEnabled: false,
  bevelSize: 0.4,
  textAngle: 0,
  uprightSink: 1,

  connectors: false,
  connectorWidth: 2,

  mode: 'text',

  plateShape: 'rounded',
  plateMargin: 5,
  plateThickness: 3,
  plateRadius: 3,

  keyring: false,
  holeShape: 'circle',
  holeDiameter: 4,
  holePosition: 'left',
  holeMargin: 2.5,

  debossDepth: 1,

  graphics: [],

  partOffsets: {},
  holeOffset: { x: 0, y: 0 },

  textColor: '#4da3ff',
  plateColor: '#c9d2dd',

  curveSegments: 12,
};

type Listener = (params: ModelParams) => void;

/**
 * Phần trạng thái mà hoàn tác quản lý: đúng những gì người dùng chỉnh bằng tay.
 *
 * Cố ý **không** gồm các tham số như font hay cỡ chữ. Những thứ đó đã có ô nhập
 * ngay trước mắt để sửa lại, còn một cú kéo lỡ tay thì không có cách nào lấy lại
 * ngoài hoàn tác. Gộp cả hai vào một chồng lịch sử sẽ khiến Ctrl+Z lúc thì lùi
 * vị trí chữ, lúc thì lùi cỡ chữ — không đoán trước được.
 */
interface ManualState {
  partOffsets: Record<string, PartOffset>;
  holeOffset: { x: number; y: number };
}

/** Giới hạn chiều sâu hoàn tác, đủ dài cho mọi phiên chỉnh tay thực tế. */
const HISTORY_LIMIT = 200;

/** Kho tham số đơn giản, phát sự kiện mỗi khi có thay đổi. */
export class Store {
  private params: ModelParams;
  private listeners = new Set<Listener>();
  private past: ManualState[] = [];
  private future: ManualState[] = [];

  constructor(initial: ModelParams = DEFAULT_PARAMS) {
    this.params = { ...initial };
  }

  get(): Readonly<ModelParams> {
    return this.params;
  }

  set<K extends keyof ModelParams>(key: K, value: ModelParams[K]): void {
    if (this.params[key] === value) return;
    this.params = { ...this.params, [key]: value };
    this.emit();
  }

  /** Thêm một hình chèn vào cuối danh sách. */
  addGraphic(graphic: GraphicRef): void {
    this.params = { ...this.params, graphics: [...this.params.graphics, graphic] };
    this.emit();
  }

  /** Bỏ một hình chèn, kèm mọi dịch chuyển tay đã ghi cho hình đó. */
  removeGraphic(id: string): void {
    const partOffsets = Object.fromEntries(
      Object.entries(this.params.partOffsets).filter(([, o]) => o.token !== id),
    );
    this.params = {
      ...this.params,
      graphics: this.params.graphics.filter((g) => g.id !== id),
      partOffsets,
    };
    this.emit();
  }

  /** Đổi chiều cao một hình chèn. */
  setGraphicHeight(id: string, height: number): void {
    this.params = {
      ...this.params,
      graphics: this.params.graphics.map((g) => (g.id === id ? { ...g, height } : g)),
    };
    this.emit();
  }

  /** Buộc phát sự kiện dựng lại — dùng khi có font mới được nạp. */
  touch(): void {
    this.emit();
  }

  /**
   * Cộng thêm một đoạn dịch chuyển vào các nét chữ vừa được kéo.
   *
   * Nhận cả cụm chứ không từng nét một, vì kéo một cụm phải là **một** thao tác:
   * gọi nhiều lần thì mỗi lần lại phát sự kiện dựng lại, và nếu người dùng hoàn
   * tác thì cũng phải lùi từng nét một.
   */
  moveParts(items: Array<{ id: string; token: string }>, dx: number, dy: number): void {
    if (items.length === 0) return;
    this.remember();

    const partOffsets = { ...this.params.partOffsets };
    for (const { id, token } of items) {
      const current = partOffsets[id];
      // Chỉ cộng dồn khi vẫn đúng nguồn cũ; nội dung đã đổi thì coi như làm lại.
      const base = current && current.token === token ? current : { dx: 0, dy: 0, token };
      partOffsets[id] = { dx: round(base.dx + dx), dy: round(base.dy + dy), token };
    }

    this.params = { ...this.params, partOffsets };
    this.emit();
  }

  /** Cộng thêm một đoạn dịch chuyển vào lỗ móc khóa đang được kéo. */
  moveHole(dx: number, dy: number): void {
    this.remember();
    const { x, y } = this.params.holeOffset;
    this.params = { ...this.params, holeOffset: { x: round(x + dx), y: round(y + dy) } };
    this.emit();
  }

  /** Bỏ hết chỉnh tay, đưa model về đúng những gì các tham số quy định. */
  resetManual(): void {
    if (!this.hasManualEdits()) return;
    this.remember();
    this.params = { ...this.params, partOffsets: {}, holeOffset: { x: 0, y: 0 } };
    this.emit();
  }

  /** Lùi lại một thao tác chỉnh tay. Trả về false khi không còn gì để lùi. */
  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;

    this.future.push(this.snapshot());
    this.applyManual(previous);
    return true;
  }

  /** Làm lại thao tác vừa lùi. Trả về false khi không còn gì để làm lại. */
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;

    this.past.push(this.snapshot());
    this.applyManual(next);
    return true;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Đã có chỉnh tay nào chưa — dùng để bật/tắt nút đặt lại. */
  hasManualEdits(): boolean {
    return (
      Object.keys(this.params.partOffsets).length > 0 || !isZero(this.params.holeOffset)
    );
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Ghi lại trạng thái hiện tại trước khi đổi.
   *
   * Mọi thao tác chỉnh tay mới đều xoá nhánh "làm lại": một khi người dùng đã
   * lùi về rồi kéo sang hướng khác thì cái vừa bỏ đi không còn đường quay lại
   * nữa — đây là cách hoàn tác của mọi phần mềm khác cũng làm.
   */
  private remember(): void {
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  private snapshot(): ManualState {
    return {
      partOffsets: { ...this.params.partOffsets },
      holeOffset: { ...this.params.holeOffset },
    };
  }

  private applyManual(state: ManualState): void {
    this.params = {
      ...this.params,
      partOffsets: state.partOffsets,
      holeOffset: state.holeOffset,
    };
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.params);
  }
}

/** Làm tròn tới 0.05 mm — mịn hơn mọi máy in, mà tránh được số lẻ vô nghĩa. */
function round(value: number): number {
  return Math.round(value * 20) / 20;
}

function isZero(offset: { x: number; y: number }): boolean {
  return offset.x === 0 && offset.y === 0;
}
