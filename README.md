# ⚡ FileZap — GitHub File Transfer Bridge

> Chuyển file từ iPhone → PC qua GitHub. Không cần app, không cần login trên PC.

![FileZap](https://img.shields.io/badge/FileZap-v2.0-6c63ff?style=flat-square)
![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-live-43e97b?style=flat-square)

---

## 🎯 Cách hoạt động

```
📱 iPhone  →  Web UI (GitHub Pages)  →  GitHub API  →  /uploads/
💻 PC      →  Web UI (GitHub Pages)  →  Xem & Tải
```

---

## 🚀 Setup (5 phút)

### 1. Fork / Clone repo này

```bash
git clone https://github.com/USERNAME/file-transfer-app
```

### 2. Tạo GitHub Token

- Vào [Settings → Tokens](https://github.com/settings/tokens)
- **Tokens (classic)** → Generate new token
- Quyền: ✅ `repo`
- Copy token (dạng `ghp_xxxxx`)

### 3. Bật GitHub Pages

- Vào repo → **Settings → Pages**
- Source: **Deploy from branch → main → / (root)**
- Save

### 4. Mở web và cấu hình

- Vào `https://USERNAME.github.io/file-transfer-app`
- Nhập username, repo name, token
- ✅ Xong!

---

## 📁 Cấu trúc repo

```
/
├── index.html          # Giao diện web
├── style.css           # CSS mobile app
├── app.js              # Logic upload/download
├── uploads/            # Thư mục chứa file (tự tạo)
└── .github/
    └── workflows/
        ├── upload.yml  # Xử lý upload qua Issues API (legacy)
        └── cleanup.yml # Tự xóa file > 5 ngày
```

---

## 🔒 Bảo mật

| Điểm | Chi tiết |
|------|----------|
| Token | Lưu trong `localStorage` trình duyệt, không lên server |
| Upload | Gọi trực tiếp GitHub Contents API (HTTPS) |
| File | Tự xóa sau 5 ngày |
| Filename | Sanitize tự động (loại bỏ ký tự nguy hiểm) |
| Rate limit | Anti-spam: delay 10s giữa các lần upload |
| Max size | 5MB/file (giới hạn GitHub API) |

---

## ⚠️ Giới hạn

- File tối đa **5MB** (GitHub API limit)
- Repo public → file có thể xem được (dùng repo private nếu cần)
- Token lưu local → không dùng trên máy công cộng

---

## 🛠 Nâng cấp gợi ý

- [ ] Upload file lớn hơn (dùng Git LFS)
- [ ] Mã hóa file trước khi upload
- [ ] Share link tạm thời (expired link)
- [ ] PWA (cài được trên homescreen)
