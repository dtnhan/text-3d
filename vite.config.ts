import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { open: true },
  build: { target: 'es2023' },
  ssr: {
    // Script kiểm tra ở scripts/ được đóng gói qua Vite rồi mới chạy bằng Node,
    // để nó dùng đúng cơ chế phân giải module như bản chạy trong trình duyệt.
    // Gói kèm luôn các thư viện vì entry mặc định của opentype.js là CommonJS,
    // mà Node không tách được named export từ đó.
    noExternal: true,
  },
});
