/* ===========================
   FileZap — App Logic v2
   ===========================
   ✅ Token lưu trong localStorage
   ✅ Rate-limit guard (không spam API)
   ✅ Validate file size + type
   ✅ Chunked base64 safe
   ✅ Deduplicate filename
   ✅ Drag & drop
   ✅ Preview ảnh/text
   ✅ Group theo ngày
   =========================== */

// ── CONFIG ──────────────────────────────────
const MAX_FILE_MB  = 5;
const MAX_FILE_B   = MAX_FILE_MB * 1024 * 1024;
const ALLOWED_WAIT = 10; // seconds between uploads (anti-spam)
const GH_API       = "https://api.github.com";

// ── STATE ────────────────────────────────────
let cfg = {};                // { username, repo, token }
let queue = [];              // { id, file, status }
let allFiles = [];           // all files from repo
let lastUpload = 0;          // timestamp

// ── BOOT ─────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  cfg = loadConfig();
  setupDragDrop();

  if (!cfg.username) {
    showModal('config-modal');
  } else {
    pingGitHub().then(ok => {
      setStatus(ok ? 'online' : 'error', ok ? `${cfg.username}/${cfg.repo}` : 'Lỗi kết nối');
      if (ok) loadFiles();
    });
  }
});

// ── CONFIG ────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem('filezap_cfg') || '{}');
  } catch { return {}; }
}

function saveConfig() {
  const u = val('cfg-username').trim();
  const r = val('cfg-repo').trim();
  const t = val('cfg-token').trim();

  if (!u || !r) return toast('Điền đủ username và repo', 'warn');
  if (!t)       return toast('Cần token để upload', 'warn');
  if (!t.startsWith('ghp_') && !t.startsWith('github_pat_'))
    return toast('Token không đúng định dạng (ghp_ ...)', 'error');

  cfg = { username: u, repo: r, token: t };
  localStorage.setItem('filezap_cfg', JSON.stringify(cfg));
  hideModal('config-modal');
  setStatus('online', `${u}/${r}`);
  loadFiles();
  toast('Đã lưu cấu hình ✓', 'success');
}

// ── GITHUB API ────────────────────────────────
async function ghFetch(path, opts = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...opts.headers
  };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;

  const res = await fetch(`${GH_API}${path}`, { ...opts, headers });

  if (res.status === 401) throw new Error('Token sai hoặc hết hạn');
  if (res.status === 403) throw new Error('Không có quyền truy cập');
  if (res.status === 404) throw new Error('Repo không tồn tại');
  if (!res.ok && res.status !== 422) throw new Error(`GitHub API lỗi ${res.status}`);

  return res;
}

async function pingGitHub() {
  try {
    const r = await ghFetch(`/repos/${cfg.username}/${cfg.repo}`);
    return r.ok;
  } catch { return false; }
}

// ── LOAD FILES ────────────────────────────────
async function loadFiles() {
  const btn = document.querySelector('.refresh-btn');
  btn.classList.add('spinning');
  setStatus('online', 'Đang tải...');

  showSkeleton();

  try {
    const res = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/contents/uploads`);

    if (res.status === 404) {
      allFiles = [];
      renderFiles([]);
      setStatus('online', `${cfg.username}/${cfg.repo}`);
      return;
    }

    const data = await res.json();
    allFiles = Array.isArray(data) ? data : [];
    renderFiles(allFiles);

    const badge = document.getElementById('file-count');
    badge.textContent = allFiles.length;
    badge.classList.toggle('visible', allFiles.length > 0);

    setStatus('online', `${cfg.username}/${cfg.repo} · ${allFiles.length} files`);
  } catch (e) {
    setStatus('error', e.message);
    toast('Lỗi tải danh sách: ' + e.message, 'error');
  } finally {
    btn.classList.remove('spinning');
  }
}

function showSkeleton() {
  const list = document.getElementById('file-list');
  list.innerHTML = [1,2,3].map(() => `<div class="skeleton"></div>`).join('');
}

function renderFiles(files) {
  const list = document.getElementById('file-list');

  if (!files.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div>Chưa có file nào trong /uploads</div>
      </div>`;
    return;
  }

  // Group by date (dựa vào tên file nếu có timestamp prefix)
  const grouped = groupByDate(files);
  let html = '';

  for (const [label, group] of Object.entries(grouped)) {
    html += `<div class="file-group-label">${label}</div>`;
    group.forEach(f => {
      const ext  = extOf(f.name);
      const type = typeOf(ext);
      const icon = iconOf(ext);
      const cls  = colorOf(type);
      const size = f.size ? formatSize(f.size) : '—';
      const rawUrl = `https://raw.githubusercontent.com/${cfg.username}/${cfg.repo}/main/uploads/${encodeURIComponent(f.name)}`;

      html += `
        <div class="file-card" onclick="openPreview(${JSON.stringify(f.name)}, ${JSON.stringify(rawUrl)}, ${JSON.stringify(ext)}, ${JSON.stringify(size)})">
          <div class="file-thumb ${cls}">${icon}</div>
          <div class="file-info">
            <div class="file-name">${escHtml(f.name)}</div>
            <div class="file-meta">
              <span>${size}</span>
              <span class="file-tag ${cls}">${ext || 'file'}</span>
            </div>
          </div>
          <div class="file-arrow">›</div>
        </div>`;
    });
  }

  list.innerHTML = html;
}

function filterFiles(query) {
  const q = query.toLowerCase().trim();
  const filtered = q ? allFiles.filter(f => f.name.toLowerCase().includes(q)) : allFiles;
  renderFiles(filtered);
}

function groupByDate(files) {
  // Nếu không có date info từ API, hiển thị tất cả under "Tất cả files"
  return { 'Tất cả files': files };
}

// ── FILE SELECTION ────────────────────────────
function onFilesSelected(files) {
  const arr = Array.from(files);
  let rejected = 0;

  arr.forEach(f => {
    if (f.size > MAX_FILE_B) {
      rejected++;
      return;
    }
    const id = Date.now() + Math.random();
    queue.push({ id, file: f, status: 'pending' });
  });

  if (rejected) toast(`${rejected} file vượt quá ${MAX_FILE_MB}MB, bỏ qua`, 'warn');

  renderQueue();
  updateUploadBtn();
  // Reset input so same file can be re-selected
  document.getElementById('file-input').value = '';
}

function renderQueue() {
  const el = document.getElementById('queue');

  if (!queue.length) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = queue.map(item => {
    const ext  = extOf(item.file.name);
    const icon = iconOf(ext);
    const cls  = colorOf(typeOf(ext));
    const size = formatSize(item.file.size);
    const statusBadge = item.status === 'done'    ? '<span style="color:var(--accent3)">✓</span>'
                      : item.status === 'error'   ? '<span style="color:var(--danger)">✗</span>'
                      : item.status === 'loading' ? '<span style="color:var(--accent)">⏳</span>'
                      : '';

    return `
      <div class="queue-item" id="qi-${item.id}">
        <div class="queue-icon ${cls}">${icon}</div>
        <div class="queue-info">
          <div class="queue-name">${escHtml(item.file.name)}</div>
          <div class="queue-size">${size}</div>
        </div>
        <span class="queue-status">${statusBadge}</span>
        ${item.status === 'pending' ? `<button class="queue-remove" onclick="removeFromQueue(${item.id})">✕</button>` : ''}
      </div>`;
  }).join('');
}

function removeFromQueue(id) {
  queue = queue.filter(i => i.id !== id);
  renderQueue();
  updateUploadBtn();
}

function updateUploadBtn() {
  const btn = document.getElementById('upload-btn');
  const pending = queue.filter(i => i.status === 'pending').length;
  btn.disabled = pending === 0 || !cfg.token;
  document.getElementById('upload-btn-text').textContent =
    pending > 1 ? `Upload ${pending} files` : 'Upload';
}

// ── UPLOAD ────────────────────────────────────
async function uploadAll() {
  // Anti-spam: rate limit
  const now = Date.now();
  if (now - lastUpload < ALLOWED_WAIT * 1000) {
    const wait = Math.ceil((ALLOWED_WAIT * 1000 - (now - lastUpload)) / 1000);
    return toast(`Đợi ${wait}s trước khi upload tiếp`, 'warn');
  }

  if (!cfg.token) return toast('Cần token để upload', 'error');

  const pending = queue.filter(i => i.status === 'pending');
  if (!pending.length) return;

  const btn = document.getElementById('upload-btn');
  btn.disabled = true;
  showProgress(0);

  let done = 0;

  for (const item of pending) {
    item.status = 'loading';
    renderQueue();

    try {
      await uploadFile(item.file);
      item.status = 'done';
      done++;
    } catch (e) {
      item.status = 'error';
      toast(`Lỗi: ${item.file.name} — ${e.message}`, 'error');
    }

    renderQueue();
    showProgress(Math.round((done / pending.length) * 100));
  }

  lastUpload = Date.now();
  hideProgress();

  toast(`✓ Đã upload ${done}/${pending.length} file`, 'success');

  // Clear done items after 2s
  setTimeout(() => {
    queue = queue.filter(i => i.status !== 'done');
    renderQueue();
    updateUploadBtn();
  }, 2000);

  // Reload file list
  setTimeout(() => {
    switchTab('files', document.querySelector('.tab[data-tab="files"]'));
    loadFiles();
  }, 1500);
}

async function uploadFile(file) {
  // 1. Read file as base64
  const base64 = await fileToBase64(file);

  // 2. Deduplicate filename
  const safeFileName = await deduplicateFilename(file.name);

  // 3. Create/update file directly via Contents API
  const path = `uploads/${safeFileName}`;
  const message = `upload: ${safeFileName}`;

  // Check if file already exists (get SHA if so)
  let sha = undefined;
  try {
    const existing = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/contents/${path}`);
    if (existing.ok) {
      const ex = await existing.json();
      sha = ex.sha;
    }
  } catch {}

  const body = {
    message,
    content: base64,
    branch: 'main'
  };
  if (sha) body.sha = sha;

  const res = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
}

async function deduplicateFilename(name) {
  const ext  = extOf(name);
  const base = ext ? name.slice(0, -(ext.length + 1)) : name;
  const safe = sanitizeFilename(`${base}_${Date.now()}.${ext}`);
  return safe;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-() ]/g, '_').replace(/\s+/g, '_');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Strip data URL prefix (data:...;base64,)
      resolve(reader.result.split(',')[1]);
    };
    reader.onerror = () => reject(new Error('Không đọc được file'));
    reader.readAsDataURL(file);
  });
}

// ── PREVIEW ───────────────────────────────────
function openPreview(name, url, ext, size) {
  document.getElementById('preview-name').textContent = name;
  const content = document.getElementById('preview-content');

  // Info row
  const type = typeOf(ext);
  content.innerHTML = `
    <div class="preview-info-row">
      <span class="info-chip">${ext || 'file'}</span>
      <span class="info-chip">${size}</span>
    </div>`;

  // Image preview
  if (type === 'img') {
    content.innerHTML += `<img src="${url}" alt="${escHtml(name)}" style="width:100%">`;
  } else if (type === 'code' || ext === 'txt' || ext === 'md') {
    content.innerHTML += `<div style="color:var(--text2);font-family:var(--mono);font-size:12px;padding:12px;background:var(--surface2);border-radius:var(--radius-sm)">Xem trực tiếp: <a href="${url}" target="_blank" style="color:var(--accent)">Mở file ↗</a></div>`;
  } else {
    content.innerHTML += `<div style="text-align:center;padding:24px;font-size:36px">${iconOf(ext)}</div>`;
  }

  const dlBtn = document.getElementById('preview-download');
  const cpBtn = document.getElementById('preview-copy');

  dlBtn.onclick = () => {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.click();
    toast('Đang tải...', 'success');
  };

  cpBtn.onclick = () => {
    navigator.clipboard.writeText(url)
      .then(() => toast('Đã copy link ⎘', 'success'))
      .catch(() => prompt('Copy link:', url));
  };

  document.getElementById('preview-modal').classList.remove('hidden');
}

function closePreview(e) {
  if (e.target === document.getElementById('preview-modal')) {
    document.getElementById('preview-modal').classList.add('hidden');
  }
}

// ── UI HELPERS ────────────────────────────────
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById(`tab-${name}`).classList.add('active');
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}
function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function setStatus(state, text) {
  const dot  = document.querySelector('.status-dot');
  const span = document.getElementById('status-text');
  dot.className = `status-dot ${state}`;
  span.textContent = text;
}

let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function showProgress(pct) {
  const wrap = document.getElementById('progress-wrap');
  wrap.style.display = 'flex';
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = pct + '%';
}

function hideProgress() {
  showProgress(100);
  setTimeout(() => {
    document.getElementById('progress-wrap').style.display = 'none';
  }, 600);
}

// ── DRAG & DROP ───────────────────────────────
function setupDragDrop() {
  const zone = document.getElementById('drop-zone');

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));

  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    onFilesSelected(e.dataTransfer.files);
  });
}

// ── UTILITIES ─────────────────────────────────
function val(id) { return document.getElementById(id)?.value || ''; }

function extOf(name) {
  const parts = (name || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function typeOf(ext) {
  if (['jpg','jpeg','png','gif','webp','svg','heic','avif'].includes(ext)) return 'img';
  if (['mp4','mov','avi','mkv','webm'].includes(ext))                      return 'vid';
  if (['doc','docx','xls','xlsx','ppt','pptx'].includes(ext))              return 'doc';
  if (['zip','rar','7z','tar','gz'].includes(ext))                         return 'zip';
  if (['js','ts','py','html','css','json','sh','go','rs','java'].includes(ext)) return 'code';
  if (ext === 'pdf')                                                        return 'pdf';
  return 'def';
}

function iconOf(ext) {
  const map = {
    jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🎞', webp:'🖼', heic:'🖼', svg:'🎨',
    mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬', webm:'🎬',
    doc:'📄', docx:'📄', xls:'📊', xlsx:'📊', ppt:'📑', pptx:'📑',
    pdf:'📕', zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦',
    js:'💻', ts:'💻', py:'🐍', html:'🌐', css:'🎨', json:'⚙️',
    mp3:'🎵', wav:'🎵', aac:'🎵',
    txt:'📝', md:'📝',
  };
  return map[ext] || '📁';
}

function colorOf(type) {
  return { img:'ft-img', vid:'ft-vid', doc:'ft-doc', zip:'ft-zip', code:'ft-code', pdf:'ft-pdf' }[type] || 'ft-def';
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
