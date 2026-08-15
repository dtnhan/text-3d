/**
 * Điểm khởi động: nạp font, dựng khung xem 3D, và nối kho tham số vào vòng lặp
 * dựng lại model.
 */

import * as THREE from 'three';
import { DEFAULT_PARAMS, Store, type ModelParams } from './state';
import { FontManager } from './fonts/fontManager';
import { GraphicStore } from './graphics/graphicStore';
import { buildModel, mergePieces, EmptyTextError, type BuildResult } from './geometry/build';
import { validate, type Issue } from './validate';
import { Viewer } from './viewer/scene';
import { bindPanel, setFontOptions } from './ui/panel';
import { download, exportGeometry, suggestFilename, type ExportFormat } from './export/exporters';

/** Chờ người dùng ngừng gõ bấy nhiêu mili giây rồi mới dựng lại. */
const REBUILD_DELAY_MS = 160;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const issuesEl = document.getElementById('issues') as HTMLElement;

const viewer = new Viewer(canvas, {
  // Kéo thả chỉ báo lên phần dịch chuyển; kho tham số ghi lại rồi phát sự kiện
  // dựng lại như mọi thay đổi khác, nên không có đường đi riêng cho chỉnh tay.
  //
  // Nhưng phải dựng lại **ngay**, không qua nhịp chờ gõ phím: khung xem giữ
  // nguyên mesh ở chỗ vừa thả cho tới khi có model mới thay vào, nên chờ thêm
  // một nhịp là người dùng thấy chữ đứng sai chỗ trong chừng ấy thời gian.
  onMoveParts: (parts, dx, dy) => {
    store.moveParts(parts, dx, dy);
    rebuildNow();
  },
  onMoveHole: (dx, dy) => {
    store.moveHole(dx, dy);
    rebuildNow();
  },
  onSelectionChange: showSelection,
});
const fonts = new FontManager();
const graphics = new GraphicStore();
const store = new Store(DEFAULT_PARAMS);

/** Kết quả dựng gần nhất — dùng cho việc xuất file. */
let current: BuildResult | null = null;
/** Bộ tham số đã dựng gần nhất, để nhận ra lần này chỉ đổi mỗi màu. */
let lastBuilt: ModelParams | null = null;
let rebuildTimer: number | undefined;
/** Đã canh khung hình lần đầu chưa. */
let framed = false;

void start();

async function start(): Promise<void> {
  const loaded = await fonts.loadBundled('fonts/fonts.json');

  if (loaded.length === 0) {
    showIssues([
      {
        level: 'error',
        message:
          'Không nạp được font nào đóng gói sẵn. Hãy dùng ô "Font riêng" để chọn một file .ttf hoặc .otf từ máy.',
      },
    ]);
  } else {
    store.set('fontId', loaded[0].id);
  }

  refreshFontOptions();
  bindPanel(store);
  bindFontUpload();
  bindGraphicUpload();
  bindExportButtons();
  bindShortcuts();

  store.subscribe(scheduleRebuild);
  rebuild(store.get());
}

// ---------------------------------------------------------------------------
// Vòng lặp dựng lại
// ---------------------------------------------------------------------------

/** Những tham số chỉ đổi cách hiển thị, không đụng tới hình học. */
const DISPLAY_ONLY_KEYS: ReadonlyArray<keyof ModelParams> = ['textColor', 'plateColor'];

function scheduleRebuild(params: Readonly<ModelParams>): void {
  // Đổi màu thì chỉ cần sửa vật liệu. Dựng lại cả hình học sẽ tốn hàng chục
  // mili giây cho mỗi bước rê của bảng chọn màu, mà chẳng ra hình gì khác.
  if (lastBuilt && onlyDisplayChanged(lastBuilt, params)) {
    lastBuilt = params as ModelParams;
    viewer.setColors(params.textColor, params.plateColor);
    return;
  }

  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => rebuild(params), REBUILD_DELAY_MS);
}

/**
 * Hai bộ tham số có chỉ khác nhau ở phần hiển thị không?
 *
 * So sánh nông là đủ: kho tham số luôn thay cả object khi có gì đổi, nên những
 * trường là object (như `partOffsets`) mà còn giữ nguyên tham chiếu thì chắc
 * chắn chưa bị động tới.
 */
function onlyDisplayChanged(a: ModelParams, b: Readonly<ModelParams>): boolean {
  return (Object.keys(a) as Array<keyof ModelParams>).every(
    (key) => DISPLAY_ONLY_KEYS.includes(key) || a[key] === b[key],
  );
}

/** Dựng lại tức thì, bỏ qua nhịp chờ — dùng cho thao tác kéo thả. */
function rebuildNow(): void {
  window.clearTimeout(rebuildTimer);
  rebuild(store.get());
}

function rebuild(params: Readonly<ModelParams>): void {
  const font = fonts.get(params.fontId);
  if (!font) {
    viewer.setPieces([]);
    viewer.setHoleHandle(null, 0, 0);
    current = null;
    showIssues([{ level: 'error', message: 'Chưa chọn được font. Hãy chọn font ở ô phía trên.' }]);
    return;
  }

  try {
    const result = buildModel(font, params as ModelParams, graphics);
    current = result;
    lastBuilt = params as ModelParams;
    viewer.setColors(params.textColor, params.plateColor);
    viewer.setPieces(result.pieces);
    viewer.setHoleHandle(result.holeCenter, result.size.z, params.holeDiameter);

    if (!framed) {
      viewer.frameModel();
      framed = true;
    }

    showIssues(validate(result, params as ModelParams, font.font));
  } catch (err) {
    viewer.setPieces([]);
    viewer.setHoleHandle(null, 0, 0);
    current = null;
    lastBuilt = null;

    if (err instanceof EmptyTextError) {
      showIssues([{ level: 'info', message: 'Nhập chữ vào ô "Chữ" để bắt đầu.' }]);
    } else {
      console.error('[build] Dựng model thất bại:', err);
      showIssues([
        {
          level: 'error',
          message: `Không dựng được model: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    }
  }

  updateExportButtons();
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

function refreshFontOptions(): void {
  setFontOptions(
    fonts.list().map((f) => ({
      id: f.id,
      label: f.source === 'user' ? `${f.label} (font riêng)` : f.label,
    })),
    store.get().fontId,
  );
}

function bindFontUpload(): void {
  const input = document.getElementById('fontFile') as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      const loaded = await fonts.loadFromFile(file);
      refreshFontOptions();
      store.set('fontId', loaded.id);
      // Nếu font mới trùng id với font đang chọn thì store.set không phát sự
      // kiện, nên phải chủ động yêu cầu dựng lại.
      store.touch();
    } catch (err) {
      showIssues([
        { level: 'error', message: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      // Xoá lựa chọn để chọn lại đúng file đó vẫn kích hoạt sự kiện change.
      input.value = '';
    }
  });
}

/**
 * Nạp hình chèn. Hình đã phân tích nằm ở `GraphicStore`, còn kho tham số chỉ giữ
 * mã và chiều cao — cùng lối với font.
 */
function bindGraphicUpload(): void {
  const input = document.getElementById('graphicFile') as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      const loaded = await graphics.loadFile(file);
      // Mặc định cao ngang chữ, để hình đứng cạnh chữ trông cân.
      store.addGraphic({ id: loaded.id, name: loaded.name, height: store.get().capHeight });
      renderGraphicList();
      rebuildNow();

      if (loaded.strokeCount > 0) {
        showIssues([
          {
            level: 'info',
            message: `Hình này vẽ bằng nét chứ không tô đặc; ${loaded.strokeCount} nét đã được nới thành khối in được.`,
          },
        ]);
      }
    } catch (err) {
      showIssues([{ level: 'error', message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      // Xoá lựa chọn để chọn lại đúng file đó vẫn kích hoạt sự kiện change.
      input.value = '';
    }
  });
}

/** Vẽ lại danh sách hình chèn, mỗi hình một dòng có ô chiều cao và nút bỏ. */
function renderGraphicList(): void {
  const list = document.getElementById('graphicList') as HTMLElement;

  list.replaceChildren(
    ...store.get().graphics.map((ref) => {
      const row = document.createElement('div');
      row.className = 'asset';

      const name = document.createElement('span');
      name.className = 'asset__name';
      name.textContent = ref.name;
      name.title = ref.name;

      const height = document.createElement('input');
      height.type = 'number';
      height.step = '1';
      height.min = '1';
      height.max = '300';
      height.value = String(ref.height);
      height.title = 'Chiều cao hình (mm)';
      height.addEventListener('input', () => {
        const value = Number.parseFloat(height.value);
        if (Number.isFinite(value) && value > 0) store.setGraphicHeight(ref.id, value);
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'asset__remove';
      remove.textContent = '×';
      remove.title = 'Bỏ hình này';
      remove.addEventListener('click', () => {
        graphics.remove(ref.id);
        store.removeGraphic(ref.id);
        renderGraphicList();
        rebuildNow();
      });

      row.append(name, height, remove);
      return row;
    }),
  );
}

function bindExportButtons(): void {
  const save = (format: ExportFormat) => () => {
    if (!current) return;
    const blob = exportGeometry(mergePieces(current.pieces), format);
    download(blob, suggestFilename(store.get().text, format));
  };

  document.getElementById('exportStl')!.addEventListener('click', save('stl'));
  document.getElementById('exportObj')!.addEventListener('click', save('obj'));
  document.getElementById('frame')!.addEventListener('click', () => viewer.frameModel());
  document.getElementById('resetManual')!.addEventListener('click', () => {
    viewer.clearSelection();
    store.resetManual();
    rebuildNow();
  });
  document.getElementById('undo')!.addEventListener('click', () => {
    if (store.undo()) rebuildNow();
  });
  document.getElementById('redo')!.addEventListener('click', () => {
    if (store.redo()) rebuildNow();
  });
}

/**
 * Phím tắt hoàn tác. Chỉ quản phần chỉnh tay bằng kéo thả — xem `ManualState`
 * trong state.ts giải thích vì sao không gom cả các tham số khác vào.
 */
function bindShortcuts(): void {
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    // Đang gõ trong ô nhập thì để trình duyệt tự lo hoàn tác chữ trong ô đó.
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;

    // Ctrl+Y là lối làm lại quen thuộc trên Windows, nhận luôn cho tiện.
    const redo = key === 'y' || event.shiftKey;
    if (redo ? store.redo() : store.undo()) rebuildNow();
    event.preventDefault();
  });
}

/** Hiện số nét đang chọn, để người dùng biết cú kéo tới sẽ tác động lên bao nhiêu. */
function showSelection(count: number): void {
  const el = document.getElementById('selectionInfo') as HTMLElement;
  el.textContent =
    count === 0
      ? ''
      : count === 1
        ? 'Đang chọn 1 nét — kéo để dời.'
        : `Đang chọn ${count} nét — kéo một nét bất kỳ để dời cả cụm.`;
}

function updateExportButtons(): void {
  const disabled = current === null;
  for (const id of ['exportStl', 'exportObj']) {
    (document.getElementById(id) as HTMLButtonElement).disabled = disabled;
  }
  (document.getElementById('resetManual') as HTMLButtonElement).disabled =
    !store.hasManualEdits();
  (document.getElementById('undo') as HTMLButtonElement).disabled = !store.canUndo();
  (document.getElementById('redo') as HTMLButtonElement).disabled = !store.canRedo();
}

function showIssues(issues: Issue[]): void {
  issuesEl.replaceChildren(
    ...issues.map((issue) => {
      const el = document.createElement('div');
      el.className = `issue issue--${issue.level}`;
      el.textContent = issue.message;
      return el;
    }),
  );
}

// Giúp gỡ lỗi từ console của trình duyệt.
Object.assign(window, { THREE, store, fonts, viewer, getResult: () => current });
