# Sổ Nhật Ký Công Việc — bản chạy độc lập (không cần Claude)

Ứng dụng gồm 2 phần:
- **server.js** — máy chủ Node.js/Express, cung cấp API và lưu dữ liệu vào PostgreSQL
- **public/index.html** — giao diện web (tự động gọi API của server ở trên)

Dữ liệu (tài khoản, mật khẩu, nhật ký) được lưu **thật sự và lâu dài** trong cơ sở dữ liệu PostgreSQL, dùng chung cho tất cả mọi người truy cập — không phụ thuộc vào Claude.

---

## Cách 1 — Deploy tự động bằng "Blueprint" (khuyên dùng, nhanh nhất)

1. Tạo một repository mới trên GitHub, tải toàn bộ các file trong thư mục này lên (kéo-thả trên GitHub web cũng được, không cần biết dùng lệnh `git`).
2. Vào https://dashboard.render.com → bấm **New +** → chọn **Blueprint**.
3. Chọn repository GitHub bạn vừa tạo. Render sẽ tự đọc file `render.yaml` và tạo sẵn:
   - Một **Web Service** (server chạy ứng dụng)
   - Một **PostgreSQL database** miễn phí, đã tự nối vào server (biến `DATABASE_URL`)
   - Một chuỗi bí mật `JWT_SECRET` được tạo ngẫu nhiên tự động
4. Bấm **Apply** / **Deploy**. Chờ khoảng 2-3 phút để build xong.
5. Khi xong, Render cho bạn một đường dẫn dạng `https://so-nhat-ky-cong-viec.onrender.com` — mở link đó là dùng được, đăng nhập lần đầu bằng:
   - Tên đăng nhập: `admin`
   - Mật khẩu: `admin123`
   → Đổi mật khẩu ngay (nút chìa khoá ở góc trên bên phải) và vào "Quản lý người dùng" để tạo tài khoản cho từng cán bộ.

## Cách 2 — Deploy thủ công (nếu Blueprint không khả dụng)

1. Tải code lên GitHub như trên.
2. Trên Render: **New +** → **PostgreSQL** → đặt tên bất kỳ → chọn gói **Free** → Create Database. Sau khi tạo xong, vào trang database, copy giá trị **Internal Database URL**.
3. **New +** → **Web Service** → chọn repository GitHub → giữ nguyên:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Chọn gói **Free**
4. Vào tab **Environment** của Web Service, thêm 2 biến:
   - `DATABASE_URL` = (giá trị Internal Database URL đã copy ở bước 2)
   - `JWT_SECRET` = một chuỗi bất kỳ, càng dài càng khó đoán (ví dụ dùng https://randomkeygen.com để tạo)
5. Bấm **Deploy**. Chờ xong rồi mở link Render cấp cho bạn.

---

## Lưu ý quan trọng

- **Free PostgreSQL trên Render chỉ tồn tại 30 ngày** (có 14 ngày gia hạn), sau đó bị xoá nếu không nâng cấp. Nếu định dùng lâu dài cho công ty, hãy nâng cấp database lên gói trả phí rẻ nhất (khoảng 6-7 USD/tháng) **trước khi hết hạn**, để không bị mất dữ liệu.
- **Web Service miễn phí sẽ "ngủ"** sau 15 phút không có ai truy cập, và mất khoảng 30-60 giây để "thức dậy" ở lượt truy cập kế tiếp. Nếu muốn máy chủ luôn sẵn sàng (không có độ trễ này), nâng cấp Web Service lên gói Starter (khoảng 7 USD/tháng).
- Mật khẩu người dùng được **mã hoá (hash)** trước khi lưu vào database (dùng bcrypt) — an toàn hơn nhiều so với bản demo chạy trong Claude trước đây.
- Tài khoản `admin/admin123` chỉ được tạo **một lần duy nhất** khi database còn trống. Hãy đổi mật khẩu ngay sau lần đăng nhập đầu tiên.

## Chạy thử trên máy cá nhân (tuỳ chọn, dành cho người biết kỹ thuật)

```bash
npm install
cp .env.example .env   # rồi sửa DATABASE_URL trỏ tới một PostgreSQL đang chạy sẵn trên máy
npm start
```
Mở trình duyệt tại `http://localhost:3000`.
