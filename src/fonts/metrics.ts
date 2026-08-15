/**
 * Các phép đo trên đối tượng font đã nạp.
 *
 * Module này cố ý chỉ nhập **kiểu** từ opentype.js chứ không nhập hàm, nhờ vậy
 * cả phần dựng hình lẫn các script kiểm thử chạy ngoài trình duyệt đều dùng
 * được mà không kéo theo bộ phân tích font.
 */

import type { Font } from 'opentype.js';

/** Tỉ lệ chiều cao chữ hoa dự phòng khi không đọc được từ font. */
const FALLBACK_CAP_HEIGHT = 0.7;

/**
 * Khoảng hợp lý của chiều cao chữ hoa, tính theo đơn vị em.
 *
 * Không phải font nào khai `sCapHeight` cũng khai đúng: Courgette chẳng hạn khai
 * 0.147 em, mà tin theo thì chuỗi chữ cao 20 mm sẽ bị phóng thành hơn một mét.
 * Số nằm ngoài khoảng này chắc chắn là sai, ta bỏ và tự đo lấy.
 */
const PLAUSIBLE_CAP_HEIGHT = { min: 0.45, max: 1.0 };

/**
 * Chiều cao chữ hoa theo đơn vị em — cơ sở để quy đổi ra milimét.
 *
 * Ưu tiên số liệu khai trong bảng OS/2, nhưng chỉ khi nó hợp lý; nếu font không
 * khai (khá phổ biến với font tự chế) hoặc khai bậy thì đo trực tiếp chữ "H".
 */
export function measureCapHeight(font: Font): number {
  const unitsPerEm = font.unitsPerEm || 1000;

  const declared = font.tables?.os2?.sCapHeight;
  if (typeof declared === 'number' && isPlausible(declared / unitsPerEm)) {
    return declared / unitsPerEm;
  }

  try {
    const glyph = font.charToGlyph('H');
    if (glyph && glyph.index !== 0) {
      const measured = glyph.getBoundingBox().y2 / unitsPerEm;
      if (isPlausible(measured)) return measured;
    }
  } catch {
    // rơi xuống giá trị dự phòng bên dưới
  }

  return FALLBACK_CAP_HEIGHT;
}

function isPlausible(capHeightEm: number): boolean {
  return (
    Number.isFinite(capHeightEm) &&
    capHeightEm >= PLAUSIBLE_CAP_HEIGHT.min &&
    capHeightEm <= PLAUSIBLE_CAP_HEIGHT.max
  );
}

/**
 * Tìm những ký tự mà font không có glyph tương ứng — thường gặp khi dùng font
 * ngoại không kèm bộ dấu tiếng Việt.
 */
export function findMissingChars(font: Font, text: string): string[] {
  const missing = new Set<string>();
  for (const ch of text) {
    if (ch === '\n' || ch === ' ') continue;
    const glyph = font.charToGlyph(ch);
    // Chỉ số 0 là glyph .notdef — nghĩa là font không có ký tự này.
    if (!glyph || glyph.index === 0) missing.add(ch);
  }
  return [...missing];
}
