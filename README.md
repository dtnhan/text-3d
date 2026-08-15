# Text3D

Tạo model 3D in được từ một chuỗi chữ — dùng làm logo, bảng hiệu, đồ trang trí,
móc khóa. Chạy hoàn toàn trong trình duyệt, không cần cài đặt gì.

```bash
npm install
npm run dev      # mở http://localhost:5173
```

## Có gì

- **Bốn kiểu model**: chữ nổi đơn thuần · chữ nổi trên đế · móc khóa có lỗ treo ·
  chữ khắc chìm vào đế
- **Bốn kiểu đế**: chữ nhật · bo góc · oval · **bo sát chữ** (đường bao ôm theo
  dáng chữ như hình dán)
- **Sáu hình lỗ móc khóa**: tròn · vuông · tam giác · lục giác · bán nguyệt ·
  giọt nước
- **Chèn logo / icon**: file SVG (kể cả icon vẽ bằng nét) và ảnh PNG/JPG được dò
  biên tự động
- **Thanh nối giữ dấu** — tự nối dấu mũ, dấu ngã, chấm trên chữ `i` và các chữ
  cái đứng riêng vào thành một mảnh liền, để in chữ nổi không bị rụng
- **Font tuỳ ý**: 10 font đóng gói sẵn (7 kiểu viết tay) đều đủ dấu tiếng Việt,
  cộng thêm nạp file `.ttf`/`.otf` bất kỳ từ máy (font riêng chỉ nằm trong bộ
  nhớ trình duyệt, không gửi đi đâu)
- **Xem trước 3D** xoay được, có lưới bàn in tham chiếu để ước lượng khổ; chữ và
  đế tô màu riêng, chọn được — dễ hình dung bản in hai màu, và ở chế độ khắc chìm
  thì thấy rõ chữ lõm tới đâu
- **Chỉnh tay bằng kéo thả** ngay trong khung xem: dời từng nét chữ hoặc cả một
  cụm ký tự (dấu mũ, dấu ngã, chấm trên chữ `i` đều kéo riêng được), và dời lỗ
  móc khóa
- **Xuất STL** (nhị phân, đơn vị milimét — nạp thẳng vào Cura / PrusaSlicer /
  Bambu Studio) và OBJ
- **Cảnh báo trước khi in**: mảnh rời, nét quá mảnh, vượt khổ bàn in, khắc thủng
  đế, font thiếu ký tự, lỗ móc khóa bị nét chữ che, đế bo sát bị tách mảnh

## Năm quyết định kỹ thuật đáng lưu ý

### 1. Không dùng `TextGeometry` của Three.js

`TextGeometry` chỉ đọc được định dạng `typeface.json`, buộc phải convert font
trước, và xử lý dấu tiếng Việt không đáng tin cậy. Thay vào đó
[`opentype.js`](https://opentype.js.org/) parse thẳng TTF/OTF ra đường path, rồi
`geometry/textShapes.ts` dựng thành `THREE.Shape`.

### 2. Phân biệt lỗ trong chữ bằng phép bao hàm, không bằng chiều quay

Chữ `O`, `Ô`, `8` có đường bao ngoài và đường bao lỗ. Cách thường thấy là đọc
chiều quay (winding order) để biết đâu là lỗ — nhưng **TrueType và CFF/PostScript
dùng quy ước ngược nhau**, nên cách đó sai với khoảng một nửa số font.

`geometry/textShapes.ts` đếm số đường bao **chứa** mỗi đường bao: độ sâu chẵn là
phần đặc, lẻ là lỗ. Đúng với mọi định dạng font. `npm run check` kiểm điều này
trên cả font TrueType lẫn font CFF.

### 3. Đế bo sát và thanh nối dùng chung một bộ máy

Cả hai đều quy về hai phép toán trên đa giác phẳng, làm bằng `clipper-lib`:

- **Đế bo sát chữ** = hợp các hình chữ rồi **giãn** đường bao ra `plateMargin`.
  Lề đủ lớn thì các chữ tự dính vào nhau; chưa dính thì `geometry/connectors.ts`
  dựng cây bao trùm nhỏ nhất trên tập mảnh và nối bằng thanh — vì một tấm đế rời
  làm mấy mảnh thì vô dụng. Khoảng trắng giữa hai từ hầu như luôn cần đến bước
  này.
- **Thanh nối giữ dấu** dùng đúng đoạn mã đó, chỉ khác là chạy trên hình chữ
  thay vì hình đế.

Móc khóa với đế bo sát không có chỗ đặc nào để khoan, nên lỗ treo nằm trên một
khuyên riêng nối vào thân đế (`plate.ts` → `attachRing`).

### 4. Model trả về nhiều mảnh có mã, không phải một khối

Muốn kéo thả được thì tia dò từ con trỏ phải biết nó chạm vào nét nào, nên
`buildModel` trả về danh sách mảnh có mã định danh chứ không một geometry duy
nhất; khung xem dựng mỗi mảnh thành một mesh, còn `mergePieces()` gộp lại lúc
xuất file.

Mã định danh có dạng `L<dòng>G<ký tự>S<nét>`, kèm theo chính ký tự đã sinh ra
nét đó. Chỉ số thì trượt đi khi người dùng sửa nội dung, nên khi áp lại dịch
chuyển đã lưu ta đối chiếu ký tự trước — nếu không khớp thì bỏ qua, thay vì đem
dịch chuyển của dấu mũ áp nhầm sang một chữ khác vừa trôi vào đúng vị trí đó.

Ở chế độ khắc chìm, nét chữ là chỗ **lõm** nên không có khối nào để tia dò
trúng. Mỗi nét được phủ thêm một khối mờ mỏng chỉ dùng bắt chuột, đánh dấu
`pickOnly` và bị `mergePieces()` loại ra khỏi file xuất.

### 5. Ghép nhiều vỏ kín thay vì dùng phép toán CSG

Cách hiển nhiên cho "chữ trên đế" là hợp khối bằng CSG. Đo thực tế cho thấy
`three-bvh-csg` sinh rất nhiều điểm chữ T, làm gần một nửa số cạnh chỉ thuộc một
mặt — kể cả khi chỉ hợp hai khối hộp đơn giản.

Ta ghép nhiều **vỏ kín** rời nhau vào chung một file; mọi phần mềm cắt lớp đều
tự hợp các khối chồng nhau ở từng lớp cắt. Riêng chế độ khắc chìm được dựng bằng
phép **trừ đa giác 2D** (hình đế trừ hình chữ) rồi mới đùn, chứ không trừ khối
3D — xem `geometry/build.ts`. Phép trừ 2D lo luôn phần ruột chữ: ruột của `O`,
`A`, `8` còn nguyên trong kết quả và nhô lên ngang mặt đế, thay vì bị khắc thành
một đĩa đặc.

## Cấu trúc

```
src/
├── state.ts               kiểu ModelParams, giá trị mặc định, kho phát sự kiện
├── main.ts                nối font ↔ tham số ↔ dựng hình ↔ khung xem
├── fonts/
│   ├── fontManager.ts     nạp font đóng gói sẵn và font người dùng
│   └── metrics.ts         đo chiều cao chữ hoa, dò ký tự font không có
├── graphics/
│   ├── svgShapes.ts       đọc SVG, nới nét vẽ thành khối đặc
│   ├── traceBitmap.ts     ★ dò biên ảnh raster (marching squares + giản lược)
│   └── graphicStore.ts    kho hình đã phân tích, chuẩn hoá về chiều cao đơn vị
├── geometry/
│   ├── textShapes.ts      ★ đường path glyph → THREE.Shape (thuật toán bao hàm)
│   ├── layout.ts          nhiều dòng, kerning, giãn chữ, căn lề, quy đổi ra mm
│   ├── polygon2d.ts       hợp / trừ / giãn đa giác phẳng (clipper-lib)
│   ├── holeShapes.ts      sáu hình lỗ móc khóa, đo theo vòng tròn lọt vừa
│   ├── islands.ts         gom shape thành mảnh dính liền
│   ├── connectors.ts      ★ thanh nối giữ dấu và nối các mảnh đế
│   ├── plate.ts           bốn kiểu đế + lỗ móc khóa + khuyên treo
│   └── build.ts           ★ điều phối bốn chế độ dựng
├── validate.ts            ★ cảnh báo trước khi in
├── viewer/
│   ├── scene.ts           khung xem 3D, bắt chuột, tô màu theo trạng thái
│   ├── materials.ts       màu chữ / màu đế và ánh sáng theo trạng thái
│   └── interaction.ts     ★ chọn nét / chọn cụm và logic kéo thả
├── ui/panel.ts            nối control DOM vào kho tham số
└── export/exporters.ts    xuất STL / OBJ
```

## Chèn logo, icon, hình

Nhận **SVG** (nét sắc, nên dùng) và ảnh **PNG / JPG / WebP** (dò biên tự động).
Hình chèn vào nằm bên trái chữ, đặt chiều cao bằng milimét, rồi kéo trong khung
xem để dời chỗ.

Hình chèn đi chung **đúng đường ống** với nét chữ: cùng là `THREE.Shape` phẳng
mang mã định danh, nên tự động được kéo thả, được đế bao, được khắc chìm và được
kiểm tra — không chỗ nào bên dưới cần biết mảnh này đến từ chữ hay từ file SVG.
Mã của chúng là `X<thứ tự>S<nét>`, còn nét chữ là `L<dòng>G<ký tự>S<nét>`.

Hai chỗ đáng lưu ý:

**Icon vẽ bằng nét.** Rất nhiều bộ icon phổ biến — Feather, Lucide, các bộ
"outline" của Material — không tô đặc hình nào cả, chỉ gồm những đường có
`stroke-width`. Đưa thẳng vào bộ đùn thì ra model rỗng không, và người dùng chỉ
thấy "không hiện gì" mà không hiểu vì sao. Ứng dụng **nới các đường đó ra đúng bề
rộng nét** để thành vùng đặc in được, rồi báo lại đã nới bao nhiêu nét.

**Ảnh raster.** `graphics/traceBitmap.ts` ngưỡng hoá ảnh, dò biên bằng marching
squares, rồi giản lược đường bằng Ramer–Douglas–Peucker. Ảnh có kênh trong suốt
thì xét độ đục, ảnh đục hoàn toàn thì xét độ sáng — vì logo thường là hình tối
trên nền trắng. Ảnh chụp hay ảnh nhiều màu chuyển sắc thì không ra hình sạch;
trường hợp đó ứng dụng báo lỗi kèm lời giải thích thay vì dựng ra một mớ nhiễu.

## Lỗ móc khóa

Sáu hình dạng, và **"cỡ lỗ" luôn có nghĩa là đường kính vòng tròn lớn nhất lọt
vừa lòng lỗ** — không phải bề ngang của hình.

Cách hiểu còn lại nghe tự nhiên hơn nhưng dùng thì hỏng: một lỗ tam giác bề ngang
5 mm chỉ cho lọt vòng khóa chưa tới 1.7 mm, tức là người dùng đặt 5 mm mà thực tế
xỏ không qua. Với móc khóa thì "vòng có xỏ được không" mới là câu hỏi thật.

Hệ quả: hình càng nhọn thì càng chiếm nhiều chỗ trên đế so với lỗ tròn cùng cỡ,
nên đế tự nới rộng ra theo. Mỗi hình báo về `outerRadius` — khoảng cách xa nhất
từ tâm tới mép — và `plate.ts` dùng con số đó để tính chỗ chừa vật liệu quanh lỗ.
Dùng nhầm nửa đường kính thì góc nhọn của lỗ tam giác sẽ thò hẳn ra ngoài mép đế.

**Lỗ được khoét sau cùng**, sau khi mọi phần của đế đã ghép xong (`punchHole`
trong `plate.ts`). Cách cũ — gắn lỗ vào riêng hình khuyên treo rồi mới hợp khuyên
với thân đế — hỏng ngay khi hai thứ chạm nhau: phép hợp coi vật liệu của đế là
phần đặc và trám luôn vào lòng lỗ. Khoét sau cùng thì không còn phụ thuộc thứ tự
ghép nữa.

Với **đế bo sát chữ**, khuyên treo được đặt hẳn ra ngoài thân đế rồi nối lại bằng
một thanh, chứ không cho chồng lên. Chồng lên thì chỗ dính nhau là phần giao của
khuyên với một góc nhọn của chữ — mỏng dày bao nhiêu tuỳ chữ, có khi chỉ còn một
sợi chỉ. Tách ra rồi nối thì chỗ dính luôn dày đúng bằng bề rộng thanh.

Nếu lỗ bị kéo vào giữa vùng chữ, hình học vẫn đúng như yêu cầu nhưng chữ nổi bên
trên bịt mất nó. Trường hợp này không tự sửa được nên ứng dụng **cảnh báo**.

## Màu chữ và màu đế

Hai ô chọn màu — "Màu chữ" trong nhóm *Khối chữ*, "Màu đế" trong nhóm *Đế*.

Màu **chỉ ảnh hưởng khung xem**. File STL và OBJ không mang màu; màu thật khi in
là do cuộn nhựa nạp vào máy quyết định. Dùng hai màu ở đây để hình dung trước
bản in hai màu, và để nhìn rõ chỗ khắc chìm.

Trạng thái rê chuột và đang chọn được thể hiện bằng **ánh phát sáng cộng thêm**
chứ không bằng một màu cố định — người dùng tự chọn màu nên một màu trạng thái
cố định sẽ có lúc trùng với màu họ chọn và mất hẳn tác dụng báo hiệu.

Đổi màu không dựng lại hình học: `main.ts` so bộ tham số với lần dựng trước, thấy
chỉ khác mỗi màu thì sửa vật liệu tại chỗ. Không có đường tắt này thì mỗi bước rê
của bảng chọn màu lại kéo theo một lượt dựng lại toàn bộ.

## Chỉnh tay bằng kéo thả

Rê chuột lên khung xem, nét nào kéo được sẽ sáng lên. Kéo để dời nó trong mặt
phẳng của chữ — không cho kéo theo chiều cao, vì chữ vốn phẳng. Lỗ móc khóa là
chỗ rỗng nên không bắt chuột được; nó có một chiếc khuyên màu cam nổi lên làm
tay nắm (khuyên này chỉ để thao tác, không có trong file xuất ra).

Chọn cả cụm để kéo một lượt:

| Thao tác | Kết quả |
| --- | --- |
| Bấm | chọn riêng một nét |
| **Shift** + bấm | chọn cả cụm từ nét đã bấm trước tới nét vừa bấm |
| **Ctrl** (hoặc **Cmd**) + bấm | thêm hoặc bớt một nét khỏi cụm |
| Bấm chỗ trống, hoặc **Esc** | bỏ chọn |

Nét đang chọn tô màu xanh bạc hà. Kéo bất kỳ nét nào trong cụm thì cả cụm cùng
đi, và cả cụm được ghi thành **một** thao tác chứ không phải mỗi nét một lần.

Chọn cụm luôn lấy **trọn ký tự** ở hai đầu: người dùng nghĩ theo đơn vị chữ chứ
không theo từng đường bao, nên chọn được nửa cái dấu mũ của chữ `Ô` là vô nghĩa.

**Ctrl+Z** hoàn tác, **Ctrl+Shift+Z** (hoặc **Ctrl+Y**) làm lại. Chồng lịch sử
chỉ quản phần chỉnh tay — không gồm font, cỡ chữ hay các thông số khác. Những
thứ đó đã có ô nhập ngay trước mắt để sửa lại, còn một cú kéo lỡ tay thì không
có cách nào lấy lại ngoài hoàn tác; gộp cả hai vào một chồng sẽ khiến Ctrl+Z lúc
thì lùi vị trí chữ, lúc thì lùi cỡ chữ. Khi con trỏ đang ở trong ô nhập chữ thì
phím tắt nhường lại cho trình duyệt hoàn tác nội dung ô đó.

Dịch chuyển được làm tròn về 0.05 mm và **cộng thêm** vào vị trí do tham số quy
định, nên chỉnh font hay cỡ chữ xong thì phần kéo tay vẫn còn nguyên. Nút **Bỏ
hết chỉnh tay** đưa mọi thứ về đúng những gì các tham số quy định.

## Về dấu tiếng Việt khi in

Dấu (`ầ`, `ể`, `ữ`…) là những đường bao **tách rời** khỏi thân chữ, y như dấu
chấm trên chữ `i`. Ở chế độ chữ nổi đơn thuần, chúng in ra thành từng mảnh riêng
và rơi khỏi bàn in. Ứng dụng phát hiện và cảnh báo việc này. Khi thấy cảnh báo,
chọn một trong hai cách:

- bật **Thanh nối giữ dấu** — thêm những thanh nhỏ nối dấu vào thân chữ và nối
  các chữ với nhau, giữ nguyên dáng chữ nổi;
- hoặc chuyển sang chế độ có đế (**Chữ nổi trên đế**, **Móc khóa**).

## Kiểm tra

```bash
npm run typecheck
npm run check     # 448 phép kiểm, ghi STL mẫu ra .check-output/
npm run build
```

`npm run check` chạy pipeline dựng hình **ngoài trình duyệt** — script được Vite
đóng gói rồi mới chạy bằng Node, nên dùng đúng cơ chế phân giải module như bản
chạy thật. Nó dựng 4 chế độ × 10 font, cộng các phép kiểm riêng cho từng tính
năng:

- **lưới kín** — mọi cạnh thuộc đúng hai tam giác, sau khi đã hoá giải các điểm
  chữ T (xem `scripts/meshCheck.ts` giải thích vì sao phải phân biệt)
- **đúng kích thước** — chữ cao đúng số mm đã đặt, độ dày khớp từng chế độ, đáy
  nằm đúng tại Z = 0
- **lỗ móc khóa xuyên suốt** — bắn tia thẳng đứng qua tâm lỗ, không được gặp
  vật liệu nào
- **vòng khóa đúng cỡ lọt vừa** — với cả sáu hình lỗ và cả hai kiểu đế, dò 16
  hướng quanh mép vòng tròn cỡ đã đặt, chỗ nào cũng phải rỗng
- **lỗ nằm gọn trong vật liệu** — dò 16 hướng ngay ngoài mép lỗ, chỗ nào cũng
  phải còn vật liệu, tức lỗ không ăn thủng ra ngoài mép đế
- **chỗ khắc chìm có lõm thật** và **chữ có nổi trên đế** — so thể tích giữa hai
  bộ tham số chỉ khác nhau một chút
- **kéo nét chữ dời đúng khoảng cách** — đo trên khoảng cách giữa hai nét chứ
  không phải vị trí tuyệt đối, vì model được căn tâm lại sau mỗi lần dựng
- **đổi nội dung thì bỏ qua dịch chuyển đã lưu** của chữ cũ
- **chọn cụm lấy trọn ký tự** ở hai đầu, và kéo cụm dời mọi nét đi cùng một
  khoảng trong khi nét ngoài cụm đứng yên
- **hoàn tác / làm lại** — lùi đúng một thao tác chứ không lùi hết, về đúng vị
  trí ban đầu khi lùi hết, và thao tác mới thì xoá nhánh làm lại
- **vai trò từng mảnh** — đúng một mảnh mang vai trò đế, thanh nối ăn theo màu
  chữ, và **đổi màu không làm đổi hình học** (điều kiện để đường tắt kia đúng)
- **kéo lỗ móc khóa** — lỗ thủng ở chỗ mới, chỗ cũ liền lại
- **lỗ vẫn thủng dù kéo đi đâu** — 2 kiểu đế × 5 mức kéo, dò 12 hướng quanh lòng
  lỗ trên riêng tấm đế
- **cảnh báo khi lỗ bị nét chữ che**, và không báo nhầm khi lỗ ở chỗ trống
- **khối bắt chuột không lọt vào file xuất ra**
- **thanh nối gộp chữ về một mảnh** — `Đà Nẵng` từ 9 mảnh rời còn đúng 1
- **đế bo sát liền một mảnh** và tốn ít vật liệu hơn hẳn đế chữ nhật cùng lề
- **lỗ trên khuyên treo của đế bo sát vẫn thông**, thanh nối không bịt mất lỗ
- **có cảnh báo mảnh rời** với chuỗi tiếng Việt ở chế độ chữ nổi
- **STL xuất ra khớp số tam giác** với geometry
- **hình chèn** — SVG tô đặc nhận đúng lỗ bên trong, SVG vẽ nét được nới thành
  khối, ảnh raster dò được cả lỗ, hình cao đúng số mm đã đặt, và ở cả bốn chế độ
  thì hình làm model rộng ra mà lưới vẫn kín

## Giấy phép

Mã nguồn theo giấy phép MIT (xem `LICENSE`). Font trong `public/fonts/` **không**
thuộc giấy phép đó — chúng theo SIL Open Font License 1.1, bản gốc của từng font
nằm trong `public/fonts/licenses/`.

## Font đóng gói sẵn

Tất cả đều theo SIL Open Font License và **đủ bộ dấu tiếng Việt** — điều này
được kiểm bằng chương trình chứ không tin theo mô tả của nhà phát hành. Con số
"nét mảnh nhất" đo ở chiều cao chữ hoa 20 mm; dưới 0.8 mm thì ứng dụng sẽ cảnh
báo, và cách xử lý là tăng chiều cao chữ lên.

| Font | Kiểu | Nét mảnh nhất |
| --- | --- | --- |
| Be Vietnam Pro Bold / Regular | không chân, thiết kế riêng cho tiếng Việt | dày |
| Source Sans 3 Bold | không chân, dạng CFF/OTF | dày |
| Patrick Hand | viết tay, nét dày — in bền nhất trong nhóm viết tay | 1.68 mm |
| Lobster | viết tay, nét đậm | dày |
| Pacifico | viết tay, tròn trịa | dày |
| Charm | viết tay, mảnh mai | 1.13 mm |
| Dancing Script | viết tay, thanh thoát | 0.91 mm |
| Playball | viết tay, kiểu bảng hiệu | 0.86 mm |
| Great Vibes | thư pháp, rất mảnh | 0.72 mm |

Trong quá trình sàng lọc có bảy font phải loại vì thiếu dấu tiếng Việt dù mang
tiếng hỗ trợ Latin mở rộng (Caveat, Courgette, Kaushan Script, Grand Hotel,
Berkshire Swash, Sacramento, Cookie đều thiếu `Ơ Ư ơ ư` và toàn bộ dấu
hỏi/ngã/nặng), thêm một font loại vì nét quá mảnh (Merienda, 0.70 mm).

### Font bạn tự nạp

Chiều cao chữ hoa quyết định mọi kích thước, mà không phải font nào cũng khai
đúng con số đó. Courgette chẳng hạn khai 0.147 em — tin theo thì chuỗi chữ đặt
cao 20 mm sẽ bị phóng thành hơn một mét. Nên `fonts/metrics.ts` chỉ nhận số font
khai khi nó nằm trong khoảng hợp lý (0.45–1.0 em), còn không thì tự đo chữ `H`.
