/**
 * Xếp chuỗi text thành danh sách THREE.Shape đặt đúng vị trí, đơn vị milimét.
 *
 * Mọi phép tính bố cục chạy trong **đơn vị em** (kích thước em = 1), chỉ nhân
 * hệ số quy đổi ra milimét ở bước cuối. Nhờ vậy các ngưỡng sai số trong
 * `textShapes.ts` giữ nguyên ý nghĩa bất kể người dùng đặt chữ to hay nhỏ.
 *
 * Mỗi nét chữ được gắn một mã định danh dạng `L<dòng>G<ký tự>S<nét>`. Một ký tự
 * có thể cho ra nhiều nét: `ầ` gồm thân chữ, dấu mũ và dấu huyền — ba đường bao
 * tách rời, ba mã khác nhau. Nhờ vậy người dùng kéo được riêng cái dấu mũ.
 *
 * Chữ có thể được xếp theo hình — vòng tròn, ô vuông, lượn sóng. Việc đó làm
 * sau khi đã xếp thẳng: mỗi chữ được xoay và dời tới đúng chỗ trên đường, giữ
 * nguyên dáng chữ. Xem `textPath.ts` giải thích vì sao không bẻ cong nét.
 *
 * Hình chèn thêm (logo, icon) đi chung đúng đường ống này, mã dạng
 * `X<thứ tự>S<nét>`. Nhờ vậy chúng tự động được kéo thả, được đế bao, được khắc
 * chìm và được kiểm tra — không chỗ nào bên dưới cần biết mảnh này đến từ chữ
 * hay từ một file SVG.
 */

import * as THREE from 'three';
import type { Font, Glyph } from 'opentype.js';
import { pathToShapes, type PathCommand } from './textShapes';
import { TextPath } from './textPath';
import type { LoadedFont } from '../fonts/fontManager';
import type { GraphicStore } from '../graphics/graphicStore';
import type { ModelParams } from '../state';

/** Một mảnh phẳng của model: một đường bao đặc, kèm mã định danh để chỉnh tay. */
export interface TextPiece {
  id: string;
  /**
   * Thứ đã sinh ra mảnh này — ký tự với nét chữ, mã hình với hình chèn. Dùng để
   * kiểm tra dịch chuyển đã lưu có còn đúng chỗ không.
   */
  token: string;
  shape: THREE.Shape;
  /**
   * Cao độ đường chân chữ của mảnh này (mm).
   *
   * Không suy ra được từ hộp bao: chữ `g` thòng xuống dưới đường chân, chữ `C`
   * tròn cũng thò xuống một chút, còn dấu huyền thì nằm hẳn trên cao. Muốn dựng
   * chữ đứng cho đúng thì phải biết đường chân thật sự nằm đâu.
   */
  baselineY: number;
}

export interface TextLayout {
  pieces: TextPiece[];
  /** Các shape của `pieces`, tách riêng cho tiện dùng ở những chỗ không cần mã. */
  shapes: THREE.Shape[];
  /** Hộp bao 2D của toàn bộ chữ (mm). */
  box: THREE.Box2;
  /** Số ký tự có hình (bỏ qua dấu cách) — dùng cho phần kiểm tra. */
  glyphCount: number;
}

const EMPTY: TextLayout = {
  pieces: [],
  shapes: [],
  box: new THREE.Box2(new THREE.Vector2(), new THREE.Vector2()),
  glyphCount: 0,
};

export function layoutText(
  loaded: LoadedFont,
  params: ModelParams,
  graphics?: GraphicStore,
): TextLayout {
  const { font, capHeightEm } = loaded;

  // Chuẩn hoá về dạng tổ hợp sẵn: chữ tiếng Việt dán từ macOS thường ở dạng tách
  // rời (`e` + dấu mũ riêng), mà tra glyph theo từng ký tự thì dạng đó cho ra
  // dấu chồng đè lên nhau ở sai chỗ.
  const lines = params.text.normalize('NFC').split('\n');
  if (lines.every((line) => line.trim() === '')) return EMPTY;

  // Chiều cao chữ hoa là mốc vật lý người dùng đặt, nên hệ số quy đổi tính từ nó.
  const mmPerEm = params.capHeight / capHeightEm;
  const letterSpacingEm = (params.letterSpacing / 100) * capHeightEm;
  const lineStepEm = params.lineHeight * capHeightEm;

  // Lượt 1: đo bề rộng từng dòng để biết cách căn lề.
  const measured = lines.map((line) => measureLine(font, line, letterSpacingEm));
  const maxWidth = Math.max(...measured.map((m) => m.width));

  // Lượt 2: dựng shape tại vị trí đã tính.
  const pieces: TextPiece[] = [];
  let glyphCount = 0;

  // Lượt 2a: dựng chữ ở dạng thẳng, ghi lại tâm ngang của từng chữ. Tâm đó
  // chính là chỗ đặt chữ lên đường khi xếp theo hình.
  const flat: Array<{
    id: string;
    token: string;
    shape: THREE.Shape;
    centerX: number;
    baseline: THREE.Vector2;
  }> = [];

  measured.forEach((line, lineIndex) => {
    let penX = alignOffset(params.align, line.width, maxWidth);
    // getPath nhận toạ độ theo trục Y hướng xuống, còn commandsToContours lật
    // dấu Y. Nên muốn dòng thứ i tụt xuống thì truyền y dương tăng dần.
    const penY = lineIndex * lineStepEm;

    line.items.forEach((item, glyphIndex) => {
      const commands = item.glyph.getPath(penX, penY, 1).commands as PathCommand[];
      const shapes = pathToShapes(commands, params.curveSegments, mmPerEm);
      const centerX = (penX + item.advance / 2) * mmPerEm;

      // Đường chân chữ của dòng này, trong cùng hệ toạ độ với hình chữ.
      const baselineY = -penY * mmPerEm;

      shapes.forEach((shape, shapeIndex) => {
        flat.push({
          id: `L${lineIndex}G${glyphIndex}S${shapeIndex}`,
          token: item.char,
          shape,
          centerX,
          baseline: new THREE.Vector2(centerX, baselineY),
        });
      });

      if (shapes.length > 0) glyphCount++;
      penX += item.advance;
    });
  });

  // Lượt 2b: uốn theo hình, rồi mới áp dịch chuyển kéo tay.
  //
  // Thứ tự này quan trọng. Người dùng kéo chữ trong khung xem, tức là kéo trên
  // hình **đã uốn**; nếu cộng dịch chuyển vào trước rồi mới uốn thì chính đoạn
  // dịch chuyển đó cũng bị uốn theo, và chữ chạy lệch khỏi chỗ vừa thả.
  const path = TextPath.create(params, maxWidth * mmPerEm);
  if (path) warpToPath(flat, path);

  for (const item of flat) {
    applyOffset(item.shape, item.id, item.token, params);
    pieces.push({
      id: item.id,
      token: item.token,
      shape: item.shape,
      baselineY: item.baseline.y,
    });
  }

  placeGraphics(pieces, params, graphics);
  if (pieces.length === 0) return EMPTY;

  // Căn tâm quanh gốc toạ độ để model luôn nằm giữa bàn in.
  const shapes = pieces.map((piece) => piece.shape);
  const box = shapesBox(shapes);
  const center = box.getCenter(new THREE.Vector2());
  translateShapes(shapes, -center.x, -center.y);
  box.translate(new THREE.Vector2(-center.x, -center.y));
  for (const piece of pieces) piece.baselineY -= center.y;

  return { pieces, shapes, box, glyphCount };
}

/**
 * Đặt từng chữ lên đường: xoay theo hướng đường tại chỗ đó rồi dời tới.
 *
 * Toạ độ trong chữ được đọc lại theo hệ của điểm đặt — `x` tính từ tâm chữ đo
 * dọc đường, `y` giữ nguyên là chiều cao so với đường chân chữ. Nhờ vậy nhiều
 * dòng cũng chạy được: dòng dưới có `y` âm hơn nên nằm phía trong vòng tròn,
 * thành ra các dòng xếp thành những vòng đồng tâm.
 */
function warpToPath(
  items: Array<{ shape: THREE.Shape; centerX: number; baseline: THREE.Vector2 }>,
  path: TextPath,
): void {
  // Căn giữa khối chữ trước, để mốc giữa của đường rơi vào giữa chữ.
  const flatBox = shapesBox(items.map((item) => item.shape));
  const shift = flatBox.getCenter(new THREE.Vector2()).x;

  for (const item of items) {
    const anchor = item.centerX - shift;
    const { point, tangent, normal } = path.frameAt(anchor);

    const map = (points: THREE.Vector2[]) =>
      points.map((p) => {
        const along = p.x - shift - anchor;
        return new THREE.Vector2(
          point.x + tangent.x * along + normal.x * p.y,
          point.y + tangent.y * along + normal.y * p.y,
        );
      });

    const outer = map(item.shape.getPoints(1));
    const holes = item.shape.holes.map((hole) => new THREE.Path(map(hole.getPoints(1))));

    const shaped = new THREE.Shape(outer);
    shaped.holes = holes;
    item.shape = shaped;

    // Điểm chân chữ đi qua đúng phép biến đổi ấy, nếu không thì sau khi uốn nó
    // sẽ chỉ đường chân sai chỗ.
    item.baseline = map([item.baseline])[0];
  }
}

/**
 * Xếp các hình chèn thành một hàng bên trái khối chữ, cao ngang giữa chữ.
 *
 * Đặt bên trái vì đó là chỗ quen thuộc cho logo đứng trước tên. Vị trí này chỉ
 * là điểm khởi đầu — người dùng kéo hình đi đâu tuỳ ý, và dịch chuyển đó được
 * ghi lại y như với nét chữ.
 */
function placeGraphics(
  pieces: TextPiece[],
  params: ModelParams,
  graphics?: GraphicStore,
): void {
  if (!graphics || params.graphics.length === 0) return;

  const textBox = shapesBox(pieces.map((piece) => piece.shape));
  const centerY = pieces.length > 0 ? textBox.getCenter(new THREE.Vector2()).y : 0;
  // Khoảng hở giữa hình và chữ, lấy theo cỡ chữ để tỉ lệ luôn trông hợp lý.
  const gap = params.capHeight * 0.35;

  // Xếp từ phải sang trái để hình đầu danh sách nằm sát chữ nhất.
  let right = pieces.length > 0 ? textBox.min.x - gap : 0;

  for (let index = params.graphics.length - 1; index >= 0; index--) {
    const ref = params.graphics[index];
    const loaded = graphics.get(ref.id);
    if (!loaded) continue;

    const height = Math.max(ref.height, 0.1);
    const width = height * loaded.aspect;
    const centerX = right - width / 2;
    right -= width + gap;

    loaded.shapes.forEach((shape, shapeIndex) => {
      const placed = scaleShape(shape, height, centerX, centerY);
      const id = `X${index}S${shapeIndex}`;
      applyOffset(placed, id, ref.id, params);
      // Hình chèn không có đường chân chữ; lấy mép dưới của nó làm chân.
      pieces.push({
        id,
        token: ref.id,
        shape: placed,
        baselineY: centerY - height / 2,
      });
    });
  }
}

/** Hình đã chuẩn hoá cao 1 đơn vị quanh gốc; phóng lên rồi dời tới chỗ cần đặt. */
function scaleShape(
  shape: THREE.Shape,
  height: number,
  centerX: number,
  centerY: number,
): THREE.Shape {
  const apply = (points: THREE.Vector2[]) =>
    points.map((p) => new THREE.Vector2(p.x * height + centerX, p.y * height + centerY));

  const result = new THREE.Shape(apply(shape.getPoints(1)));
  result.holes = shape.holes.map((hole) => new THREE.Path(apply(hole.getPoints(1))));
  return result;
}

/**
 * Áp dịch chuyển do người dùng kéo tay, nếu có và nếu vẫn đúng nguồn cũ.
 *
 * Mã định danh dựa trên chỉ số, mà chỉ số thì trượt khi người dùng thêm bớt chữ
 * hay thêm bớt hình. Đối chiếu `token` để dịch chuyển đã lưu không bị áp nhầm
 * sang một mảnh khác vừa trôi vào đúng vị trí ấy.
 */
export function applyOffset(
  shape: THREE.Shape,
  id: string,
  token: string,
  params: ModelParams,
): void {
  const offset = params.partOffsets[id];
  if (!offset || offset.token !== token) return;

  // Chữ dựng đứng thì trục dọc của bố cục trở thành **chiều cao** sau khi xoay,
  // nên cộng phần dọc vào đây sẽ nhấc chữ lơ lửng khỏi đế chứ không dời nó theo
  // hướng người dùng kéo. Trục ngang thì không bị xoay đụng tới, vẫn đúng.
  const upright = params.textAngle > 0 && params.mode !== 'deboss';
  translateShapes([shape], offset.dx, upright ? 0 : offset.dy);
}

// ---------------------------------------------------------------------------

interface LineItem {
  glyph: Glyph;
  char: string;
  /** Bước tiến con trỏ sau ký tự này, đơn vị em (đã gồm kerning và giãn chữ). */
  advance: number;
}

interface MeasuredLine {
  items: LineItem[];
  width: number;
}

function measureLine(font: Font, line: string, letterSpacingEm: number): MeasuredLine {
  if (line === '') return { items: [], width: 0 };

  const unitsPerEm = font.unitsPerEm || 1000;
  // Duyệt theo điểm mã chứ không theo đơn vị mã, để ký tự ngoài mặt phẳng cơ bản
  // (emoji chẳng hạn) không bị cắt đôi.
  const chars = [...line];
  const items: LineItem[] = [];
  let width = 0;

  const glyphs = chars.map((char) => font.charToGlyph(char));

  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    let advance = (glyph.advanceWidth ?? 0) / unitsPerEm;

    const next = glyphs[i + 1];
    if (next) {
      advance += font.getKerningValue(glyph, next) / unitsPerEm;
      advance += letterSpacingEm;
    }

    items.push({ glyph, char: chars[i], advance });
    width += advance;
  }

  // Bề rộng dòng không tính phần giãn chữ thừa sau ký tự cuối (đã loại ở trên),
  // nhưng vẫn gồm cả side bearing của glyph cuối — đủ chính xác để căn lề.
  return { items, width };
}

function alignOffset(align: ModelParams['align'], lineWidth: number, maxWidth: number): number {
  switch (align) {
    case 'center':
      return (maxWidth - lineWidth) / 2;
    case 'right':
      return maxWidth - lineWidth;
    case 'left':
      return 0;
  }
}

/** Hộp bao của một tập shape, tính trên điểm đã tam giác hoá của đường bao ngoài. */
export function shapesBox(shapes: THREE.Shape[]): THREE.Box2 {
  const box = new THREE.Box2();
  box.makeEmpty();
  for (const shape of shapes) {
    for (const p of shape.getPoints(1)) box.expandByPoint(p);
  }
  return box;
}

function translateShapes(shapes: THREE.Shape[], dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const shape of shapes) {
    translatePath(shape, dx, dy);
    for (const hole of shape.holes) translatePath(hole, dx, dy);
  }
}

/**
 * Dời một đường path. Các shape ở đây được dựng từ danh sách điểm nên chỉ chứa
 * LineCurve — dời hai đầu mút của từng đoạn là đủ.
 */
function translatePath(path: THREE.Path, dx: number, dy: number): void {
  for (const curve of path.curves) {
    const line = curve as THREE.LineCurve;
    line.v1.x += dx;
    line.v1.y += dy;
    line.v2.x += dx;
    line.v2.y += dy;
  }
  if (path.currentPoint) {
    path.currentPoint.x += dx;
    path.currentPoint.y += dy;
  }
}
