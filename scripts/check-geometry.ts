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
import { GraphicStore } from '../src/graphics/graphicStore';
import { traceBitmap } from '../src/graphics/traceBitmap';
import { checkMesh } from './meshCheck';
import { Selection } from '../src/viewer/interaction';

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
  // Chuỗi mẫu có dấu huyền, dấu ngã và dấu mũ, nên chắc chắn tách nhiều mảnh.
  {
    const base: ModelParams = { ...DEFAULT_PARAMS, text: SAMPLE, capHeight: CAP_HEIGHT, mode: 'text' };
    const loose = buildModel(loaded, base);
    const joined = buildModel(loaded, { ...base, connectors: true, connectorWidth: 2 });

    const before = countIslands(loose.parts);
    const after = countIslands(joined.parts);

    check(before > 1, 'chữ tiếng Việt vốn tách nhiều mảnh', `${before} mảnh`);
    check(after === 1, 'thanh nối gộp về một mảnh liền', `${before} mảnh → ${after} mảnh`);
    check(checkMesh(mergePieces(joined.pieces)).openEdges === 0, 'lưới có thanh nối vẫn kín');
    check(
      !validate(joined, { ...base, connectors: true, connectorWidth: 2 }, font).some((i) =>
        i.message.includes('mảnh rời'),
      ),
      'hết cảnh báo mảnh rời sau khi nối',
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
