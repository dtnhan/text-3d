/**
 * Nạp và quản lý font. Hỗ trợ hai nguồn:
 *  - font đóng gói sẵn trong `public/fonts/` (khai báo ở `fonts.json`)
 *  - font người dùng tự nạp từ máy (.ttf/.otf) — chỉ nằm trong bộ nhớ trình
 *    duyệt, không gửi đi đâu cả
 */

import { parse } from 'opentype.js';
import type { Font } from 'opentype.js';
import { measureCapHeight } from './metrics';

export interface LoadedFont {
  id: string;
  label: string;
  font: Font;
  /** Chiều cao chữ hoa tính theo đơn vị em — cơ sở quy đổi ra milimét. */
  capHeightEm: number;
  source: 'bundled' | 'user';
}

interface FontManifestEntry {
  id: string;
  label: string;
  file: string;
}

export class FontManager {
  private fonts = new Map<string, LoadedFont>();

  list(): LoadedFont[] {
    return [...this.fonts.values()];
  }

  get(id: string): LoadedFont | undefined {
    return this.fonts.get(id);
  }

  /**
   * Nạp danh sách font đóng gói sẵn. Font nào lỗi thì bỏ qua và ghi cảnh báo,
   * để một file hỏng không làm chết cả ứng dụng.
   */
  async loadBundled(manifestUrl: string): Promise<LoadedFont[]> {
    let manifest: FontManifestEntry[];
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      console.warn('[fonts] Không đọc được danh sách font đóng gói sẵn:', err);
      return [];
    }

    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    const loaded: LoadedFont[] = [];

    await Promise.all(
      manifest.map(async (entry) => {
        try {
          const res = await fetch(base + entry.file);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const font = parse(await res.arrayBuffer());
          const record: LoadedFont = {
            id: entry.id,
            label: entry.label,
            font,
            capHeightEm: measureCapHeight(font),
            source: 'bundled',
          };
          this.fonts.set(record.id, record);
          loaded.push(record);
        } catch (err) {
          console.warn(`[fonts] Bỏ qua font "${entry.label}":`, err);
        }
      }),
    );

    // Promise.all chạy song song nên thứ tự hoàn tất không ổn định — sắp lại
    // theo đúng thứ tự khai báo trong manifest cho khỏi nhảy lung tung.
    const order = new Map(manifest.map((e, i) => [e.id, i]));
    loaded.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return loaded;
  }

  /** Nạp font từ file người dùng chọn. Ném lỗi nếu file không phải font hợp lệ. */
  async loadFromFile(file: File): Promise<LoadedFont> {
    const buffer = await file.arrayBuffer();
    let font: Font;
    try {
      font = parse(buffer);
    } catch (err) {
      throw new Error(
        `Không đọc được "${file.name}". Hãy chọn file .ttf hoặc .otf hợp lệ. (${
          err instanceof Error ? err.message : err
        })`,
      );
    }

    const record: LoadedFont = {
      id: `user:${file.name}`,
      label: fontDisplayName(font) ?? file.name.replace(/\.[^.]+$/, ''),
      font,
      capHeightEm: measureCapHeight(font),
      source: 'user',
    };
    this.fonts.set(record.id, record);
    return record;
  }
}

/** Đọc tên hiển thị của font từ bảng name, ưu tiên tiếng Anh. */
function fontDisplayName(font: Font): string | null {
  // Bảng name của opentype khai kiểu chặt hơn thực tế: ngoài các trường chuẩn
  // nó còn chứa nhiều trường tuỳ font, nên đọc qua kiểu bản ghi tổng quát.
  const names = font.names as unknown as Record<string, Record<string, string> | undefined>;
  const full = names?.fullName ?? names?.fontFamily;
  if (!full) return null;
  return full.en ?? Object.values(full)[0] ?? null;
}
