/**
 * Kiểm tra pipeline dựng hình ngoài trình duyệt: `npm run check`
 *
 * Chạy đủ bốn chế độ dựng trên toàn bộ font đóng gói sẵn, rồi kiểm ba điều mà
 * mắt thường nhìn preview không phát hiện được:
 *
 *  1. **Lưới kín** — mỗi cạnh phải được đúng hai tam giác dùng chung. Đây chính
 *     là điều phần mềm cắt lớp đòi hỏi; lưới hở sẽ bị báo "non-manifold".
 *  2. **Đúng kích thước** — chữ cao đúng số milimét người dùng đặt, và độ dày
 *     tổng khớp với chế độ đang dựng.
 *  3. **Xuất file được** — STL nhị phân có số tam giác khớp với geometry.
 *
 * Script được Vite đóng gói rồi mới chạy bằng Node (xem script `check` trong
 * package.json), nhờ vậy nó dùng đúng cơ chế phân giải module như bản chạy
 * trong trình duyệt.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import * as THREE from 'three';
import { parse } from 'opentype.js';
import { measureCapHeight } from '../src/fonts/metrics';
import { buildModel, mergePieces } from '../src/geometry/build';
import { validate, countIslands } from '../src/validate';
import { exportGeometry } from '../src/export/exporters';
import {
  DEFAULT_PARAMS,
  Store,
  type BuildMode,
  type HoleShape,
  type ModelParams,
  type PlateShape,
} from '../src/state';
import { holeOutline } from '../src/geometry/holeShapes';
import { TextPath } from '../src/geometry/textPath';
import { estimateMinStroke } from '../src/validate';
import type { TextShape } from '../src/state';
import { GraphicStore } from '../src/graphics/graphicStore';
import { traceBitmap } from '../src/graphics/traceBitmap';
import { checkMesh } from './meshCheck';
import { Selection } from '../src/viewer/interaction';
import { connectDiacritics } from '../src/geometry/connectors';
import { findIslands } from '../src/geometry/islands';

// SVGLoader phân tích file bằng DOMParser của trình duyệt, mà Node không có. Vá
// bằng một DOM tối giản. Hai chỗ nó đòi hơn thế:
//
//  - `.style`: mọi chỗ đụng tới đều có kiểm tra trước rồi lui về đọc thuộc tính,
//    nên không cần làm gì.
//  - `querySelectorAll`: chỉ dùng để gom các thẻ gradient, mà gradient thì không
//    ảnh hưởng hình học. Dựng tạm một bản chỉ hiểu bộ chọn theo tên thẻ.
{
  const probe = new DOMParser().parseFromString('<svg><g/></svg>', 'image/svg+xml');
  const prototypes = [Object.getPrototypeOf(probe), Object.getPrototypeOf(probe.documentElement)];

  for (const proto of prototypes) {
    if (proto.querySelectorAll) continue;
    proto.querySelectorAll = function (selector: string) {
      const found: unknown[] = [];
      for (const name of selector.split(',')) {
        const list = this.getElementsByTagName(name.trim());
        for (let i = 0; i < list.length; i++) found.push(list[i]);
      }
      return found;
    };
  }
}

Object.assign(globalThis, { DOMParser });

const FONT_DIR = new URL('../public/fonts/', import.meta.url);
const OUT_DIR = new URL('../.check-output/', import.meta.url);

const SAMPLE = 'Đà Nẵng';
const CAP_HEIGHT = 20;
/** Sai số cho phép khi đối chiếu kích thước (mm). */
const TOLERANCE = 0.05;

let failures = 0;

function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`   ${ok ? '  ok' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Số tam giác ghi trong phần đầu file STL nhị phân. */
function stlTriangleCount(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
}

/**
 * Thể tích của lưới kín, theo tổng thể tích các tứ diện dựng từ gốc toạ độ.
 *
 * Model của ta gồm nhiều vỏ chồng nhau nên phần giao bị tính hai lần — không
 * sao, vì ở đây ta chỉ dùng con số này để **so sánh** giữa hai bộ tham số chỉ
 * khác nhau một chút, mà phần giao đó thì không đổi.
 */
function volume(geometry: THREE.BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  let total = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < pos.count / 3; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    total += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(total);
}

/**
 * Số lần một tia thẳng đứng tại (x, y) đâm qua bề mặt model.
 *
 * 0 nghĩa là chỗ đó thông suốt từ trên xuống dưới — đúng cái ta cần chứng minh
 * cho lỗ móc khóa. 2 nghĩa là tia vào rồi ra, tức chỗ đó có vật liệu đặc.
 */
function countHits(geometry: THREE.BufferGeometry, x: number, y: number): number {
  const pos = geometry.getAttribute('position');
  const ray = new THREE.Ray(new THREE.Vector3(x, y, -1000), new THREE.Vector3(0, 0, 1));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const hit = new THREE.Vector3();

  let hits = 0;
  for (let t = 0; t < pos.count / 3; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    // Nhận cả hai chiều mặt, vì ta chỉ đếm số lần cắt chứ không quan tâm hướng.
    if (ray.intersectTriangle(a, b, c, false, hit)) hits++;
  }
  return hits;
}

/** Chiều dày mong đợi của model theo từng chế độ. */
function expectedHeight(params: ModelParams): number {
  switch (params.mode) {
    case 'text':
      return params.textDepth;
    case 'plate':
    case 'keychain':
      return params.plateThickness + params.textDepth;
    case 'deboss':
      return params.plateThickness;
  }
}

const MODES: BuildMode[] = ['text', 'plate', 'keychain', 'deboss'];

/** Font dùng cho các phép kiểm so sánh ở cuối, gán khi duyệt qua font đầu tiên. */
let reference: Parameters<typeof buildModel>[0];

mkdirSync(OUT_DIR, { recursive: true });

const fontFiles = readdirSync(FONT_DIR).filter((f) => /\.(ttf|otf)$/i.test(f));
if (fontFiles.length === 0) throw new Error('Không tìm thấy font nào trong public/fonts/');

for (const file of fontFiles) {
  const font = parse(readFileSync(new URL(file, FONT_DIR)).buffer as ArrayBuffer);
  const loaded = {
    id: file,
    label: file,
    font,
    capHeightEm: measureCapHeight(font),
    source: 'bundled' as const,
  };

  reference ??= loaded;
  console.log(`\n${file}`);

  for (const mode of MODES) {
    const params: ModelParams = {
      ...DEFAULT_PARAMS,
      text: SAMPLE,
      mode,
      capHeight: CAP_HEIGHT,
      // Bật vát cạnh ở chế độ chữ nổi để đường dựng có vát cũng được kiểm.
      bevelEnabled: mode === 'text',
    };

    const result = buildModel(loaded, params);
    const { size } = result;
    const geometry = mergePieces(result.pieces);
    const mesh = checkMesh(geometry);
    const triangles = mesh.triangles;

    console.log(
      `  [${mode}] ${triangles} tam giác, ${fmt(size)} mm` +
        (mesh.tJunctions > 0 ? `, ${mesh.tJunctions} điểm chữ T (vô hại)` : ''),
    );

    check(mesh.openEdges === 0, 'lưới kín', `${mesh.openEdges} cạnh thủng`);

    check(
      Math.abs(size.z - expectedHeight(params)) < TOLERANCE,
      'độ dày đúng',
      `${size.z.toFixed(2)} mm, mong đợi ${expectedHeight(params).toFixed(2)} mm`,
    );

    // Model phải nằm trên mặt bàn, không lún xuống dưới.
    geometry.computeBoundingBox();
    check(Math.abs(geometry.boundingBox!.min.z) < 1e-6, 'đáy nằm tại Z = 0');

    // Ở chế độ chữ nổi, chiều cao chữ hoa phải khớp con số người dùng đặt. Chữ
    // "Đ" và "N" trong mẫu đều là chữ hoa không dấu, còn "à"/"ẵ" có dấu vươn
    // cao hơn, nên hộp bao chỉ có thể cao hơn chứ không được thấp hơn.
    if (mode === 'text') {
      check(size.y >= CAP_HEIGHT - TOLERANCE, 'chữ hoa đạt chiều cao đặt trước', `Y = ${size.y.toFixed(2)} mm`);
    }

    const blob = exportGeometry(geometry, 'stl');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    check(
      stlTriangleCount(bytes) === triangles,
      'STL khớp số tam giác',
      `${stlTriangleCount(bytes)} / ${triangles}`,
    );

    writeFileSync(new URL(`${file}.${mode}.stl`, OUT_DIR), bytes);

    // Chế độ chữ nổi với chuỗi tiếng Việt bắt buộc phải cảnh báo mảnh rời.
    if (mode === 'text') {
      const issues = validate(result, params, font);
      check(
        issues.some((i) => i.level === 'warning' && i.message.includes('mảnh rời')),
        'có cảnh báo mảnh rời cho chữ tiếng Việt',
      );
    }
  }

  // --- Thanh nối giữ dấu ---
  //
  // Thanh nối chỉ gắn dấu vào chính chữ mang nó, mỗi dấu đúng một thanh, và **cố
  // ý không** nối các chữ rời với nhau: nối hết thành khối liền thì phải thêm
  // những thanh dài chạy ngang giữa các chữ, làm hỏng hẳn mặt chữ.
  //
  // Phép kiểm nói theo cấu trúc chứ không theo con số: font nào vẽ dấu dính sẵn
  // vào thân chữ thì số nét khác hẳn font vẽ rời, mà cả hai đều đúng.
  {
    const base: ModelParams = {
      ...DEFAULT_PARAMS,
      text: SAMPLE,
      capHeight: CAP_HEIGHT,
      mode: 'text',
    };
    const joinedParams: ModelParams = { ...base, connectors: true, connectorWidth: 2 };

    const loose = buildModel(loaded, base);
    const joined = buildModel(loaded, joinedParams);

    /** Có ký tự nào bị tách ra nằm ở nhiều mảnh khác nhau không? */
    const splitGlyphs = (result: typeof loose): number => {
      const islands = findIslands(result.parts);
      const islandOf = new Map<number, number>();
      islands.forEach((island, index) => {
        for (const i of island.indices) islandOf.set(i, index);
      });

      const byGlyph = new Map<string, Set<number>>();
      result.layout.pieces.forEach((piece, i) => {
        if (!piece.id.startsWith('L')) return;
        const key = piece.id.replace(/S\d+$/, '');
        const seen = byGlyph.get(key) ?? new Set<number>();
        seen.add(islandOf.get(i) ?? -1);
        byGlyph.set(key, seen);
      });

      return [...byGlyph.values()].filter((seen) => seen.size > 1).length;
    };

    const bars = connectDiacritics(loose.layout.pieces, 2);
    const glyphs = new Set(
      loose.layout.pieces.filter((p) => p.id.startsWith('L')).map((p) => p.id.replace(/S\d+$/, '')),
    ).size;
    const strokes = loose.layout.pieces.filter((p) => p.id.startsWith('L')).length;

    check(splitGlyphs(loose) > 0, 'font này vẽ dấu tách rời khỏi thân chữ', `${strokes} nét / ${glyphs} ký tự`);
    check(splitGlyphs(joined) === 0, 'nối xong mọi dấu đều dính vào chữ của nó');

    // Số thanh không vượt quá số dấu rời — cộng với mệnh đề trên thì đúng là mỗi
    // dấu một thanh, không hơn.
    check(
      bars.length > 0 && bars.length <= strokes - glyphs,
      'mỗi dấu đúng một thanh, không thừa',
      `${bars.length} thanh cho ${strokes - glyphs} dấu rời`,
    );

    check(checkMesh(mergePieces(joined.pieces)).openEdges === 0, 'lưới có thanh nối vẫn kín');

    // Các chữ vẫn rời nhau, và cảnh báo mảnh rời vẫn phải nói đúng điều đó.
    check(countIslands(joined.parts) > 1, 'các chữ rời vẫn để rời, không bị nối lại');
    check(
      validate(joined, joinedParams, font).some((i) => i.message.includes('mảnh rời')),
      'vẫn cảnh báo chữ rời sau khi nối dấu',
    );

    // Bề rộng thanh chỉnh được, và chỉnh thì thấy khác thật.
    const areaOf = (shapes: typeof bars) =>
      shapes.reduce((sum, shape) => {
        const pts = shape.getPoints(1);
        let a = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          a += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
        }
        return sum + Math.abs(a / 2);
      }, 0);
    const thick = connectDiacritics(loose.layout.pieces, 6);
    check(
      thick.length === bars.length && areaOf(thick) > areaOf(bars) * 2,
      'bề rộng thanh nối chỉnh được',
      `${areaOf(bars).toFixed(0)} → ${areaOf(thick).toFixed(0)} mm²`,
    );
  }

  // --- Đế bo sát chữ ---
  for (const mode of ['plate', 'keychain', 'deboss'] as BuildMode[]) {
    const params: ModelParams = {
      ...DEFAULT_PARAMS,
      text: SAMPLE,
      capHeight: CAP_HEIGHT,
      mode,
      plateShape: 'outline',
      plateMargin: 4,
    };
    const result = buildModel(loaded, params);
    const mesh = checkMesh(mergePieces(result.pieces));

    console.log(`  [đế bo sát · ${mode}] ${mesh.triangles} tam giác, ${fmt(result.size)} mm`);
    check(mesh.openEdges === 0, 'lưới kín', `${mesh.openEdges} cạnh thủng`);
    check(countIslands(result.parts) === 1, 'đế bo sát liền một mảnh');

    // Đế bo sát phải tốn ít vật liệu hơn hẳn đế chữ nhật cùng lề — đó chính là
    // ý nghĩa của "bo sát". Hộp bao thì gần như bằng nhau nên phải so thể tích.
    const boxed = buildModel(loaded, { ...params, plateShape: 'rect' });
    const hugging = volume(mergePieces(result.pieces));
    const rectangular = volume(mergePieces(boxed.pieces));
    check(
      hugging < rectangular * 0.8,
      'đế bo sát tốn ít vật liệu hơn đế chữ nhật',
      `${hugging.toFixed(0)} vs ${rectangular.toFixed(0)} mm³`,
    );
  }
}

/**
 * Kiểm bằng phép so sánh: đổi một tham số rồi xem thể tích có đổi đúng chiều
 * không. Đây là cách chứng minh lỗ treo và chỗ khắc chìm **thật sự được khoét**
 * — lưới kín thôi chưa nói lên điều đó.
 */
function compareVolume(
  label: string,
  base: Partial<ModelParams>,
  less: Partial<ModelParams>,
  more: Partial<ModelParams>,
): void {
  const build = (extra: Partial<ModelParams>) => {
    const params: ModelParams = { ...DEFAULT_PARAMS, text: SAMPLE, capHeight: CAP_HEIGHT, ...base, ...extra };
    return volume(mergePieces(buildModel(reference, params).pieces));
  };
  const vLess = build(less);
  const vMore = build(more);
  check(vMore > vLess, label, `${vLess.toFixed(0)} mm³ → ${vMore.toFixed(0)} mm³`);
}

function fmt(v: THREE.Vector3): string {
  return `${v.x.toFixed(1)} × ${v.y.toFixed(1)} × ${v.z.toFixed(1)}`;
}

console.log('\nKiểm phần chỉnh tay bằng kéo thả');

// --- Kéo từng nét chữ ---
{
  const base: ModelParams = {
    ...DEFAULT_PARAMS,
    text: 'Ô',
    capHeight: CAP_HEIGHT,
    mode: 'text',
  };
  const plain = buildModel(reference, base);

  // Chữ "Ô" cho ra đúng hai nét: thân chữ O và cái dấu mũ trên nó. Đây chính là
  // trường hợp người dùng hay muốn chỉnh nhất — nhích cái dấu cho cân.
  check(plain.pieces.length === 2, 'chữ "Ô" tách thành hai nét kéo được', `${plain.pieces.length} nét`);
  check(
    plain.pieces.every((p) => p.token === 'Ô'),
    'mọi nét đều mang ký tự sinh ra nó',
  );

  // Nét thứ hai là dấu mũ (nằm cao hơn). Kéo nó lên 5 mm và sang phải 3 mm.
  const hat = [...plain.pieces].sort(
    (a, b) => b.geometry.boundingBox!.max.y - a.geometry.boundingBox!.max.y,
  )[0];
  const before = hat.geometry.boundingBox!.clone();

  const moved = buildModel(reference, {
    ...base,
    partOffsets: { [hat.id]: { dx: 3, dy: 5, token: 'Ô' } },
  });
  const after = moved.pieces.find((p) => p.id === hat.id)!.geometry.boundingBox!;

  // Model được căn tâm lại sau khi dựng, nên vị trí tuyệt đối dịch đi ít hơn 3/5
  // mm. Cái phải đúng chính xác là **khoảng cách giữa hai nét**.
  const gapBefore = before.min.y - plain.pieces.find((p) => p.id !== hat.id)!.geometry.boundingBox!.min.y;
  const gapAfter = after.min.y - moved.pieces.find((p) => p.id !== hat.id)!.geometry.boundingBox!.min.y;

  check(
    Math.abs(gapAfter - gapBefore - 5) < TOLERANCE,
    'kéo nét chữ dời đúng khoảng cách đã kéo',
    `cách nhau ${gapBefore.toFixed(2)} → ${gapAfter.toFixed(2)} mm`,
  );
  check(
    checkMesh(mergePieces(moved.pieces)).openEdges === 0,
    'lưới sau khi kéo nét vẫn kín',
  );

  // Đổi nội dung thì dịch chuyển đã lưu phải bị bỏ qua, không áp nhầm sang chữ
  // khác đang đứng ở đúng vị trí đó.
  const other = buildModel(reference, {
    ...base,
    text: 'A',
    partOffsets: { [hat.id]: { dx: 3, dy: 5, token: 'Ô' } },
  });
  const plainA = buildModel(reference, { ...base, text: 'A' });
  check(
    Math.abs(other.size.x - plainA.size.x) < 1e-6 &&
      Math.abs(other.size.y - plainA.size.y) < 1e-6,
    'đổi nội dung thì bỏ qua dịch chuyển đã lưu của chữ cũ',
  );
}

// --- Chọn cụm ký tự ---
{
  const base: ModelParams = {
    ...DEFAULT_PARAMS,
    text: 'AÔB',
    capHeight: CAP_HEIGHT,
    mode: 'text',
  };
  const built = buildModel(reference, base);
  const ids = built.pieces.filter((p) => p.token !== undefined).map((p) => p.id);

  // "AÔB" cho ra 4 nét: A, thân O, dấu mũ, B. Ô nằm giữa nên chọn cụm phải lấy
  // trọn cả hai nét của nó chứ không cắt đôi.
  check(ids.length === 4, 'chuỗi "AÔB" cho ra bốn nét', `${ids.length} nét`);

  const selection = new Selection();
  selection.setOrder(ids);

  // Bấm chữ A rồi Shift + bấm dấu mũ của Ô: phải chọn A và cả hai nét của Ô.
  selection.only(ids[0]);
  selection.range(ids[2]);
  check(
    selection.size === 3 && selection.has(ids[1]) && selection.has(ids[2]),
    'chọn cụm lấy trọn ký tự ở hai đầu, không cắt đôi chữ Ô',
    `${selection.size} nét`,
  );

  // Kéo cả cụm phải dời mọi nét trong cụm đi đúng một khoảng như nhau.
  const chosen = selection.list();
  const moved = buildModel(reference, {
    ...base,
    partOffsets: Object.fromEntries(
      chosen.map((id) => [id, { dx: 0, dy: 4, token: built.pieces.find((p) => p.id === id)!.token! }]),
    ),
  });

  const gap = (result: typeof built, id: string) =>
    result.pieces.find((p) => p.id === id)!.geometry.boundingBox!.min.y -
    result.pieces.find((p) => p.id === ids[3])!.geometry.boundingBox!.min.y;

  check(
    chosen.every((id) => Math.abs(gap(moved, id) - gap(built, id) - 4) < TOLERANCE),
    'kéo cụm dời mọi nét trong cụm đi cùng một khoảng',
  );
  check(
    Math.abs(gap(moved, ids[3]) - gap(built, ids[3])) < 1e-9,
    'nét ngoài cụm đứng yên',
  );

  // Bỏ một nét khỏi vùng chọn rồi chọn lại phải ra đúng như cũ.
  selection.toggle(ids[1]);
  check(selection.size === 2 && !selection.has(ids[1]), 'Ctrl + bấm bỏ được một nét khỏi cụm');
  selection.toggle(ids[1]);
  check(selection.size === 3, 'Ctrl + bấm lần nữa thì chọn lại');
}

// --- Hình dạng lỗ móc khóa ---
{
  const shapes: HoleShape[] = ['circle', 'square', 'triangle', 'hexagon', 'semicircle', 'teardrop'];

  for (const holeShape of shapes) {
    for (const plateShape of ['rect', 'outline'] as PlateShape[]) {
      const params: ModelParams = {
        ...DEFAULT_PARAMS,
        text: SAMPLE,
        capHeight: CAP_HEIGHT,
        mode: 'keychain',
        plateShape,
        holeShape,
        holeDiameter: 6,
        holeMargin: 3,
      };

      const result = buildModel(reference, params);
      const geometry = mergePieces(result.pieces);
      const center = result.holeCenter!;
      const label = `[lỗ ${holeShape} · đế ${plateShape}]`;

      check(checkMesh(geometry).openEdges === 0, `${label} lưới kín`);

      // Lời hứa của tham số "cỡ lỗ": một vòng tròn đúng cỡ đó phải lọt vừa lòng
      // lỗ. Dò vòng quanh ở ngay trong mép vòng tròn ấy — chỗ nào cũng phải
      // rỗng thì vòng khóa mới xỏ qua được.
      const probe = params.holeDiameter / 2 - 0.3;
      let blocked = 0;
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2;
        const x = center.x + Math.cos(angle) * probe;
        const y = center.y + Math.sin(angle) * probe;
        if (countHits(geometry, x, y) !== 0) blocked++;
      }
      check(blocked === 0, `${label} vòng khóa đúng cỡ lọt vừa`, `${blocked}/16 chỗ bị chặn`);

      // Và ngay ngoài mép lỗ phải còn vật liệu ở mọi hướng, nếu không thì lỗ đã
      // ăn thủng ra ngoài mép đế. Đo từ mép xa nhất của lỗ ra thêm nửa khoảng
      // cách mép — vẫn còn nằm trong phần vật liệu phải chừa.
      const reach = holeOutline(holeShape, new THREE.Vector2(), params.holeDiameter).outerRadius;
      const far = reach + params.holeMargin * 0.5;
      let solid = 0;
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2;
        if (countHits(geometry, center.x + Math.cos(angle) * far, center.y + Math.sin(angle) * far) === 2) {
          solid++;
        }
      }
      check(solid >= 15, `${label} lỗ nằm gọn trong vật liệu`, `${solid}/16 hướng còn vật liệu`);
    }
  }

  // Hình nhọn chiếm nhiều chỗ hơn hình tròn cùng cỡ, nên đế phải nới rộng ra
  // theo — nếu không thì góc nhọn sẽ thò ra ngoài mép.
  const of = (holeShape: HoleShape) =>
    buildModel(reference, {
      ...DEFAULT_PARAMS,
      text: SAMPLE,
      capHeight: CAP_HEIGHT,
      mode: 'keychain',
      plateShape: 'rect',
      holeShape,
      holeDiameter: 6,
    }).size.x;

  check(of('triangle') > of('circle'), 'đế nới rộng ra cho lỗ tam giác', `${of('circle').toFixed(1)} → ${of('triangle').toFixed(1)} mm`);
  check(of('square') > of('circle'), 'đế nới rộng ra cho lỗ vuông');
}

// --- Chữ dựng vuông góc với đế ---
{
  const base: ModelParams = {
    ...DEFAULT_PARAMS,
    text: 'ABC',
    capHeight: CAP_HEIGHT,
    textDepth: 5,
    plateThickness: 3,
    plateMargin: 4,
    mode: 'plate',
    plateShape: 'rect',
  };
  const flat = buildModel(reference, base);
  const upright = buildModel(reference, { ...base, textAngle: 90 });

  check(checkMesh(mergePieces(upright.pieces)).openEdges === 0, 'lưới chữ dựng đứng vẫn kín');

  // Nằm phẳng: cao = đế + độ dày chữ. Dựng đứng: cao = đế + chiều cao chữ.
  check(
    Math.abs(flat.size.z - (base.plateThickness + base.textDepth)) < TOLERANCE,
    'nằm phẳng thì chiều cao là đế cộng độ dày chữ',
    `${flat.size.z.toFixed(2)} mm`,
  );
  // Chữ lún vào đế `uprightSink` mm nên đỉnh chữ thấp đi đúng chừng ấy.
  const expectedTop = base.plateThickness - DEFAULT_PARAMS.uprightSink + CAP_HEIGHT;
  check(
    upright.size.z >= expectedTop - TOLERANCE,
    'dựng đứng thì chiều cao là đế cộng chiều cao chữ',
    `${flat.size.z.toFixed(1)} → ${upright.size.z.toFixed(1)} mm, tối thiểu ${expectedTop.toFixed(1)}`,
  );

  // Bề ngang không đổi vì trục xoay chính là trục ngang; bề sâu thì co lại còn
  // đúng độ dày chữ cộng lề đế hai bên.
  check(
    Math.abs(upright.size.x - flat.size.x) < TOLERANCE,
    'bề ngang không đổi khi dựng chữ',
    `${flat.size.x.toFixed(2)} → ${upright.size.x.toFixed(2)} mm`,
  );
  check(
    Math.abs(upright.size.y - (base.textDepth + base.plateMargin * 2)) < TOLERANCE,
    'đế bám theo bóng đổ của chữ, không theo dáng chữ',
    `sâu ${upright.size.y.toFixed(2)} mm, mong đợi ${(base.textDepth + base.plateMargin * 2).toFixed(2)}`,
  );

  // Mọi chữ phải cắm vào đế, không cái nào treo lơ lửng.
  //
  // Đo theo **đường chân chữ** chứ không theo đáy hộp bao: chữ `C` tròn thò
  // xuống dưới đường chân một chút, còn `g` thì thòng hẳn — cả hai đều đúng.
  // Trước đây chỗ này căn theo đáy thấp nhất của cả cụm, nên chữ nào có đáy cao
  // hơn là treo lơ lửng; "Ag" từng làm chữ A treo cách đế 5.7 mm.
  const letters = upright.pieces.filter((p) => p.role === 'text');
  const baselineZ = base.plateThickness - DEFAULT_PARAMS.uprightSink;
  const flatBottomed = letters.filter((p) => 'AB'.includes(p.token ?? ''));

  check(flatBottomed.length === 2, 'tìm được chữ A và B để đo');
  check(
    flatBottomed.every((p) => Math.abs(p.geometry.boundingBox!.min.z - baselineZ) < TOLERANCE),
    'chân chữ đáy phẳng nằm đúng cao độ đã lún',
    `${flatBottomed.map((p) => p.geometry.boundingBox!.min.z.toFixed(2)).join(', ')} mm, mong đợi ${baselineZ}`,
  );
  check(
    letters.every((p) => p.geometry.boundingBox!.min.z <= baselineZ + TOLERANCE),
    'không chữ nào treo lơ lửng trên đế',
  );

  // Chữ có nét thòng: chữ không thòng vẫn phải cắm đúng chỗ, không bị kéo lên.
  const withTail = buildModel(reference, { ...base, text: 'Ag', textAngle: 90 });
  const plateTop = withTail.pieces.find((p) => p.role === 'plate')!.geometry.boundingBox!.max.z;
  const a = withTail.pieces.find((p) => p.token === 'A')!;
  check(
    Math.abs(a.geometry.boundingBox!.min.z - (plateTop - DEFAULT_PARAMS.uprightSink)) < TOLERANCE,
    'nét thòng của chữ bên cạnh không kéo chữ khác lên',
    `A ở ${a.geometry.boundingBox!.min.z.toFixed(2)} mm, mặt đế ${plateTop.toFixed(2)} mm`,
  );

  // Nét chữ không được méo: dựng đứng chỉ là phép xoay.
  check(
    Math.abs(estimateMinStroke(upright.layout.shapes)! - estimateMinStroke(flat.layout.shapes)!) < 1e-9,
    'dựng chữ không làm méo nét',
  );

  // Góc trung gian nằm giữa hai đầu — đủ để tin phép xoay chạy liên tục.
  const tilted = buildModel(reference, { ...base, textAngle: 45 });
  check(
    tilted.size.z > flat.size.z + 1 && tilted.size.z < upright.size.z - 1,
    'góc 45° cho chiều cao nằm giữa hai đầu',
    `${flat.size.z.toFixed(1)} < ${tilted.size.z.toFixed(1)} < ${upright.size.z.toFixed(1)} mm`,
  );

  // Góc 0 phải giống hệt như khi chưa có tính năng này.
  const zero = buildModel(reference, { ...base, textAngle: 0 });
  check(
    Math.abs(zero.size.x - flat.size.x) < 1e-9 &&
      Math.abs(zero.size.y - flat.size.y) < 1e-9 &&
      Math.abs(zero.size.z - flat.size.z) < 1e-9,
    'góc 0 giữ nguyên hành vi cũ',
  );

  // Khắc chìm bỏ qua góc dựng, vì khắc hình chiếu thì không ra chữ.
  const debossFlat = buildModel(reference, { ...base, mode: 'deboss' });
  const debossTilted = buildModel(reference, { ...base, mode: 'deboss', textAngle: 90 });
  check(
    Math.abs(debossFlat.size.y - debossTilted.size.y) < 1e-9,
    'chế độ khắc chìm bỏ qua góc dựng',
  );

  // Đế bo sát chữ cũng phải bám bóng đổ: nó ôm quanh vệt chân chữ.
  const hugging = buildModel(reference, { ...base, plateShape: 'outline', textAngle: 90 });
  check(checkMesh(mergePieces(hugging.pieces)).openEdges === 0, 'đế bo sát + chữ đứng vẫn kín lưới');
  check(
    hugging.size.y < base.textDepth + base.plateMargin * 2 + 2,
    'đế bo sát ôm sát vệt chân chữ',
    `sâu ${hugging.size.y.toFixed(1)} mm`,
  );

  // Cảnh báo: chữ cao mà mỏng thì gãy; dựng đứng mà không đế thì đổ.
  const slim: ModelParams = { ...base, textDepth: 1 };
  check(
    validate(buildModel(reference, { ...slim, textAngle: 90 }), { ...slim, textAngle: 90 }, reference.font)
      .some((i) => i.message.includes('mảnh như lưỡi dao')),
    'cảnh báo chữ đứng quá mảnh',
  );
  const noPlate: ModelParams = { ...base, mode: 'text', textAngle: 90 };
  check(
    validate(buildModel(reference, noPlate), noPlate, reference.font).some((i) =>
      i.message.includes('không có đế'),
    ),
    'cảnh báo chữ đứng mà không có đế',
  );
  check(
    validate(buildModel(reference, { ...base, textAngle: 90 }), { ...base, textAngle: 90 }, reference.font)
      .every((i) => !i.message.includes('mảnh như lưỡi dao')),
    'chữ đủ dày thì không báo động thừa',
  );

  // Xếp theo hình và dựng đứng dùng được cùng lúc.
  const both = buildModel(reference, { ...base, textShape: 'circle', shapeRadius: 30, textAngle: 90 });
  check(checkMesh(mergePieces(both.pieces)).openEdges === 0, 'vừa vòng tròn vừa dựng đứng vẫn kín lưới');
}

// --- Xếp chữ theo hình ---
{
  const base: ModelParams = {
    ...DEFAULT_PARAMS,
    text: 'ABCDEFGH',
    capHeight: CAP_HEIGHT,
    mode: 'text',
  };
  const straight = buildModel(reference, base);

  // Đường: mốc giữa phải rơi đúng đỉnh vòng tròn, và đi tới phải là sang phải.
  {
    const path = TextPath.create({ ...base, textShape: 'circle', shapeRadius: 40 }, 100)!;
    const mid = path.frameAt(0);
    check(
      Math.abs(mid.point.x) < 1e-6 && Math.abs(mid.point.y - 40) < 1e-6,
      'mốc giữa vòng tròn nằm đúng đỉnh',
      `(${mid.point.x.toFixed(2)}, ${mid.point.y.toFixed(2)})`,
    );
    check(mid.tangent.x > 0.99, 'chữ chạy sang phải tại mốc giữa');
    check(mid.normal.y > 0.99, 'đầu chữ hướng ra ngoài tâm');
    check(
      Math.abs(path.length - 2 * Math.PI * 40) < 0.5,
      'chu vi vòng tròn đúng',
      `${path.length.toFixed(1)} mm`,
    );

    const square = TextPath.create({ ...base, textShape: 'square', shapeRadius: 30 }, 100)!;
    check(Math.abs(square.length - 8 * 30) < 0.5, 'chu vi ô vuông đúng', `${square.length.toFixed(1)} mm`);
  }

  for (const [shape, patch] of [
    ['circle', { shapeRadius: 30 }],
    ['square', { shapeRadius: 30 }],
    ['wave', { waveAmplitude: 10, waveLength: 50 }],
  ] as Array<[TextShape, Partial<ModelParams>]>) {
    const params: ModelParams = { ...base, textShape: shape, ...patch };
    const result = buildModel(reference, params);
    const label = `[${shape}]`;

    check(checkMesh(mergePieces(result.pieces)).openEdges === 0, `${label} lưới kín`);
    check(
      result.pieces.length === straight.pieces.length,
      `${label} không mất nét nào khi uốn`,
      `${result.pieces.length} / ${straight.pieces.length}`,
    );

    // Uốn phải làm khối chữ khác hẳn dạng thẳng, nếu không là chưa uốn gì cả.
    check(
      Math.abs(result.size.y - straight.size.y) > 2,
      `${label} khối chữ đổi dáng so với dạng thẳng`,
      `cao ${straight.size.y.toFixed(1)} → ${result.size.y.toFixed(1)} mm`,
    );

    // Đây là lời hứa cốt lõi của thiết kế: chữ được xoay và dời, **không** bị
    // bóp méo. Nếu kéo từng điểm theo đường cong thì nét phía trong sẽ mỏng đi,
    // và bề rộng nét mảnh nhất sẽ tụt xuống.
    const strokeStraight = estimateMinStroke(straight.layout.shapes)!;
    const strokeShaped = estimateMinStroke(result.layout.shapes)!;
    check(
      Math.abs(strokeShaped - strokeStraight) < 0.02,
      `${label} nét chữ giữ nguyên bề rộng, không bị bóp méo`,
      `${strokeStraight.toFixed(3)} → ${strokeShaped.toFixed(3)} mm`,
    );
  }

  // Vòng tròn bán kính nhỏ thì chữ vòng kín; khối chữ phải rộng cỡ đường kính.
  const ring = buildModel(reference, {
    ...base,
    text: 'ABCDEFGHIJKLMNOP',
    textShape: 'circle',
    shapeRadius: 25,
  });
  check(
    Math.abs(ring.size.x - ring.size.y) < 8,
    'chữ vòng kín thì khối chữ gần vuông',
    `${ring.size.x.toFixed(1)} × ${ring.size.y.toFixed(1)} mm`,
  );

  // Lật hình đổi chiều cong: vòng trên thì hai chữ đầu cuối **thấp** hơn chữ
  // giữa, vòng dưới thì ngược lại. So hộp bao thì không thấy gì, vì hai bên chỉ
  // là ảnh gương của nhau nên cùng kích thước.
  const normal = buildModel(reference, { ...base, textShape: 'circle', shapeRadius: 30 });
  const flipped = buildModel(reference, { ...base, textShape: 'circle', shapeRadius: 30, shapeFlip: true });

  const bow = (r: typeof normal) => {
    const glyphs = r.pieces.filter((p) => p.token !== undefined);
    const y = (p: (typeof glyphs)[number]) =>
      p.geometry.boundingBox!.getCenter(new THREE.Vector3()).y;
    return y(glyphs[0]) - y(glyphs[glyphs.length >> 1]);
  };

  check(checkMesh(mergePieces(flipped.pieces)).openEdges === 0, 'lật vòng tròn vẫn cho lưới kín');
  check(
    bow(normal) < -1 && bow(flipped) > 1,
    'lật vòng tròn thì chiều cong đảo lại',
    `${bow(normal).toFixed(1)} → ${bow(flipped).toFixed(1)} mm`,
  );

  // Biên độ sóng lớn hơn thì khối chữ cao hơn — đúng như trực giác.
  const gentle = buildModel(reference, { ...base, textShape: 'wave', waveAmplitude: 3, waveLength: 60 });
  const strong = buildModel(reference, { ...base, textShape: 'wave', waveAmplitude: 15, waveLength: 60 });
  check(
    strong.size.y > gentle.size.y + 10,
    'biên độ sóng lớn hơn thì khối chữ cao hơn',
    `${gentle.size.y.toFixed(1)} → ${strong.size.y.toFixed(1)} mm`,
  );

  // Chế độ thẳng phải giống hệt như khi chưa có tính năng này.
  const explicitStraight = buildModel(reference, { ...base, textShape: 'straight', shapeRadius: 5 });
  check(
    Math.abs(explicitStraight.size.x - straight.size.x) < 1e-9 &&
      Math.abs(explicitStraight.size.y - straight.size.y) < 1e-9,
    'chọn "thẳng hàng" thì tham số hình không ảnh hưởng gì',
  );

  // Uốn xong mới áp dịch chuyển kéo tay: kéo trong khung xem là kéo trên hình đã
  // uốn, nên đoạn dịch chuyển phải đi thẳng, không bị uốn theo.
  const shaped = buildModel(reference, { ...base, textShape: 'circle', shapeRadius: 30 });
  const first = shaped.pieces.find((p) => p.token !== undefined)!;
  const moved = buildModel(reference, {
    ...base,
    textShape: 'circle',
    shapeRadius: 30,
    partOffsets: { [first.id]: { dx: 0, dy: 7, token: first.token! } },
  });
  const anchorId = shaped.pieces.filter((p) => p.token !== undefined).at(-1)!.id;
  const gap = (r: typeof shaped, id: string) =>
    r.pieces.find((p) => p.id === id)!.geometry.boundingBox!.min.y -
    r.pieces.find((p) => p.id === anchorId)!.geometry.boundingBox!.min.y;
  check(
    Math.abs(gap(moved, first.id) - gap(shaped, first.id) - 7) < TOLERANCE,
    'kéo tay trên chữ đã uốn dời đúng khoảng cách, không bị uốn theo',
    `${gap(shaped, first.id).toFixed(2)} → ${gap(moved, first.id).toFixed(2)} mm`,
  );

  // Xếp theo hình phải chạy được ở mọi chế độ model, kể cả khắc chìm.
  for (const mode of MODES) {
    const params: ModelParams = { ...base, mode, textShape: 'circle', shapeRadius: 32 };
    const result = buildModel(reference, params);
    check(
      checkMesh(mergePieces(result.pieces)).openEdges === 0,
      `[${mode}] chữ vòng tròn cho lưới kín`,
    );
  }
}

// --- Hình chèn thêm ---
{
  const store = new GraphicStore();

  // SVG tô đặc: vành khuyên — một đường bao ngoài và một lỗ.
  const ring = store.addSvg(
    'ring',
    'khuyên',
    `<svg viewBox="0 0 100 100"><path d="M50 5 A45 45 0 1 1 49.9 5 Z M50 25 A25 25 0 1 0 50.1 25 Z"/></svg>`,
  );
  check(ring.shapes.length === 1, 'SVG tô đặc cho ra một vùng', `${ring.shapes.length} vùng`);
  check(ring.shapes[0].holes.length === 1, 'nhận ra lỗ bên trong vành khuyên');
  check(Math.abs(ring.aspect - 1) < 0.02, 'giữ đúng tỉ lệ hình vuông', `tỉ lệ ${ring.aspect.toFixed(3)}`);

  // SVG vẽ bằng nét: phải nới thành khối đặc, nếu không sẽ ra model rỗng.
  const stroked = store.addSvg(
    'stroked',
    'dấu cộng',
    `<svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2">` +
      `<path d="M12 5 L12 19"/><path d="M5 12 L19 12"/></svg>`,
  );
  check(stroked.strokeCount === 2, 'đếm đúng số nét vẽ', `${stroked.strokeCount} nét`);
  check(stroked.shapes.length === 1, 'hai nét giao nhau hợp thành một khối', `${stroked.shapes.length} khối`);

  // SVG không có gì in được thì phải báo lỗi rõ ràng chứ không trả về rỗng.
  let rejected = false;
  try {
    store.addSvg('empty', 'rỗng', '<svg viewBox="0 0 10 10"></svg>');
  } catch {
    rejected = true;
  }
  check(rejected, 'SVG không có hình nào thì báo lỗi');

  // Ảnh raster: dựng sẵn một bitmap hình vuông có lỗ vuông ở giữa.
  const N = 64;
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const solid = x >= 8 && x < 56 && y >= 8 && y < 56 && !(x >= 24 && x < 40 && y >= 24 && y < 40);
      data[(y * N + x) * 4 + 3] = solid ? 255 : 0;
    }
  }
  const traced = traceBitmap({ data, width: N, height: N });
  check(traced.length === 1, 'dò biên ảnh cho ra một vùng', `${traced.length} vùng`);
  check(traced[0].holes.length === 1, 'dò được cả lỗ bên trong ảnh');

  // Hình chèn phải đi trọn đường ống: được đùn, được đế bao, lưới vẫn kín.
  for (const mode of MODES) {
    const params: ModelParams = {
      ...DEFAULT_PARAMS,
      text: 'AB',
      capHeight: CAP_HEIGHT,
      mode,
      graphics: [{ id: 'ring', name: 'khuyên', height: CAP_HEIGHT }],
    };

    const withGraphic = buildModel(reference, params, store);
    const without = buildModel(reference, { ...params, graphics: [] }, store);

    check(
      withGraphic.size.x > without.size.x + CAP_HEIGHT * 0.5,
      `[${mode}] hình chèn làm model rộng ra`,
      `${without.size.x.toFixed(1)} → ${withGraphic.size.x.toFixed(1)} mm`,
    );
    check(
      checkMesh(mergePieces(withGraphic.pieces)).openEdges === 0,
      `[${mode}] lưới có hình chèn vẫn kín`,
    );

    // Mảnh của hình chèn phải kéo thả được y như nét chữ.
    const parts = withGraphic.pieces.filter((p) => p.token === 'ring');
    check(parts.length > 0, `[${mode}] hình chèn thành mảnh kéo thả được`, `${parts.length} mảnh`);
  }

  // Chiều cao đặt bao nhiêu thì hình cao đúng bấy nhiêu.
  const tall = buildModel(reference, {
    ...DEFAULT_PARAMS,
    text: 'A',
    capHeight: CAP_HEIGHT,
    mode: 'text',
    graphics: [{ id: 'ring', name: 'khuyên', height: 30 }],
  }, store);
  const piece = tall.pieces.find((p) => p.token === 'ring')!;
  const box = piece.geometry.boundingBox!;
  check(
    Math.abs(box.max.y - box.min.y - 30) < TOLERANCE,
    'hình chèn cao đúng số mm đã đặt',
    `${(box.max.y - box.min.y).toFixed(2)} mm`,
  );

  // Bỏ hình khỏi danh sách thì dịch chuyển tay của hình cũ không được áp nhầm.
  const shifted = buildModel(reference, {
    ...DEFAULT_PARAMS,
    text: 'A',
    capHeight: CAP_HEIGHT,
    mode: 'text',
    graphics: [{ id: 'stroked', name: 'dấu cộng', height: CAP_HEIGHT }],
    partOffsets: { X0S0: { dx: 10, dy: 0, token: 'ring' } },
  }, store);
  const plain = buildModel(reference, {
    ...DEFAULT_PARAMS,
    text: 'A',
    capHeight: CAP_HEIGHT,
    mode: 'text',
    graphics: [{ id: 'stroked', name: 'dấu cộng', height: CAP_HEIGHT }],
  }, store);
  check(
    Math.abs(shifted.size.x - plain.size.x) < 1e-6,
    'đổi hình thì bỏ qua dịch chuyển đã lưu của hình cũ',
  );
}

// --- Lỗ vẫn thủng dù kéo đi đâu ---
// Trước đây lỗ được gắn vào riêng hình khuyên treo rồi mới hợp khuyên với thân
// đế, nên kéo lỗ chạm vào đế là bị vật liệu đế trám mất. Giờ lỗ được khoét sau
// cùng nên không còn phụ thuộc thứ tự ghép.
{
  for (const plateShape of ['rect', 'outline'] as PlateShape[]) {
    for (const holeOffset of [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 12, y: 0 },
      { x: 0, y: 9 },
      { x: -8, y: -6 },
    ]) {
      const params: ModelParams = {
        ...DEFAULT_PARAMS,
        text: SAMPLE,
        capHeight: CAP_HEIGHT,
        mode: 'keychain',
        plateShape,
        holeOffset,
      };
      const result = buildModel(reference, params);
      const label = `[đế ${plateShape} · kéo lỗ (${holeOffset.x},${holeOffset.y})]`;

      // Kiểm trên riêng tấm đế: chữ nổi bên trên có thể che lỗ, mà đó là chuyện
      // khác — đã có cảnh báo riêng lo.
      const plate = result.pieces.find((p) => p.role === 'plate')!;
      const probe = params.holeDiameter / 2 - 0.3;
      const center = result.holeCenter!;

      let blocked = 0;
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const x = center.x + Math.cos(angle) * probe;
        const y = center.y + Math.sin(angle) * probe;
        if (countHits(plate.geometry, x, y) !== 0) blocked++;
      }
      check(blocked === 0, `${label} lỗ vẫn thủng qua đế`, `${blocked}/12 chỗ bị lấp`);
      check(checkMesh(mergePieces(result.pieces)).openEdges === 0, `${label} lưới kín`);
    }
  }

  // Kéo lỗ vào giữa chữ thì hình học vẫn đúng, nhưng phải có cảnh báo bị chữ che.
  const buried: ModelParams = {
    ...DEFAULT_PARAMS,
    text: SAMPLE,
    capHeight: CAP_HEIGHT,
    mode: 'keychain',
    plateShape: 'rect',
    holeOffset: { x: 40, y: 0 },
  };
  const result = buildModel(reference, buried);
  check(result.holeBlocked, 'phát hiện được lỗ bị nét chữ che');
  check(
    validate(result, buried, reference.font).some((i) => i.message.includes('nằm dưới nét chữ')),
    'có cảnh báo lỗ bị chữ che',
  );

  const clear = buildModel(reference, { ...buried, holeOffset: { x: 0, y: 0 } });
  check(!clear.holeBlocked, 'lỗ ở vị trí mặc định thì không báo bị che');
}

// --- Màu riêng cho đế và chữ ---
{
  for (const mode of ['plate', 'keychain', 'deboss'] as BuildMode[]) {
    const params: ModelParams = { ...DEFAULT_PARAMS, text: SAMPLE, capHeight: CAP_HEIGHT, mode };
    const { pieces } = buildModel(reference, params);

    const plate = pieces.filter((p) => p.role === 'plate');
    const text = pieces.filter((p) => p.role === 'text');

    check(plate.length === 1, `[${mode}] đúng một mảnh mang vai trò đế`, `${plate.length} mảnh`);
    check(text.length > 1, `[${mode}] các nét chữ mang vai trò chữ`, `${text.length} nét`);
    check(
      text.every((p) => p.token !== undefined),
      `[${mode}] mảnh vai trò chữ nào cũng gắn với một ký tự`,
    );
  }

  // Thanh nối phải ăn theo màu chữ chứ không màu đế — nó là phần kéo dài của nét
  // chữ, tô màu đế thì nhìn như đế bị thừa ra mấy que.
  const withBars = buildModel(reference, {
    ...DEFAULT_PARAMS,
    text: SAMPLE,
    capHeight: CAP_HEIGHT,
    mode: 'text',
    connectors: true,
  });
  const bars = withBars.pieces.find((p) => p.id === 'connectors');
  check(bars !== undefined && bars.role === 'text', 'thanh nối mang vai trò chữ');
  check(
    withBars.pieces.every((p) => p.role === 'text'),
    'chế độ chữ nổi không có mảnh nào mang vai trò đế',
  );

  // Đổi màu không được đụng tới hình học, nếu không đường tắt bỏ qua việc dựng
  // lại trong main.ts sẽ cho ra model sai.
  const base: ModelParams = { ...DEFAULT_PARAMS, text: SAMPLE, capHeight: CAP_HEIGHT, mode: 'plate' };
  const before = buildModel(reference, base);
  const after = buildModel(reference, { ...base, textColor: '#ff0000', plateColor: '#00ff00' });
  check(
    before.size.equals(after.size) &&
      before.pieces.length === after.pieces.length &&
      before.pieces.every(
        (p, i) =>
          p.geometry.getAttribute('position').count ===
          after.pieces[i].geometry.getAttribute('position').count,
      ),
    'đổi màu không làm đổi hình học',
  );
}

// --- Hoàn tác và làm lại ---
{
  const base: ModelParams = {
    ...DEFAULT_PARAMS,
    text: 'AÔB',
    capHeight: CAP_HEIGHT,
    mode: 'keychain',
  };
  const store = new Store(base);
  const ids = buildModel(reference, base)
    .pieces.filter((p) => p.token !== undefined)
    .map((p) => p.id);

  /**
   * Vị trí một nét **so với nét cuối cùng**, để đối chiếu qua các bước hoàn tác.
   *
   * Phải đo tương đối chứ không đo vị trí tuyệt đối: model được căn tâm lại sau
   * mỗi lần dựng, nên dời một nét đi 8 mm chỉ làm toạ độ tuyệt đối của nó đổi
   * chừng một nửa chừng ấy.
   */
  const positionOf = (id: string) => {
    const pieces = buildModel(reference, store.get() as ModelParams).pieces;
    const target = pieces.find((p) => p.id === id)!;
    const anchor = pieces.find((p) => p.id === ids[ids.length - 1])!;
    return target.geometry.boundingBox!.min.clone().sub(anchor.geometry.boundingBox!.min);
  };

  check(!store.canUndo() && !store.canRedo(), 'lúc đầu chưa có gì để hoàn tác');

  const start = positionOf(ids[0]);
  store.moveParts([{ id: ids[0], token: 'A' }], 4, 0);
  const afterFirst = positionOf(ids[0]);
  store.moveParts([{ id: ids[0], token: 'A' }], 4, 0);

  check(store.canUndo() && !store.canRedo(), 'kéo xong thì hoàn tác được, chưa làm lại được');

  check(store.undo(), 'hoàn tác lần một chạy');
  check(
    positionOf(ids[0]).distanceTo(afterFirst) < TOLERANCE,
    'hoàn tác lùi đúng một thao tác, không lùi hết',
  );
  check(store.canRedo(), 'hoàn tác xong thì làm lại được');

  check(store.undo(), 'hoàn tác lần hai chạy');
  check(positionOf(ids[0]).distanceTo(start) < TOLERANCE, 'hoàn tác hết thì về vị trí ban đầu');
  check(!store.canUndo(), 'hết chồng hoàn tác thì dừng');
  check(!store.undo(), 'hoàn tác khi không còn gì thì báo không làm gì');

  check(store.redo() && store.redo(), 'làm lại được cả hai bước');
  check(
    Math.abs(positionOf(ids[0]).x - start.x - 8) < TOLERANCE,
    'làm lại đưa về đúng chỗ đã kéo tới',
  );

  // Kéo lỗ và bỏ hết chỉnh tay cũng phải nằm trong lịch sử.
  store.moveHole(0, 5);
  check(store.get().holeOffset.y === 5, 'kéo lỗ có ghi lại');
  store.undo();
  check(store.get().holeOffset.y === 0, 'hoàn tác lùi được cả thao tác kéo lỗ');
  store.redo();

  store.resetManual();
  check(!store.hasManualEdits(), 'bỏ hết chỉnh tay xoá sạch dịch chuyển');
  store.undo();
  check(store.hasManualEdits(), 'hoàn tác lấy lại được cả cú bỏ hết chỉnh tay');

  // Thao tác mới sau khi hoàn tác phải cắt bỏ nhánh làm lại.
  store.undo();
  check(store.canRedo(), 'còn nhánh làm lại trước khi có thao tác mới');
  store.moveParts([{ id: ids[0], token: 'A' }], 1, 1);
  check(!store.canRedo(), 'thao tác mới xoá nhánh làm lại');
}

// --- Kéo lỗ móc khóa ---
{
  const base: ModelParams = {
    ...DEFAULT_PARAMS,
    text: SAMPLE,
    capHeight: CAP_HEIGHT,
    mode: 'keychain',
    plateShape: 'rect',
    holePosition: 'left',
    holeDiameter: 5,
    holeMargin: 3,
  };

  const before = buildModel(reference, base);
  const shifted = buildModel(reference, { ...base, holeOffset: { x: 0, y: 6 } });

  check(before.holeCenter !== null, 'chế độ móc khóa có báo vị trí lỗ để đặt tay nắm');
  check(
    Math.abs(shifted.holeCenter!.y - before.holeCenter!.y - 6) < TOLERANCE,
    'kéo lỗ dời đúng khoảng cách đã kéo',
    `y ${before.holeCenter!.y.toFixed(2)} → ${shifted.holeCenter!.y.toFixed(2)} mm`,
  );

  // Lỗ phải thật sự thủng ở chỗ mới, và chỗ cũ phải liền lại.
  const geometry = mergePieces(shifted.pieces);
  const { x, y } = shifted.holeCenter!;
  check(countHits(geometry, x, y) === 0, 'lỗ thủng ở đúng vị trí vừa kéo tới');
  check(
    countHits(geometry, before.holeCenter!.x, before.holeCenter!.y) === 2,
    'vị trí lỗ cũ đã liền lại',
  );
  check(checkMesh(geometry).openEdges === 0, 'lưới sau khi kéo lỗ vẫn kín');
}

// --- Khối bắt chuột không được lọt vào file xuất ra ---
{
  const params: ModelParams = {
    ...DEFAULT_PARAMS,
    text: SAMPLE,
    capHeight: CAP_HEIGHT,
    mode: 'deboss',
  };
  const result = buildModel(reference, params);
  const proxies = result.pieces.filter((p) => p.pickOnly);

  check(proxies.length > 0, 'chế độ khắc chìm có khối mờ để bắt chuột', `${proxies.length} khối`);
  check(
    proxies.every((p) => p.token !== undefined),
    'khối bắt chuột đều kéo thả được',
  );

  const exported = mergePieces(result.pieces);
  const withProxies = result.pieces.reduce(
    (n, p) => n + p.geometry.getAttribute('position').count / 3,
    0,
  );
  check(
    exported.getAttribute('position').count / 3 < withProxies,
    'khối bắt chuột bị loại khỏi file xuất ra',
  );
  check(checkMesh(exported).openEdges === 0, 'file xuất ra vẫn là lưới kín');
}

console.log('\nKiểm bằng phép so sánh thể tích');

// Lỗ treo: bắn một tia thẳng đứng qua tâm lỗ, phải không gặp vật liệu nào.
// Không so được bằng thể tích, vì lỗ to hơn thì đế cũng nở ra theo phần tai treo.
{
  const params: ModelParams = {
    ...DEFAULT_PARAMS,
    text: SAMPLE,
    capHeight: CAP_HEIGHT,
    mode: 'keychain',
    plateShape: 'rect',
    holePosition: 'left',
    holeDiameter: 5,
    holeMargin: 3,
  };
  const built = buildModel(reference, params);
  const geometry = mergePieces(built.pieces);
  const size = built.size;

  // Model đã được căn tâm, nên tâm lỗ nằm cách mép trái đúng bằng khoảng cách
  // mép cộng bán kính lỗ.
  const holeX = -size.x / 2 + params.holeMargin + params.holeDiameter / 2;
  const solidX = size.x / 2 - 1;
  const solidY = -size.y / 2 + 1;

  check(countHits(geometry, holeX, 0) === 0, 'lỗ móc khóa xuyên suốt đế');
  check(countHits(geometry, solidX, solidY) === 2, 'chỗ không khoét vẫn đặc vật liệu');
}

// Đế bo sát chữ treo lỗ trên một khuyên riêng nối vào thân đế. Phải kiểm riêng:
// thanh nối chạy từ mép lỗ ra, chỉ chệch một chút là bịt mất lỗ.
{
  const params: ModelParams = {
    ...DEFAULT_PARAMS,
    text: SAMPLE,
    capHeight: CAP_HEIGHT,
    mode: 'keychain',
    plateShape: 'outline',
    plateMargin: 4,
    holePosition: 'left',
    holeDiameter: 5,
    holeMargin: 2.5,
  };
  const built = buildModel(reference, params);
  const geometry = mergePieces(built.pieces);
  const size = built.size;

  // Khuyên nằm ở mép trái model, nên tâm lỗ cách mép trái đúng bán kính khuyên.
  const ringRadius = params.holeDiameter / 2 + params.holeMargin;
  const holeX = -size.x / 2 + ringRadius;

  check(countHits(geometry, holeX, 0) === 0, 'lỗ trên khuyên của đế bo sát vẫn thông');
  check(
    countHits(geometry, holeX + ringRadius * 0.85, 0) === 2,
    'vành khuyên quanh lỗ vẫn đặc vật liệu',
  );
}

// Khắc càng sâu thì càng mất nhiều vật liệu.
compareVolume(
  'chỗ khắc chìm có lõm thật',
  { mode: 'deboss', plateThickness: 4 },
  { debossDepth: 3 },
  { debossDepth: 0.5 },
);

// Chữ dày hơn thì model to hơn — chứng tỏ chữ có nằm trên đế.
compareVolume(
  'chữ có nổi trên đế',
  { mode: 'plate' },
  { textDepth: 1 },
  { textDepth: 8 },
);

console.log(
  failures === 0
    ? `\n✔ Toàn bộ phép kiểm đã qua. File STL nằm ở .check-output/`
    : `\n✘ ${failures} phép kiểm thất bại.`,
);
process.exit(failures === 0 ? 0 : 1);
