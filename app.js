/* ============================================================
   FileZap v3 — app.js
   ============================================================
   ✅ Large files >5MB via Git Blobs API + Tree API (tới ~50MB)
   ✅ Group file theo ngày thật (commit date + localStorage)
   ✅ Bulk download (chọn nhiều + tải về)
   ✅ Download trực tiếp + progress label
   ✅ Anti-spam, sanitize, dedup filename
   ============================================================ */

const GH_API       = "https://api.github.com";
const MAX_FILE_MB  = 50;
const MAX_FILE_B   = MAX_FILE_MB * 1024 * 1024;
const ALLOWED_WAIT = 8;
const METADATA_KEY = "filezap_meta";

let cfg         = {};
let queue       = [];
let allFiles    = [];
let fileMeta    = {};
let lastUpload  = 0;
let selectedFiles = new Set();

// ── BOOT ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  cfg      = loadConfig();
  fileMeta = loadMeta();
  setupDragDrop();

  if (!cfg.username) {
    showModal('config-modal');
  } else {
    initApp();
  }
});

async function initApp() {
  setStatus('online', 'Đang kết nối...');

  // Ping repo KHÔNG dùng token (repo public — tránh báo lỗi token sai khi chỉ đọc)
  const repoOk = await pingRepoPublic();
  if (!repoOk) {
    setStatus('error', 'Không tìm thấy repo');
    toast('Không tìm thấy repo. Kiểm tra lại cấu hình.', 'error');
    showModal('config-modal');
    return;
  }

  // Verify token riêng — lỗi token chỉ cảnh báo, không chặn xem file public
  if (cfg.token) {
    const tokenOk = await verifyToken();
    if (!tokenOk) {
      setStatus('warn', `${cfg.username}/${cfg.repo} — Token hết hạn`);
      toast('⚠️ Token hết hạn hoặc sai — chỉ xem được, không upload', 'warn');
    } else {
      setStatus('online', `${cfg.username}/${cfg.repo}`);
    }
  } else {
    setStatus('online', `${cfg.username}/${cfg.repo} — Chỉ xem`);
  }

  loadFiles();
}

// ── CONFIG ───────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(localStorage.getItem('filezap_cfg') || '{}'); }
  catch { return {}; }
}
function loadMeta() {
  try { return JSON.parse(localStorage.getItem(METADATA_KEY) || '{}'); }
  catch { return {}; }
}
function saveMeta() { localStorage.setItem(METADATA_KEY, JSON.stringify(fileMeta)); }

async function saveConfig() {
  const u = val('cfg-username').trim();
  const r = val('cfg-repo').trim();
  const t = val('cfg-token').trim();

  if (!u || !r) return toast('Điền đủ username và repo', 'warn');
  if (!t)       return toast('Cần token để upload', 'warn');
  if (!t.startsWith('ghp_') && !t.startsWith('github_pat_'))
    return toast('Token không đúng định dạng (ghp_ ...)', 'error');

  // Disable nút trong lúc verify
  const btn = document.querySelector('.modal-btn');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang kiểm tra...';

  // 1. Kiểm tra repo tồn tại (không cần token)
  const repoRes = await fetch(`${GH_API}/repos/${u}/${r}`, {
    headers: { 'Accept': 'application/vnd.github+json' }
  }).catch(() => null);

  if (!repoRes || (!repoRes.ok && repoRes.status !== 403)) {
    btn.disabled = false; btn.textContent = origText;
    return toast(`Không tìm thấy repo "${u}/${r}"`, 'error');
  }

  // 2. Verify token
  const tokenRes = await fetch(`${GH_API}/user`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${t}`
    }
  }).catch(() => null);

  if (!tokenRes || !tokenRes.ok) {
    btn.disabled = false; btn.textContent = origText;
    return toast('Token không hợp lệ hoặc hết hạn', 'error');
  }

  // 3. Lưu config
  cfg = { username: u, repo: r, token: t };
  localStorage.setItem('filezap_cfg', JSON.stringify(cfg));

  btn.disabled = false; btn.textContent = origText;
  hideModal('config-modal');
  setStatus('online', `${u}/${r}`);

  // 4. Tự động vào tab Upload ngay sau khi lưu
  const uploadTab = document.querySelector('.tab[data-tab="upload"]');
  switchTab('upload', uploadTab);

  toast('Cấu hình đã lưu ✓ — Sẵn sàng upload!', 'success');
  loadFiles(); // load ngầm danh sách file
}

// ── GITHUB API ────────────────────────────────────────────────
async function ghFetch(path, opts = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...opts.headers
  };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
  const res = await fetch(`${GH_API}${path}`, { ...opts, headers });
  if (res.status === 401) throw new Error('Token sai hoặc hết hạn');
  if (res.status === 403) throw new Error('Không có quyền — kiểm tra token scope');
  if (res.status === 404) throw new Error('Không tìm thấy (404)');
  return res;
}

// Ping repo KHÔNG dùng token -> kiểm tra repo có tồn tại không (hoạt động với repo public)
async function pingRepoPublic() {
  try {
    const res = await fetch(`${GH_API}/repos/${cfg.username}/${cfg.repo}`, {
      headers: { 'Accept': 'application/vnd.github+json' }
    });
    return res.ok || res.status === 403; // 403 = repo tồn tại nhưng private
  } catch { return false; }
}

// Verify token riêng — chỉ gọi nếu có token
async function verifyToken() {
  try {
    const res = await fetch(`${GH_API}/user`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${cfg.token}`
      }
    });
    return res.ok;
  } catch { return false; }
}

// Giữ lại cho backward compat
async function pingGitHub() { return pingRepoPublic(); }

// ── LOAD FILES ────────────────────────────────────────────────
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
    if (!Array.isArray(data)) { allFiles = []; renderFiles([]); return; }

    allFiles = await enrichWithDates(data);
    renderFiles(allFiles);
    updateFileBadge();
    setStatus('online', `${cfg.username}/${cfg.repo} · ${allFiles.length} files`);
  } catch (e) {
    setStatus('error', e.message);
    toast('Lỗi tải danh sách: ' + e.message, 'error');
  } finally {
    btn.classList.remove('spinning');
  }
}

async function enrichWithDates(files) {
  // Lấy commit dates từ Git API
  let commitDates = {};
  try {
    const res = await ghFetch(
      `/repos/${cfg.username}/${cfg.repo}/commits?path=uploads&per_page=100`
    );
    if (res.ok) {
      const commits = await res.json();
      for (const c of commits) {
        const date = c.commit?.committer?.date || c.commit?.author?.date;
        if (!date) continue;
        const msg   = c.commit?.message || '';
        const match = msg.match(/upload:\s*(.+)/i);
        if (match) {
          const fname = match[1].trim();
          if (!commitDates[fname]) commitDates[fname] = date;
        }
      }
    }
  } catch {}

  return files.map(f => {
    const uploadedAt =
      fileMeta[f.name]?.uploadedAt ||   // localStorage — nguồn đáng tin nhất
      commitDates[f.name] ||            // Git commit date
      new Date().toISOString();         // fallback
    return { ...f, uploadedAt };
  });
}

function showSkeleton() {
  document.getElementById('file-list').innerHTML =
    [1,2,3].map(() => `<div class="skeleton"></div>`).join('');
}

// ── RENDER FILES ─────────────────────────────────────────────
function renderFiles(files) {
  const list = document.getElementById('file-list');
  selectedFiles.clear();
  updateBulkBar();

  if (!files.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div>Chưa có file nào trong /uploads</div>
      </div>`;
    return;
  }

  const sorted = [...files].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  // Group theo ngày
  const groups = {};
  for (const f of sorted) {
    const label = dateLabel(f.uploadedAt);
    if (!groups[label]) groups[label] = [];
    groups[label].push(f);
  }

  let html = '';
  for (const [label, group] of Object.entries(groups)) {
    html += `
      <div class="file-group-header">
        <div class="file-group-label">${label}</div>
        <div class="file-group-count">${group.length} file</div>
      </div>`;

    group.forEach(f => {
      const ext    = extOf(f.name);
      const cls    = colorOf(typeOf(ext));
      const size   = f.size ? formatSize(f.size) : '—';
      const time   = shortTime(f.uploadedAt);
      const rawUrl = rawUrlOf(f.name);
      const fid    = 'f' + f.name.split('').reduce((a,c) => ((a<<5)-a)+c.charCodeAt(0)|0, 0).toString(36).replace('-','_');

      html += `
        <div class="file-card" id="fc-${fid}" data-name="${escAttr(f.name)}">
          <div class="file-checkbox" onclick="toggleSelect(event,'${fid}',${JSON.stringify(f.name)})">
            <div class="checkbox-inner" id="chk-${fid}"></div>
          </div>
          <div class="file-thumb ${cls}" onclick="openPreview(${JSON.stringify(f.name)},${JSON.stringify(rawUrl)},${JSON.stringify(ext)},${JSON.stringify(size)},${JSON.stringify(f.uploadedAt)})">${iconOf(ext)}</div>
          <div class="file-info" onclick="openPreview(${JSON.stringify(f.name)},${JSON.stringify(rawUrl)},${JSON.stringify(ext)},${JSON.stringify(size)},${JSON.stringify(f.uploadedAt)})">
            <div class="file-name">${escHtml(f.name)}</div>
            <div class="file-meta">
              <span>${size}</span>
              <span class="sep">·</span>
              <span>${time}</span>
              <span class="file-tag ${cls}">${ext || 'file'}</span>
            </div>
          </div>
          <button class="file-dl-btn" onclick="event.stopPropagation();downloadFile(${JSON.stringify(rawUrl)},${JSON.stringify(f.name)})" title="Tải xuống">⬇</button>
        </div>`;
    });
  }

  list.innerHTML = html;
}

function filterFiles(query) {
  const q = query.toLowerCase().trim();
  renderFiles(q ? allFiles.filter(f => f.name.toLowerCase().includes(q)) : allFiles);
}

function updateFileBadge() {
  const b = document.getElementById('file-count');
  b.textContent = allFiles.length;
  b.classList.toggle('visible', allFiles.length > 0);
}

// ── DATE HELPERS ─────────────────────────────────────────────
function dateLabel(iso) {
  if (!iso) return 'Không xác định';
  const d    = new Date(iso);
  const now  = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return '📅 Hôm nay';
  if (diff === 1) return '📅 Hôm qua';
  if (diff < 7)   return `📅 ${diff} ngày trước`;
  return `📅 ${d.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' })}`;
}

function shortTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' });
}

// ── FILE SELECTION (UPLOAD QUEUE) ─────────────────────────────
function onFilesSelected(files) {
  let rejected = 0;
  Array.from(files).forEach(f => {
    if (f.size > MAX_FILE_B) { rejected++; return; }
    queue.push({ id: Date.now() + Math.random(), file: f, status: 'pending' });
  });
  if (rejected) toast(`${rejected} file vượt quá ${MAX_FILE_MB}MB`, 'warn');
  renderQueue();
  updateUploadBtn();
  document.getElementById('file-input').value = '';
}

function renderQueue() {
  const el = document.getElementById('queue');
  if (!queue.length) { el.innerHTML = ''; return; }

  el.innerHTML = queue.map(item => {
    const ext     = extOf(item.file.name);
    const cls     = colorOf(typeOf(ext));
    const isLarge = item.file.size > 5 * 1024 * 1024;
    const si = item.status === 'done'    ? `<span class="qs-done">✓</span>`  :
               item.status === 'error'   ? `<span class="qs-error">✗</span>` :
               item.status === 'loading' ? `<span class="qs-loading">◌</span>` : '';

    return `
      <div class="queue-item" id="qi-${item.id}">
        <div class="queue-icon ${cls}">${iconOf(ext)}</div>
        <div class="queue-info">
          <div class="queue-name">${escHtml(item.file.name)}</div>
          <div class="queue-size">${formatSize(item.file.size)} ${isLarge ? '<span class="chunk-badge">Blob API</span>' : ''}</div>
        </div>
        ${si}
        ${item.status === 'pending' ? `<button class="queue-remove" onclick="removeFromQueue(${item.id})">✕</button>` : ''}
      </div>`;
  }).join('');
}

function removeFromQueue(id) {
  queue = queue.filter(i => i.id !== id);
  renderQueue(); updateUploadBtn();
}

function updateUploadBtn() {
  const btn     = document.getElementById('upload-btn');
  const pending = queue.filter(i => i.status === 'pending').length;
  btn.disabled  = pending === 0 || !cfg.token;
  document.getElementById('upload-btn-text').textContent =
    pending > 1 ? `Upload ${pending} files` : 'Upload';
}

// ── UPLOAD ────────────────────────────────────────────────────
async function uploadAll() {
  const now = Date.now();
  if (now - lastUpload < ALLOWED_WAIT * 1000) {
    const wait = Math.ceil((ALLOWED_WAIT * 1000 - (now - lastUpload)) / 1000);
    return toast(`Đợi ${wait}s trước khi upload tiếp`, 'warn');
  }
  if (!cfg.token) return toast('Cần token để upload', 'error');

  const pending = queue.filter(i => i.status === 'pending');
  if (!pending.length) return;

  document.getElementById('upload-btn').disabled = true;
  showProgress(0, 'Chuẩn bị...');

  let done = 0;
  for (const item of pending) {
    item.status = 'loading';
    renderQueue();
    showProgress(Math.round((done / pending.length) * 100), `↑ ${item.file.name}`);

    try {
      const safeFileName = deduplicateFilename(item.file.name);

      if (item.file.size > 5 * 1024 * 1024) {
        await uploadLargeFile(item.file, safeFileName);
      } else {
        await uploadSmallFile(item.file, safeFileName);
      }

      fileMeta[safeFileName] = { uploadedAt: new Date().toISOString() };
      saveMeta();

      item.status = 'done';
      done++;
    } catch (e) {
      item.status = 'error';
      toast(`✗ ${item.file.name}: ${e.message}`, 'error');
    }

    renderQueue();
    showProgress(Math.round((done / pending.length) * 100));
  }

  lastUpload = Date.now();
  hideProgress();
  toast(`⚡ Đã upload ${done}/${pending.length} file`, 'success');

  setTimeout(() => {
    queue = queue.filter(i => i.status !== 'done');
    renderQueue(); updateUploadBtn();
  }, 2000);

  setTimeout(() => {
    switchTab('files', document.querySelector('.tab[data-tab="files"]'));
    loadFiles();
  }, 1500);
}

// ≤5MB: Contents API
async function uploadSmallFile(file, safeFileName) {
  const base64 = await fileToBase64(file);
  const path   = `uploads/${safeFileName}`;
  let sha;
  try {
    const ex = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/contents/${path}`);
    if (ex.ok) sha = (await ex.json()).sha;
  } catch {}

  const body = { message: `upload: ${safeFileName}`, content: base64, branch: 'main' };
  if (sha) body.sha = sha;

  const res = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error((await res.json().catch(()=>({}))).message || `HTTP ${res.status}`);
}

// >5MB: Git Blob → Tree → Commit → Ref
async function uploadLargeFile(file, safeFileName) {
  showProgress(5,  'Đọc file...');
  const base64 = await fileToBase64(file);

  showProgress(20, 'Tạo Git blob...');
  const blobRes = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/git/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: base64, encoding: 'base64' })
  });
  if (!blobRes.ok) throw new Error(`Tạo blob thất bại: ${(await blobRes.json().catch(()=>({}))).message || blobRes.status}`);
  const { sha: blobSha } = await blobRes.json();

  showProgress(40, 'Lấy HEAD...');
  const refRes = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/git/ref/heads/main`);
  if (!refRes.ok) throw new Error('Không lấy được HEAD ref');
  const { object: { sha: headSha } } = await refRes.json();

  showProgress(55, 'Lấy base tree...');
  const commitRes = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/git/commits/${headSha}`);
  if (!commitRes.ok) throw new Error('Không lấy được commit');
  const { tree: { sha: baseSha } } = await commitRes.json();

  showProgress(68, 'Tạo tree...');
  const treeRes = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: baseSha,
      tree: [{ path: `uploads/${safeFileName}`, mode: '100644', type: 'blob', sha: blobSha }]
    })
  });
  if (!treeRes.ok) throw new Error(`Tạo tree thất bại: ${(await treeRes.json().catch(()=>({}))).message}`);
  const { sha: newTreeSha } = await treeRes.json();

  showProgress(82, 'Tạo commit...');
  const newCommitRes = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `upload: ${safeFileName}`, tree: newTreeSha, parents: [headSha] })
  });
  if (!newCommitRes.ok) throw new Error(`Tạo commit thất bại`);
  const { sha: newCommitSha } = await newCommitRes.json();

  showProgress(93, 'Update ref...');
  const updateRes = await ghFetch(`/repos/${cfg.username}/${cfg.repo}/git/refs/heads/main`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommitSha })
  });
  if (!updateRes.ok) throw new Error(`Update ref thất bại`);
}

// ── DOWNLOAD ─────────────────────────────────────────────────
async function downloadFile(url, filename) {
  toast(`⬇ Đang tải ${filename}...`);
  try {
    // Thử fetch + blob (hoạt động nếu CORS cho phép)
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`✓ Tải xong: ${filename}`, 'success');
  } catch (_) {
    // CORS fallback: mở tab mới, user nhấn Cmd/Ctrl+S để lưu
    toast(`⬇ Mở tab mới — nhấn Ctrl+S để lưu`, 'warn');
    window.open(url, '_blank');
  }
}

// ── BULK SELECT & DOWNLOAD ────────────────────────────────────
function toggleSelect(event, fid, filename) {
  event.stopPropagation();
  const chk  = document.getElementById(`chk-${fid}`);
  const card = document.getElementById(`fc-${fid}`);
  if (selectedFiles.has(filename)) {
    selectedFiles.delete(filename);
    chk.classList.remove('checked');
    card.classList.remove('selected');
  } else {
    selectedFiles.add(filename);
    chk.classList.add('checked');
    card.classList.add('selected');
  }
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const n   = selectedFiles.size;
  bar.classList.toggle('visible', n > 0);
  document.getElementById('bulk-count').textContent = `${n} file được chọn`;
}

function clearSelection() {
  selectedFiles.clear();
  document.querySelectorAll('.checkbox-inner.checked').forEach(e => e.classList.remove('checked'));
  document.querySelectorAll('.file-card.selected').forEach(e => e.classList.remove('selected'));
  updateBulkBar();
}

async function downloadSelected() {
  if (!selectedFiles.size) return;
  const names = [...selectedFiles];
  toast(`⬇ Tải ${names.length} file...`);
  for (const name of names) {
    await downloadFile(rawUrlOf(name), name);
    await sleep(400);
  }
  clearSelection();
}

async function downloadAll() {
  if (!allFiles.length) return toast('Không có file nào', 'warn');
  toast(`⬇ Tải tất cả ${allFiles.length} file...`);
  for (const f of allFiles) {
    await downloadFile(rawUrlOf(f.name), f.name);
    await sleep(500);
  }
}

// ── PREVIEW ──────────────────────────────────────────────────
function openPreview(name, url, ext, size, uploadedAt) {
  document.getElementById('preview-name').textContent = name;
  const content = document.getElementById('preview-content');
  const type    = typeOf(ext);
  const dateStr = uploadedAt ? new Date(uploadedAt).toLocaleString('vi-VN') : '—';

  content.innerHTML = `
    <div class="preview-info-row">
      <span class="info-chip">${ext || 'file'}</span>
      <span class="info-chip">${size}</span>
      <span class="info-chip">🕐 ${dateStr}</span>
    </div>`;

  if (type === 'img') {
    content.innerHTML += `<img src="${url}" alt="${escHtml(name)}" loading="lazy" style="width:100%;border-radius:var(--radius-sm);margin-top:12px">`;
  } else {
    content.innerHTML += `<div style="text-align:center;padding:32px;font-size:48px">${iconOf(ext)}</div>`;
  }

  document.getElementById('preview-download').onclick = () => downloadFile(url, name);
  document.getElementById('preview-copy').onclick = () =>
    navigator.clipboard.writeText(url)
      .then(() => toast('Đã copy link ⎘', 'success'))
      .catch(()  => prompt('Copy link:', url));

  document.getElementById('preview-modal').classList.remove('hidden');
}

function closePreview(e) {
  if (e.target === document.getElementById('preview-modal'))
    document.getElementById('preview-modal').classList.add('hidden');
}

// ── DRAG & DROP ───────────────────────────────────────────────
function setupDragDrop() {
  const zone = document.getElementById('drop-zone');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    onFilesSelected(e.dataTransfer.files);
  });
}

// ── UI HELPERS ────────────────────────────────────────────────
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById(`tab-${name}`).classList.add('active');
}

function showModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id)  { document.getElementById(id).classList.add('hidden'); }

function setStatus(state, text) {
  document.querySelector('.status-dot').className = `status-dot ${state}`;
  document.getElementById('status-text').textContent = text;
}

let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function showProgress(pct, label) {
  const wrap = document.getElementById('progress-wrap');
  wrap.style.display = 'flex';
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = label || pct + '%';
}

function hideProgress() {
  showProgress(100);
  setTimeout(() => { document.getElementById('progress-wrap').style.display = 'none'; }, 700);
}

// ── UTILITIES ─────────────────────────────────────────────────
function val(id)       { return document.getElementById(id)?.value || ''; }
function rawUrlOf(n)   { return `https://raw.githubusercontent.com/${cfg.username}/${cfg.repo}/main/uploads/${encodeURIComponent(n)}`; }
function sleep(ms)     { return new Promise(r => setTimeout(r, ms)); }
function deduplicateFilename(name) {
  const ext  = extOf(name);
  const base = ext ? name.slice(0, -(ext.length+1)) : name;
  return sanitizeName(`${base}_${Date.now()}${ext ? '.'+ext : ''}`);
}
function sanitizeName(n)  { return n.replace(/[^a-zA-Z0-9._\-()\u00C0-\u024F ]/g,'_').replace(/\s+/g,'_'); }
function extOf(n)          { const p=(n||'').split('.'); return p.length>1?p.pop().toLowerCase():''; }
function typeOf(ext) {
  if (['jpg','jpeg','png','gif','webp','svg','heic','avif'].includes(ext)) return 'img';
  if (['mp4','mov','avi','mkv','webm'].includes(ext))                      return 'vid';
  if (['doc','docx','xls','xlsx','ppt','pptx'].includes(ext))              return 'doc';
  if (['zip','rar','7z','tar','gz'].includes(ext))                         return 'zip';
  if (['js','ts','py','html','css','json','sh','go','rs','java','c','cpp'].includes(ext)) return 'code';
  if (ext === 'pdf')                                                        return 'pdf';
  return 'def';
}
function iconOf(ext) {
  return ({jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🎞',webp:'🖼',heic:'🖼',svg:'🎨',avif:'🖼',
    mp4:'🎬',mov:'🎬',avi:'🎬',mkv:'🎬',webm:'🎬',doc:'📄',docx:'📄',xls:'📊',xlsx:'📊',
    ppt:'📑',pptx:'📑',pdf:'📕',zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',
    js:'💻',ts:'💻',py:'🐍',html:'🌐',css:'🎨',json:'⚙️',sh:'⚙️',
    mp3:'🎵',wav:'🎵',aac:'🎵',txt:'📝',md:'📝'})[ext] || '📁';
}
function colorOf(t) { return ({img:'ft-img',vid:'ft-vid',doc:'ft-doc',zip:'ft-zip',code:'ft-code',pdf:'ft-pdf'})[t]||'ft-def'; }
function formatSize(b) {
  if (!b) return '—';
  if (b<1024) return b+' B';
  if (b<1024**2) return (b/1024).toFixed(1)+' KB';
  if (b<1024**3) return (b/1024**2).toFixed(2)+' MB';
  return (b/1024**3).toFixed(2)+' GB';
}
function escHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s)  { return escHtml(s).replace(/'/g,'&#39;'); }
function fileToBase64(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('Không đọc được file'));
    r.readAsDataURL(file);
  });
}
