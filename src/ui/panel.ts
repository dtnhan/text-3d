/**
 * Nối các control trong index.html vào kho tham số.
 *
 * Mỗi control được khai báo một dòng trong bảng `BINDINGS` bên dưới: id của
 * phần tử, khoá tương ứng trong ModelParams, và cách đọc giá trị. Thêm tham số
 * mới chỉ cần thêm một dòng ở đây và một thẻ trong HTML.
 */

import type { ModelParams, Store } from '../state';

type Kind = 'number' | 'text' | 'select' | 'checkbox';

interface Binding {
  id: string;
  key: keyof ModelParams;
  kind: Kind;
}

const BINDINGS: Binding[] = [
  { id: 'text', key: 'text', kind: 'text' },
  { id: 'fontId', key: 'fontId', kind: 'select' },
  { id: 'align', key: 'align', kind: 'select' },
  { id: 'letterSpacing', key: 'letterSpacing', kind: 'number' },
  { id: 'lineHeight', key: 'lineHeight', kind: 'number' },

  { id: 'capHeight', key: 'capHeight', kind: 'number' },
  { id: 'textDepth', key: 'textDepth', kind: 'number' },
  { id: 'bevelEnabled', key: 'bevelEnabled', kind: 'checkbox' },
  { id: 'bevelSize', key: 'bevelSize', kind: 'number' },
  { id: 'textColor', key: 'textColor', kind: 'text' },

  { id: 'connectors', key: 'connectors', kind: 'checkbox' },
  { id: 'connectorWidth', key: 'connectorWidth', kind: 'number' },

  { id: 'mode', key: 'mode', kind: 'select' },

  { id: 'plateShape', key: 'plateShape', kind: 'select' },
  { id: 'plateMargin', key: 'plateMargin', kind: 'number' },
  { id: 'plateThickness', key: 'plateThickness', kind: 'number' },
  { id: 'plateRadius', key: 'plateRadius', kind: 'number' },
  { id: 'plateColor', key: 'plateColor', kind: 'text' },

  { id: 'holeShape', key: 'holeShape', kind: 'select' },
  { id: 'holeDiameter', key: 'holeDiameter', kind: 'number' },
  { id: 'holePosition', key: 'holePosition', kind: 'select' },
  { id: 'holeMargin', key: 'holeMargin', kind: 'number' },

  { id: 'debossDepth', key: 'debossDepth', kind: 'number' },
  { id: 'curveSegments', key: 'curveSegments', kind: 'number' },
];

export function bindPanel(store: Store): void {
  for (const binding of BINDINGS) {
    const el = document.getElementById(binding.id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) {
      console.warn(`[ui] Không tìm thấy control #${binding.id}`);
      continue;
    }

    writeToControl(el, binding, store.get()[binding.key]);

    // Ô nhập chữ và ô số cập nhật theo từng phím gõ để xem trước tức thì; ô chọn
    // và hộp kiểm chỉ phát khi giá trị đổi.
    const event = binding.kind === 'select' || binding.kind === 'checkbox' ? 'change' : 'input';
    el.addEventListener(event, () => {
      const value = readFromControl(el, binding);
      if (value !== null) store.set(binding.key, value as never);
    });
  }

  // Ẩn/hiện các nhóm không liên quan tới chế độ đang chọn.
  const applyVisibility = (params: Readonly<ModelParams>) => {
    const usesPlate = params.mode !== 'text';
    toggle('[data-when="plate"]', usesPlate);
    toggle('[data-when="keychain"]', params.mode === 'keychain');
    toggle('[data-when="deboss"]', params.mode === 'deboss');
    toggle('[data-when="rounded"]', usesPlate && params.plateShape === 'rounded');
    toggle('[data-when="bevel"]', params.bevelEnabled);
    // Thanh nối chỉ có nghĩa ở chế độ chữ nổi — các chế độ khác đã có đế giữ.
    toggle('[data-when="textmode"]', !usesPlate);
    toggle('[data-when="connectors"]', !usesPlate && params.connectors);
  };

  applyVisibility(store.get());
  store.subscribe(applyVisibility);
}

/** Nạp lại danh sách font vào ô chọn, giữ nguyên lựa chọn hiện tại nếu còn. */
export function setFontOptions(
  options: Array<{ id: string; label: string }>,
  selected: string,
): void {
  const select = document.getElementById('fontId') as HTMLSelectElement | null;
  if (!select) return;

  select.innerHTML = '';
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.label;
    select.append(el);
  }
  select.value = selected;
}

function toggle(selector: string, visible: boolean): void {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    el.hidden = !visible;
  }
}

function writeToControl(
  el: HTMLInputElement | HTMLSelectElement,
  binding: Binding,
  value: ModelParams[keyof ModelParams],
): void {
  if (binding.kind === 'checkbox') {
    (el as HTMLInputElement).checked = Boolean(value);
  } else {
    el.value = String(value);
  }
}

/** Đọc giá trị từ control; trả về null nếu đang nhập dở một số chưa hợp lệ. */
function readFromControl(
  el: HTMLInputElement | HTMLSelectElement,
  binding: Binding,
): ModelParams[keyof ModelParams] | null {
  switch (binding.kind) {
    case 'checkbox':
      return (el as HTMLInputElement).checked;

    case 'number': {
      const value = Number.parseFloat(el.value);
      if (!Number.isFinite(value)) return null;
      return clampToControl(el as HTMLInputElement, value);
    }

    default:
      return el.value;
  }
}

/**
 * Giới hạn giá trị theo min/max khai trong HTML. Trình duyệt không tự chặn khi
 * người dùng gõ tay, mà một số giá trị (độ dày âm, cỡ chữ 0) sẽ làm hỏng bước
 * dựng hình, nên phải kẹp lại ở đây.
 */
function clampToControl(el: HTMLInputElement, value: number): number {
  const min = Number.parseFloat(el.min);
  const max = Number.parseFloat(el.max);
  let result = value;
  if (Number.isFinite(min)) result = Math.max(result, min);
  if (Number.isFinite(max)) result = Math.min(result, max);
  return result;
}
