/**
 * Xuất model ra file tải về.
 *
 * STL nhị phân là định dạng chính vì mọi phần mềm cắt lớp đều đọc được và đơn
 * vị của nó chính là milimét — trùng với đơn vị ta dựng model, nên không cần
 * quy đổi gì thêm. OBJ đi kèm cho ai muốn mang sang phần mềm dựng hình.
 */

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

export type ExportFormat = 'stl' | 'obj';

/** Dựng nội dung file từ geometry, kèm phần mở rộng phù hợp. */
export function exportGeometry(
  geometry: THREE.BufferGeometry,
  format: ExportFormat,
): Blob {
  // Bộ xuất của Three.js làm việc trên Object3D chứ không phải geometry trần.
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld();

  if (format === 'stl') {
    const data = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView<ArrayBuffer>;
    // Bọc lại thành Uint8Array theo đúng đoạn dữ liệu của DataView — Blob không
    // nhận thẳng DataView, và view có thể chỉ là một phần của bộ đệm.
    const bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return new Blob([bytes], { type: 'model/stl' });
  }

  return new Blob([new OBJExporter().parse(mesh)], { type: 'model/obj' });
}

/** Đưa file cho trình duyệt tải về. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Thu hồi ngay sẽ làm hỏng lượt tải ở một số trình duyệt, nên chờ một nhịp.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Đặt tên file từ nội dung chữ, bỏ dấu và ký tự đặc biệt để tên file an toàn
 * trên mọi hệ điều hành.
 */
export function suggestFilename(text: string, format: ExportFormat): string {
  const slug = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // bỏ dấu thanh và dấu phụ
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return `${slug || 'text3d'}.${format}`;
}
