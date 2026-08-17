/**
 * Điều phối toàn bộ quá trình dựng model: từ tham số người dùng ra các mảnh
 * hình học đã sẵn sàng hiển thị và xuất file.
 *
 * Quy ước hệ toạ độ: chữ nằm trong mặt phẳng XY, đùn theo trục +Z, và model
 * hoàn chỉnh luôn được đặt sao cho đáy nằm đúng tại Z = 0 — khớp với mặt bàn in.
 *
 * ## Vì sao trả về nhiều mảnh chứ không một khối
 *
 * Người dùng kéo thả được từng nét chữ ngay trong khung xem 3D, mà muốn bắt
 * được chuột thì mỗi nét phải là một đối tượng riêng để tia dò trúng. Nên chỗ
 * này trả về danh sách mảnh có mã định danh; khung xem dựng mỗi mảnh thành một
 * mesh, còn lúc xuất file thì gộp lại (xem `mergePieces`).
 *
 * ## Vì sao ở đây không dùng phép toán CSG
 *
 * Cách làm hiển nhiên cho "chữ trên đế" là hợp hai khối bằng CSG, còn "khắc
 * chìm" là trừ khối chữ ra khỏi đế. Nhưng đo thực tế cho thấy bộ CSG sinh ra
 * rất nhiều điểm chữ T — chỗ đỉnh của tam giác này rơi vào giữa cạnh của tam
 * giác kia — khiến gần một nửa số cạnh chỉ thuộc về một mặt. Ngay cả khi hợp
 * hai khối hộp đơn giản cũng vậy. Lưới như thế bị mọi công cụ kiểm tra báo là
 * không kín, và khi cắt lớp có thể để lại khe hở trên đường viền.
 *
 * Thay vào đó ta ghép **nhiều vỏ kín** rời nhau vào chung một file; mọi phần
 * mềm cắt lớp đều tự hợp các khối chồng nhau ở từng lớp cắt. Riêng phần khắc
 * chìm được dựng bằng phép trừ **đa giác 2D** rồi mới đùn, thay vì trừ khối 3D:
 * xem `debossedPlate()` bên dưới.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { layoutText, type TextLayout } from './layout';
import { buildPlate } from './plate';
import { differenceShapes, unionShapes } from './polygon2d';
import { connectDiacritics } from './connectors';
import type { LoadedFont } from '../fonts/fontManager';
import type { GraphicStore } from '../graphics/graphicStore';
import type { ModelParams } from '../state';

/** Vai trò của một mảnh, quyết định nó được tô màu chữ hay màu đế. */
/**
 * `fill` là khối lấp chỗ khắc chìm — về hình học nó nằm trong lòng đế, nhưng về
 * mục đích nó là một vật thể riêng để in bằng màu khác, nên phải tách vai trò.
 */
export type PieceRole = 'text' | 'plate' | 'fill';

/** Một mảnh của model, dựng thành một mesh riêng trong khung xem. */
export interface Piece {
  /** Mã định danh: mã nét chữ từ layout, hoặc `plate` / `connectors`. */
  id: string;
  role: PieceRole;
  geometry: THREE.BufferGeometry;
  /** Thứ đã sinh ra mảnh này: ký tự với nét chữ, mã hình với hình chèn. */
  token?: string;
  /**
   * Chỉ dùng để bắt chuột, không đưa vào file xuất ra. Ở chế độ khắc chìm, nét
   * chữ là chỗ lõm chứ không phải khối đặc, nên phải có một khối mờ phủ lên đó
   * thì tia dò mới có gì để trúng.
   */
  pickOnly?: boolean;
}

export interface BuildResult {
  pieces: Piece[];
  /** Bố cục chữ 2D — phần kiểm tra dùng lại để ước lượng bề rộng nét. */
  layout: TextLayout;
  /**
   * Các hình 2D quyết định model có rời ra mảnh nào không: ở chế độ chữ nổi là
   * chữ cộng thanh nối, ở các chế độ khác là hình đế.
   */
  parts: THREE.Shape[];
  /**
   * Tâm lỗ móc khóa trong hệ toạ độ model đã căn tâm, để khung xem đặt tay nắm
   * kéo thả lên đúng chỗ. `null` khi model không có lỗ.
   */
  holeCenter: THREE.Vector2 | null;
  /** Lỗ móc khóa đang bị nét chữ nằm đè lên — xem `PlateResult.holeBlocked`. */
  holeBlocked: boolean;
  /** Kích thước bao ngoài của model (mm). */
  size: THREE.Vector3;
}

export class EmptyTextError extends Error {}

/** Mã của những mảnh không phải nét chữ, nên không kéo thả được. */
export const PLATE_ID = 'plate';
export const CONNECTOR_ID = 'connectors';

/**
 * Độ lún (mm) khi chồng hai khối lên nhau. Hai vỏ chỉ chạm nhau đúng trên một
 * mặt phẳng dễ khiến phần mềm cắt lớp phân vân không rõ chúng có dính nhau hay
 * không, nên ta luôn cho chúng cắm vào nhau một chút.
 */
const OVERLAP = 0.01;

/** Bề dày đáy tối thiểu còn lại dưới chỗ khắc chìm (mm). */
const MIN_DEBOSS_FLOOR = 0.4;

/** Bề dày khối mờ dùng để bắt chuột ở chế độ khắc chìm (mm). */
const PICK_DEPTH = 0.4;

export function buildModel(
  loaded: LoadedFont,
  params: ModelParams,
  graphics?: GraphicStore,
): BuildResult {
  const layout = layoutText(loaded, params, graphics);
  if (layout.pieces.length === 0) {
    throw new EmptyTextError('Chưa có nội dung để dựng model.');
  }

  const assembly = assemble(layout, params);
  const { pieces } = assembly;

  // Đặt model vào giữa bàn in theo XY và cho đáy chạm mặt bàn. Phải tính hộp bao
  // trên toàn bộ các mảnh rồi dời tất cả cùng một lượng, nếu không chúng sẽ lệch
  // nhau.
  const box = new THREE.Box3().makeEmpty();
  for (const piece of pieces) {
    piece.geometry.computeBoundingBox();
    box.union(piece.geometry.boundingBox!);
  }

  const center = box.getCenter(new THREE.Vector3());
  const shift = new THREE.Vector3(-center.x, -center.y, -box.min.z);
  for (const piece of pieces) {
    piece.geometry.translate(shift.x, shift.y, shift.z);
    piece.geometry.computeBoundingBox();
  }

  return {
    pieces,
    layout,
    parts: assembly.parts,
    holeCenter: assembly.holeCenter?.clone().add(new THREE.Vector2(shift.x, shift.y)) ?? null,
    holeBlocked: assembly.holeBlocked === true,
    size: box.getSize(new THREE.Vector3()),
  };
}

/**
 * Gộp các mảnh theo **vai trò**, mỗi vai trò một khối riêng.
 *
 * Dùng để xuất mỗi màu một file: phần mềm cắt lớp nạp nhiều file rồi gán vật
 * liệu khác nhau cho từng file. Gộp hết vào một file thì mọi thứ thành một màu,
 * và riêng với khắc chìm có lấp thì chữ biến mất hẳn — chỗ lõm bị lấp phẳng mà
 * lại cùng màu với đế.
 */
export function mergeByRole(pieces: Piece[]): Array<{ role: PieceRole; geometry: THREE.BufferGeometry }> {
  const roles: PieceRole[] = ['plate', 'text', 'fill'];
  return roles.flatMap((role) => {
    const group = pieces.filter((p) => p.role === role && !p.pickOnly);
    return group.length > 0 ? [{ role, geometry: mergePieces(group) }] : [];
  });
}

/** Gộp các mảnh thành một khối duy nhất để xuất file, bỏ qua khối bắt chuột. */
export function mergePieces(pieces: Piece[]): THREE.BufferGeometry {
  const geometries = pieces.filter((p) => !p.pickOnly).map((p) => p.geometry);
  const merged = mergeGeometries(geometries, false);
  if (!merged) throw new Error('Không ghép được các khối của model.');
  merged.computeVertexNormals();
  return merged;
}

// ---------------------------------------------------------------------------

interface Assembly {
  pieces: Piece[];
  parts: THREE.Shape[];
  holeCenter: THREE.Vector2 | null;
  holeBlocked?: boolean;
}

function assemble(layout: TextLayout, params: ModelParams): Assembly {
  switch (params.mode) {
    case 'text': {
      const bars = diacriticBars(layout, params);
      const pieces = textPieces(layout, params.textDepth, params, params.bevelEnabled);
      if (bars.length > 0) pieces.push(barPiece(bars, params));

      // Không có đế thì chữ đứng thẳng trên mặt bàn.
      if (tiltAngle(params) > 0) standOnBaseline(pieces, baselineHeight(layout, params), 0);
      else dropOnto(pieces, 0);

      const ground = footprint(layout, params);
      return {
        pieces,
        parts: ground ? ground.shapes : [...layout.shapes, ...bars],
        holeCenter: null,
      };
    }

    case 'plate': {
      // Chữ dựng đứng thì phần chạm đế không còn là hình chữ nữa mà là bóng đổ
      // của nó — đế phải bám theo bóng đó, không phải theo dáng chữ.
      const ground = footprint(layout, params);
      const plate = buildPlate(
        ground ? ground.shapes : layout.shapes,
        ground ? ground.box : layout.box,
        params,
      );

      const pieces: Piece[] = [
        {
          id: PLATE_ID,
          role: 'plate',
          geometry: extrude(plate.shapes, params.plateThickness, params),
        },
      ];

      const letters = textPieces(layout, params.textDepth, params, params.bevelEnabled);

      // Chữ dựng đứng thì mỗi cái dấu thành một mảnh đứng riêng trên đế, mảnh mai
      // và dễ gãy; nối nó vào thân chữ thì cả hai đỡ nhau.
      const bars = diacriticBars(layout, params);
      if (bars.length > 0) letters.push(barPiece(bars, params));

      if (tiltAngle(params) > 0) {
        // Chữ đứng lún hẳn vào đế một đoạn, để chỗ chạm là một mặt thật chứ
        // không phải một điểm — xem `uprightSink` trong state.ts.
        standOnBaseline(
          letters,
          baselineHeight(layout, params),
          params.plateThickness - Math.max(params.uprightSink, OVERLAP),
        );
      } else {
        // Cho chân chữ lún nhẹ vào đế để hai vỏ chắc chắn dính nhau khi cắt lớp.
        dropOnto(letters, params.plateThickness - OVERLAP);
      }
      pieces.push(...letters);

      return {
        pieces,
        parts: plate.shapes,
        holeCenter: plate.holeCenter,
        holeBlocked: plate.holeBlocked,
      };
    }

    case 'deboss':
      return debossedPlate(layout, params);
  }
}

/**
 * Thanh nối giữ dấu, nếu người dùng bật.
 *
 * Chỉ có nghĩa khi các nét thật sự đứng rời: chữ nổi đơn thuần thì dấu rơi khỏi
 * bàn in, còn chữ dựng đứng thì mỗi dấu thành một mảnh mảnh mai đứng riêng trên
 * đế. Chữ nằm phẳng trên đế thì đế đã giữ hết, thêm thanh chỉ tổ làm xấu.
 */
function diacriticBars(layout: TextLayout, params: ModelParams): THREE.Shape[] {
  if (!params.connectors) return [];
  if (params.mode !== 'text' && tiltAngle(params) === 0) return [];
  return connectDiacritics(layout.pieces, params.connectorWidth);
}

/** Thanh nối là phần kéo dài của nét chữ chứ không phải đế, nên ăn theo màu chữ. */
function barPiece(bars: THREE.Shape[], params: ModelParams): Piece {
  const geometry = extrude(bars, params.textDepth, params, params.bevelEnabled);
  tilt(geometry, params);
  return { id: CONNECTOR_ID, role: 'text', geometry };
}

/** Góc dựng chữ tính bằng radian; 0 nghĩa là chữ nằm phẳng như bình thường. */
function tiltAngle(params: ModelParams): number {
  // Khắc chìm dựa vào hình chiếu của chữ xuống mặt đế; dựng chữ lên thì hình
  // chiếu chỉ còn là mấy vệt chữ nhật, khắc ra không đọc được gì.
  if (params.mode === 'deboss') return 0;
  return (Math.max(0, Math.min(params.textAngle, 90)) * Math.PI) / 180;
}

/**
 * Xoay khối chữ dựng lên quanh trục X.
 *
 * Xoay quanh gốc toạ độ nên mọi nét vẫn ăn khớp nhau. Ở góc 90°, chiều cao chữ
 * (trục Y) trở thành chiều cao thật (trục Z), còn độ dày đùn (trục Z) trở thành
 * bề dày chân chữ trên mặt đế (trục Y).
 */
function tilt(geometry: THREE.BufferGeometry, params: ModelParams): void {
  const angle = tiltAngle(params);
  if (angle > 0) geometry.rotateX(angle);
}

/**
 * Hạ khối chữ đã dựng đứng xuống cho **đường chân chữ** nằm ở cao độ `z`.
 *
 * Phải căn theo đường chân chứ không theo đáy thấp nhất của khối. Căn theo đáy
 * thì chỉ đúng cho mảnh thấp nhất, còn lại treo lơ lửng: chữ `g` thòng xuống kéo
 * cả cụm rơi theo nên chữ `A` bên cạnh treo cách đế mấy milimét, và dấu huyền —
 * vốn nằm hẳn trên cao — thì treo hơn một centimét.
 *
 * Phần thòng xuống dưới đường chân (đuôi `g`, chỗ tròn của `C`) chui vào trong
 * đế; đế đặc nên không sao, chỉ cần đủ dày. Phần kiểm tra lo việc nhắc chuyện đó.
 */
function standOnBaseline(pieces: Piece[], baselineZ: number, z: number): void {
  const shift = z - baselineZ;
  for (const piece of pieces) {
    piece.geometry.translate(0, 0, shift);
    piece.geometry.computeBoundingBox();
  }
}

/** Hạ cả nhóm xuống sao cho điểm thấp nhất của nhóm nằm đúng cao độ `z`. */
function dropOnto(pieces: Piece[], z: number): void {
  let lowest = Infinity;
  for (const piece of pieces) {
    piece.geometry.computeBoundingBox();
    lowest = Math.min(lowest, piece.geometry.boundingBox!.min.z);
  }
  if (!Number.isFinite(lowest)) return;

  for (const piece of pieces) piece.geometry.translate(0, 0, z - lowest);
}

/**
 * Cao độ đường chân chữ sau khi dựng đứng.
 *
 * Điểm chân chữ nằm ở mặt sau khối chữ (toạ độ đùn bằng 0), nên xoay quanh trục
 * ngang một góc θ đưa nó lên đúng `y·sinθ`. Nhiều dòng thì lấy dòng thấp nhất
 * làm chuẩn — đó là dòng chạm đế.
 */
function baselineHeight(layout: TextLayout, params: ModelParams): number {
  const sin = Math.sin(tiltAngle(params));
  let lowest = Infinity;
  for (const piece of layout.pieces) lowest = Math.min(lowest, piece.baselineY * sin);
  return Number.isFinite(lowest) ? lowest : 0;
}

/**
 * Bóng đổ của chữ dựng đứng xuống mặt đế. Trả về `null` khi chữ nằm phẳng —
 * lúc đó chính hình chữ đã là bóng của nó rồi.
 *
 * Mỗi nét chữ dựng lên chiếm một vệt chữ nhật: bề ngang giữ nguyên, còn bề sâu
 * là hình chiếu của khối chữ đã nghiêng. Ở góc 90° vệt đó đúng bằng độ dày đùn.
 */
function footprint(
  layout: TextLayout,
  params: ModelParams,
): { shapes: THREE.Shape[]; box: THREE.Box2 } | null {
  const angle = tiltAngle(params);
  if (angle === 0) return null;

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const depth = Math.max(params.textDepth, 0.05);

  const shapes = layout.pieces.map((piece) => {
    const b = new THREE.Box2().setFromPoints(piece.shape.getPoints(1));
    const near = b.min.y * cos - depth * sin;
    const far = b.max.y * cos;
    return new THREE.Shape([
      new THREE.Vector2(b.min.x, near),
      new THREE.Vector2(b.max.x, near),
      new THREE.Vector2(b.max.x, far),
      new THREE.Vector2(b.min.x, far),
    ]);
  });

  const box = new THREE.Box2().makeEmpty();
  for (const shape of shapes) {
    for (const point of shape.getPoints(1)) box.expandByPoint(point);
  }

  return { shapes, box };
}

/**
 * Đế có chữ khắc lõm, dựng bằng phép trừ đa giác 2D chứ không qua phép trừ khối.
 *
 * Model gồm hai lớp vỏ chồng lên nhau:
 *
 *  1. **Tấm đáy** — đế đặc, dày bằng phần còn lại dưới đáy chỗ khắc.
 *  2. **Tấm mặt** — hình đế **trừ đi** hình chữ. Đặt lên tấm đáy, phần thiếu
 *     chính là lòng chỗ khắc.
 *
 * Phép trừ 2D lo luôn phần ruột chữ: ruột của những chữ như O, A, 8 nằm ngoài
 * vùng bị trừ nên còn nguyên trong kết quả, thành những mảnh riêng nhô lên
 * ngang mặt đế. Nếu không có nó thì chữ O sẽ khắc thành một đĩa tròn đặc.
 *
 * Ở chế độ này nét chữ là chỗ lõm, không có khối nào để tia dò trúng. Nên mỗi
 * nét được phủ thêm một khối mờ mỏng chỉ dùng để bắt chuột, không xuất ra file.
 */
function debossedPlate(layout: TextLayout, params: ModelParams): Assembly {
  const plate = buildPlate(layout.shapes, layout.box, params);

  // Luôn chừa lại một lớp đáy, kể cả khi người dùng đặt độ sâu vượt độ dày đế
  // (trường hợp đó phần kiểm tra đã cảnh báo riêng).
  const depth = Math.min(params.debossDepth, params.plateThickness - MIN_DEBOSS_FLOOR);
  const floor = params.plateThickness - depth;

  const face = differenceShapes(plate.shapes, unionShapes(layout.shapes));
  const faceGeometry = extrude(face, depth + OVERLAP, params);
  faceGeometry.translate(0, 0, floor - OVERLAP);

  const pieces: Piece[] = [
    {
      id: PLATE_ID,
      role: 'plate',
      geometry: mergeAll([extrude(plate.shapes, floor, params), faceGeometry]),
    },
  ];

  // Khối chữ ở chế độ khắc chìm phục vụ hai việc, tuỳ người dùng có bật lấp hay
  // không — nhưng cả hai đều cần một khối nằm đúng chỗ lõm, nên dựng chung.
  //
  //  - **Không lấp**: khối mờ mỏng chỉ để tia dò trúng mà kéo thả, không xuất ra.
  //  - **Có lấp**: khối đặc lấp kín chỗ lõm, mặt trên bằng đúng mặt đế nên sờ
  //    vào phẳng lì. Đáy khối thò xuống dưới sàn khắc một chút để dính chắc,
  //    còn mặt trên thì tuyệt đối không được vượt lên, nếu không lại lồi ra.
  const fill = params.debossFill;
  const height = fill ? depth + OVERLAP : PICK_DEPTH;

  for (const piece of textPieces(layout, height, params, false)) {
    piece.geometry.translate(0, 0, fill ? floor - OVERLAP : floor);
    if (fill) piece.role = 'fill';
    else piece.pickOnly = true;
    pieces.push(piece);
  }

  return { pieces, parts: plate.shapes, holeCenter: plate.holeCenter };
}

/** Mỗi nét chữ thành một mảnh riêng, giữ nguyên mã định danh từ layout. */
function textPieces(
  layout: TextLayout,
  depth: number,
  params: ModelParams,
  bevel: boolean,
): Piece[] {
  return layout.pieces.map((piece) => {
    const geometry = extrude([piece.shape], depth, params, bevel);
    tilt(geometry, params);
    return { id: piece.id, role: 'text' as const, token: piece.token, geometry };
  });
}

function extrude(
  shapes: THREE.Shape[],
  depth: number,
  params: ModelParams,
  bevel = false,
): THREE.BufferGeometry {
  const total = Math.max(depth, 0.05);

  const settings: THREE.ExtrudeGeometryOptions = {
    depth: total,
    bevelEnabled: bevel,
    curveSegments: params.curveSegments,
    steps: 1,
  };

  if (bevel) {
    // Three.js đắp phần vát ra **ngoài** chiều sâu đùn, ở cả hai đầu. Người dùng
    // đặt "độ dày chữ" là muốn độ dày cuối cùng, nên phải trừ ngược phần vát ra
    // khỏi chiều sâu đùn để tổng cộng lại đúng bằng con số họ nhập.
    const thickness = Math.min(params.bevelSize, total / 2 - 0.05);
    settings.bevelThickness = thickness;
    settings.bevelSize = params.bevelSize;
    settings.bevelOffset = 0;
    settings.bevelSegments = Math.max(1, Math.round(params.curveSegments / 4));
    settings.depth = total - thickness * 2;
  }

  const geometry = new THREE.ExtrudeGeometry(shapes, settings);
  // ExtrudeGeometry gắn sẵn UV mà model in 3D không dùng tới; bỏ đi cho file
  // xuất ra nhẹ hơn và bước ghép vỏ khỏi phải khớp thêm thuộc tính.
  geometry.deleteAttribute('uv');
  return geometry;
}

function mergeAll(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) throw new Error('Không ghép được các khối của model.');
  return merged;
}
