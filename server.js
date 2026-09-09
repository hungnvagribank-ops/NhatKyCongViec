require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'doi-chuoi-bi-mat-nay-trong-bien-moi-truong';
const SESSION_MAX = { morning: 240, afternoon: 240, overtime: 960 };
const DEPARTMENTS = [
  'Ban Giám đốc',
  'Quản lý đào tạo và Thư viện',
  'Kế toán',
  'Nghiên cứu và giảng dạy',
  'Kế hoạch',
  'Tổng hợp',
];

// Các tiêu chí cố định của Phiếu đánh giá mức độ hoàn thành công việc hàng tháng
const EVAL_CRITERIA = [
  { id: 1, group: 'I', label: 'Khối lượng công việc', desc: 'Khối lượng công việc hoàn thành so với khối lượng công việc cần thực hiện trong tháng', max: 20 },
  { id: 2, group: 'I', label: 'Chất lượng công việc', desc: 'Chất lượng, kết quả, sự chính xác... trong thực hiện công việc', max: 20 },
  { id: 3, group: 'I', label: 'Tiến độ thực hiện công việc', desc: 'Tiến độ thực hiện công việc theo thời hạn được phân công', max: 20 },
  { id: 4, group: 'I', label: 'Năng lực, thái độ thực hiện', desc: 'Khả năng tham mưu lãnh đạo; Khả năng xây dựng cơ chế, quy chế...; Khả năng xử lý tình huống; Ý thức làm việc; Phối hợp công tác...', max: 20 },
  { id: 5, group: 'II', label: 'Ý thức chấp hành kỷ luật, nội quy lao động', desc: '', max: 10 },
  { id: 6, group: 'III', label: 'Kết quả kiểm tra nghiệp vụ', desc: '', max: 10 },
];
function defaultEvalScores() {
  return EVAL_CRITERIA.map(c => ({ id: c.id, nld: 0, ld_phong: 0, pho_truong: 0, truong_don_vi: 0, ghi_chu: '' }));
}
function defaultEvalSubmitted() {
  return { nld: false, ld_phong: false, pho_truong: false, truong_don_vi: false };
}

if (!process.env.DATABASE_URL) {
  console.warn('CẢNH BÁO: chưa cấu hình biến môi trường DATABASE_URL (chuỗi kết nối PostgreSQL).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      fullname TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','bgd','truong_phong','pho_phong','nhan_vien')),
      department TEXT NOT NULL DEFAULT ''
    );
  `);
  // Di chuyển dữ liệu cũ: gộp vai trò 'truong_pho' (bản cũ) sang 'truong_phong', và cập nhật lại ràng buộc CHECK
  // cho các database đã được tạo từ trước khi có vai trò 'phó phòng'.
  try {
    await pool.query(`UPDATE users SET role = 'truong_phong' WHERE role = 'truong_pho'`);
  } catch (e) { /* cột/giá trị không tồn tại thì bỏ qua */ }
  try {
    // Tài khoản 'admin' (quản trị hệ thống) tách khỏi vai trò 'bgd' (Ban giám đốc thực tế).
    await pool.query(`UPDATE users SET role = 'admin' WHERE username = 'admin' AND role = 'bgd'`);
  } catch (e) { /* bỏ qua nếu chưa có tài khoản admin */ }
  try {
    await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','bgd','truong_phong','pho_phong','nhan_vien'))`);
  } catch (e) { console.warn('Không thể cập nhật ràng buộc role:', e.message); }
  // Cột phụ trách chấm điểm (chỉ áp dụng cho vai trò Ban giám đốc): 'pho_truong_don_vi' hoặc 'truong_don_vi'
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS eval_title TEXT`);
    await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_eval_title_check`);
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_eval_title_check CHECK (eval_title IS NULL OR eval_title IN ('pho_truong_don_vi','truong_don_vi'))`);
  } catch (e) { console.warn('Không thể thêm cột eval_title:', e.message); }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      log_date DATE NOT NULL,
      morning JSONB NOT NULL DEFAULT '[]',
      afternoon JSONB NOT NULL DEFAULT '[]',
      overtime JSONB NOT NULL DEFAULT '[]',
      PRIMARY KEY (username, log_date)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS evaluations (
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      year INT NOT NULL,
      month INT NOT NULL,
      scores JSONB NOT NULL DEFAULT '[]',
      submitted JSONB NOT NULL DEFAULT '{"nld":false,"ld_phong":false,"pho_truong":false,"truong_don_vi":false}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (username, year, month)
    );
  `);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, fullname, role, department) VALUES ($1,$2,$3,$4,$5)',
      ['admin', hash, 'Quản trị viên', 'admin', '']
    );
    console.log('Đã tạo tài khoản quản trị mặc định: admin / admin123 — hãy đăng nhập và đổi mật khẩu ngay.');
  }
}

function sign(user) {
  return jwt.sign(
    { username: user.username, role: user.role, department: user.department, fullname: user.fullname, eval_title: user.eval_title || null },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.' });
  }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này.' });
    next();
  };
}
function sumMinutes(rows) {
  return (rows || []).reduce((s, r) => s + (Number(r.minutes) || 0), 0);
}
function validSessions(morning, afternoon, overtime) {
  return (
    sumMinutes(morning) <= SESSION_MAX.morning &&
    sumMinutes(afternoon) <= SESSION_MAX.afternoon &&
    sumMinutes(overtime) <= SESSION_MAX.overtime
  );
}

/* ---------------- AUTH ---------------- */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu tên đăng nhập hoặc mật khẩu.' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
    const profile = { username: u.username, fullname: u.fullname, role: u.role, department: u.department, eval_title: u.eval_title || null };
    res.json({ token: sign(profile), user: profile });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.put('/api/me/password', auth, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 4 ký tự.' });
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash=$1 WHERE username=$2', [hash, req.user.username]);
  res.json({ ok: true });
});

/* ---------------- USERS (chỉ BGĐ) ---------------- */
app.get('/api/users', auth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT username, fullname, role, department, eval_title FROM users ORDER BY fullname');
  res.json({ users: rows, departments: DEPARTMENTS });
});

app.post('/api/users', auth, requireRole('admin'), async (req, res) => {
  const { username, password, fullname, role, department, eval_title } = req.body || {};
  if (!username || !password || !fullname || !role) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc.' });
  if (!['admin', 'bgd', 'truong_phong', 'pho_phong', 'nhan_vien'].includes(role)) return res.status(400).json({ error: 'Cấp bậc không hợp lệ.' });
  if (role !== 'bgd' && role !== 'admin' && !DEPARTMENTS.includes(department)) return res.status(400).json({ error: 'Vui lòng chọn phòng ban hợp lệ.' });
  if (role === 'bgd' && !['pho_truong_don_vi', 'truong_don_vi'].includes(eval_title)) return res.status(400).json({ error: 'Vui lòng chọn cột phụ trách chấm điểm cho tài khoản Ban giám đốc.' });
  try {
    const exists = await pool.query('SELECT 1 FROM users WHERE username=$1', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, fullname, role, department, eval_title) VALUES ($1,$2,$3,$4,$5,$6)',
      [username, hash, fullname, role, department || '', role === 'bgd' ? eval_title : null]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

app.put('/api/users/:username', auth, requireRole('admin'), async (req, res) => {
  const { username } = req.params;
  const { password, fullname, role, department, eval_title } = req.body || {};
  if (!fullname || !role) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc.' });
  if (role !== 'bgd' && role !== 'admin' && !DEPARTMENTS.includes(department)) return res.status(400).json({ error: 'Vui lòng chọn phòng ban hợp lệ.' });
  if (role === 'bgd' && !['pho_truong_don_vi', 'truong_don_vi'].includes(eval_title)) return res.status(400).json({ error: 'Vui lòng chọn cột phụ trách chấm điểm cho tài khoản Ban giám đốc.' });
  const finalEvalTitle = role === 'bgd' ? eval_title : null;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash=$1, fullname=$2, role=$3, department=$4, eval_title=$5 WHERE username=$6', [
        hash, fullname, role, department || '', finalEvalTitle, username,
      ]);
    } else {
      await pool.query('UPDATE users SET fullname=$1, role=$2, department=$3, eval_title=$4 WHERE username=$5', [
        fullname, role, department || '', finalEvalTitle, username,
      ]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

app.delete('/api/users/:username', auth, requireRole('admin'), async (req, res) => {
  if (req.params.username === req.user.username) return res.status(400).json({ error: 'Không thể xoá tài khoản đang đăng nhập.' });
  await pool.query('DELETE FROM users WHERE username=$1', [req.params.username]);
  res.json({ ok: true });
});

/* ---------------- NHẬT KÝ CỦA BẢN THÂN ---------------- */
app.get('/api/logs/:date', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT morning, afternoon, overtime FROM logs WHERE username=$1 AND log_date=$2', [
    req.user.username, req.params.date,
  ]);
  res.json(rows[0] || { morning: [], afternoon: [], overtime: [] });
});

app.put('/api/logs/:date', auth, async (req, res) => {
  const { morning = [], afternoon = [], overtime = [] } = req.body || {};
  if (!validSessions(morning, afternoon, overtime)) return res.status(400).json({ error: 'Tổng số phút vượt quá giới hạn cho phép.' });
  await pool.query(
    `INSERT INTO logs (username, log_date, morning, afternoon, overtime)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (username, log_date) DO UPDATE SET morning=$3, afternoon=$4, overtime=$5`,
    [req.user.username, req.params.date, JSON.stringify(morning), JSON.stringify(afternoon), JSON.stringify(overtime)]
  );
  res.json({ ok: true });
});

app.get('/api/logs', auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 366);
  const { rows } = await pool.query(
    `SELECT to_char(log_date,'YYYY-MM-DD') AS date, morning, afternoon, overtime
     FROM logs WHERE username=$1 ORDER BY log_date DESC LIMIT $2`,
    [req.user.username, limit]
  );
  res.json({ logs: rows });
});

app.get('/api/logs-month', auth, async (req, res) => {
  const { year, month, username } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'Thiếu năm/tháng.' });
  let targetUser = req.user.username;
  if (username && username !== req.user.username) {
    if (req.user.role === 'bgd' || req.user.role === 'admin') {
      targetUser = username;
    } else if (req.user.role === 'truong_phong' || req.user.role === 'pho_phong') {
      const { rows } = await pool.query('SELECT department FROM users WHERE username=$1', [username]);
      if (!rows[0] || rows[0].department !== req.user.department) {
        return res.status(403).json({ error: 'Bạn không có quyền xem dữ liệu của người này.' });
      }
      targetUser = username;
    } else {
      return res.status(403).json({ error: 'Bạn không có quyền xem dữ liệu của người khác.' });
    }
  }
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const { rows } = await pool.query(
    `SELECT to_char(log_date,'YYYY-MM-DD') AS date, morning, afternoon, overtime
     FROM logs WHERE username=$1 AND to_char(log_date,'YYYY-MM')=$2 ORDER BY log_date`,
    [targetUser, ym]
  );
  res.json({ logs: rows });
});

/* ---------------- BÁO CÁO (Trưởng/Phó phòng, BGĐ) ---------------- */
app.get('/api/report', auth, requireRole('truong_phong', 'pho_phong', 'bgd', 'admin'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Thiếu khoảng ngày.' });
  let department = req.query.department || null;
  if (req.user.role === 'truong_phong' || req.user.role === 'pho_phong') department = req.user.department;

  const useDept = department && department !== 'all';

  const usersParams = [];
  let usersWhere = "WHERE role != 'admin'";
  if (useDept) { usersParams.push(department); usersWhere += ' AND department = $1'; }
  const { rows: users } = await pool.query(
    `SELECT username, fullname, department, role FROM users ${usersWhere} ORDER BY (role = 'truong_phong') DESC, (role = 'pho_phong') DESC, fullname`,
    usersParams
  );

  const logParams = [from, to];
  let logWhere = '';
  if (useDept) { logParams.push(department); logWhere = 'AND u.department = $3'; }
  const { rows: logs } = await pool.query(
    `SELECT l.username, to_char(l.log_date,'YYYY-MM-DD') AS date, l.morning, l.afternoon, l.overtime
     FROM logs l JOIN users u ON u.username = l.username
     WHERE l.log_date BETWEEN $1 AND $2 ${logWhere}
     ORDER BY l.log_date`,
    logParams
  );

  const byUser = {};
  users.forEach(u => { byUser[u.username] = { username: u.username, fullname: u.fullname, department: u.department, role: u.role, days: [] }; });
  logs.forEach(l => {
    if (!byUser[l.username]) return;
    if ((l.morning || []).length + (l.afternoon || []).length + (l.overtime || []).length === 0) return;
    byUser[l.username].days.push({ date: l.date, morning: l.morning, afternoon: l.afternoon, overtime: l.overtime });
  });

  res.json({ rows: Object.values(byUser), departments: DEPARTMENTS });
});

/* ---------------- PHIẾU ĐÁNH GIÁ HÀNG THÁNG ---------------- */
// Tính quyền xem/chấm điểm của người gọi API đối với phiếu của 1 người cụ thể.
const EVAL_FIELD_LEVEL = { nld: 0, ld_phong: 1, pho_truong: 2, truong_don_vi: 3 };

async function getEvalPermissions(reqUser, targetUsername) {
  const { rows } = await pool.query('SELECT username, fullname, role, department FROM users WHERE username=$1', [targetUsername]);
  const target = rows[0];
  if (!target) return null;
  const editable = new Set();
  let canView = false;
  let viewLevel = -1;

  if (reqUser.username === targetUsername && !['bgd', 'admin'].includes(reqUser.role)) {
    editable.add('nld');
    canView = true;
    viewLevel = Math.max(viewLevel, EVAL_FIELD_LEVEL.nld);
  }
  if (reqUser.role === 'truong_phong' && target.role === 'nhan_vien' && target.department === reqUser.department) {
    editable.add('ld_phong');
    editable.add('ghi_chu');
    canView = true;
    viewLevel = Math.max(viewLevel, EVAL_FIELD_LEVEL.ld_phong);
  }
  if (reqUser.role === 'bgd' && reqUser.eval_title === 'pho_truong_don_vi' && !['bgd', 'admin'].includes(target.role)) {
    editable.add('pho_truong');
    editable.add('ghi_chu');
    canView = true;
    viewLevel = Math.max(viewLevel, EVAL_FIELD_LEVEL.pho_truong);
  }
  if (reqUser.role === 'bgd' && reqUser.eval_title === 'truong_don_vi' && !['bgd', 'admin'].includes(target.role)) {
    editable.add('truong_don_vi');
    editable.add('ghi_chu');
    canView = true;
    viewLevel = Math.max(viewLevel, EVAL_FIELD_LEVEL.truong_don_vi);
  }
  if (reqUser.role === 'admin') { canView = true; viewLevel = 3; } // Quản trị chỉ xem, không chấm điểm

  return { target, editable, canView, viewLevel };
}

// Che (ẩn) các cột chấm điểm ở cấp cao hơn cấp được xem — cấp dưới không thấy điểm cấp trên đã chấm cho mình.
function maskScoresByLevel(scores, viewLevel) {
  return scores.map(row => {
    const r = { ...row };
    if (viewLevel < EVAL_FIELD_LEVEL.ld_phong) r.ld_phong = null;
    if (viewLevel < EVAL_FIELD_LEVEL.pho_truong) r.pho_truong = null;
    if (viewLevel < EVAL_FIELD_LEVEL.truong_don_vi) r.truong_don_vi = null;
    return r;
  });
}

// Danh sách người cần đánh giá trong phạm vi phụ trách (dùng cho Trưởng phòng / Ban giám đốc)
app.get('/api/evaluations', auth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'Thiếu năm/tháng.' });
  let users = [];
  try {
    if (req.user.role === 'truong_phong') {
      const r = await pool.query(
        `SELECT username, fullname, role, department FROM users WHERE department=$1 AND role IN ('nhan_vien','truong_phong') ORDER BY (role='truong_phong') DESC, fullname`,
        [req.user.department]
      );
      users = r.rows;
    } else if (req.user.role === 'bgd') {
      const department = req.query.department;
      const params = [];
      let where = "WHERE role NOT IN ('bgd','admin')";
      if (department && department !== 'all') { params.push(department); where += ' AND department = $1'; }
      const r = await pool.query(
        `SELECT username, fullname, role, department FROM users ${where} ORDER BY (role='truong_phong') DESC, (role='pho_phong') DESC, fullname`,
        params
      );
      users = r.rows;
    } else if (req.user.role === 'admin') {
      const r = await pool.query(`SELECT username, fullname, role, department FROM users WHERE role NOT IN ('admin') ORDER BY fullname`);
      users = r.rows;
    } else {
      users = [{ username: req.user.username, fullname: req.user.fullname, role: req.user.role, department: req.user.department }];
    }
    const { rows: evalRows } = await pool.query(
      `SELECT username, scores, submitted FROM evaluations WHERE year=$1 AND month=$2`,
      [year, month]
    );
    const byUser = Object.fromEntries(evalRows.map(e => [e.username, e]));
    const canSeeAvg = ['bgd', 'admin'].includes(req.user.role);
    const result = users.map(u => {
      const ev = byUser[u.username];
      const scores = ev ? ev.scores : defaultEvalScores();
      const submitted = ev ? ev.submitted : defaultEvalSubmitted();
      const avg = scores.reduce((s, r) => s + (r.nld + r.ld_phong + r.pho_truong + r.truong_don_vi) / 4, 0);
      return { ...u, submitted, avgScore: canSeeAvg ? Math.round(avg * 10) / 10 : null };
    });
    res.json({ rows: result, departments: DEPARTMENTS, criteria: EVAL_CRITERIA });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

app.get('/api/evaluations/:username/:year/:month', auth, async (req, res) => {
  const { username, year, month } = req.params;
  try {
    const perm = await getEvalPermissions(req.user, username);
    if (!perm) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
    if (!perm.canView) return res.status(403).json({ error: 'Bạn không có quyền xem phiếu này.' });
    const { rows } = await pool.query('SELECT scores, submitted FROM evaluations WHERE username=$1 AND year=$2 AND month=$3', [username, year, month]);
    const record = rows[0];
    const rawScores = record ? record.scores : defaultEvalScores();
    const canSeeAvg = ['bgd', 'admin'].includes(req.user.role);
    const withAvg = rawScores.map(r => ({
      ...r,
      avg: canSeeAvg ? Math.round(((Number(r.nld||0)+Number(r.ld_phong||0)+Number(r.pho_truong||0)+Number(r.truong_don_vi||0))/4)*10)/10 : null,
    }));
    const totalsRaw = rawScores.reduce((t, r) => ({
      nld: t.nld+Number(r.nld||0), ld_phong: t.ld_phong+Number(r.ld_phong||0),
      pho_truong: t.pho_truong+Number(r.pho_truong||0), truong_don_vi: t.truong_don_vi+Number(r.truong_don_vi||0),
    }), { nld:0, ld_phong:0, pho_truong:0, truong_don_vi:0 });
    const totalAvg = canSeeAvg ? Math.round(((totalsRaw.nld+totalsRaw.ld_phong+totalsRaw.pho_truong+totalsRaw.truong_don_vi)/4)*10)/10 : null;
    res.json({
      target: perm.target,
      year: Number(year),
      month: Number(month),
      criteria: EVAL_CRITERIA,
      scores: maskScoresByLevel(withAvg, perm.viewLevel),
      totalAvg,
      submitted: record ? record.submitted : defaultEvalSubmitted(),
      editableFields: Array.from(perm.editable),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

app.put('/api/evaluations/:username/:year/:month', auth, async (req, res) => {
  const { username, year, month } = req.params;
  const { scores } = req.body || {};
  if (!Array.isArray(scores)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ.' });
  try {
    const perm = await getEvalPermissions(req.user, username);
    if (!perm) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
    if (perm.editable.size === 0) return res.status(403).json({ error: 'Bạn không có quyền chấm điểm phiếu này.' });

    const { rows } = await pool.query('SELECT scores, submitted FROM evaluations WHERE username=$1 AND year=$2 AND month=$3', [username, year, month]);
    const current = rows[0] ? rows[0].scores : defaultEvalScores();
    const currentSubmitted = rows[0] ? rows[0].submitted : defaultEvalSubmitted();

    // Đã chốt điểm (Lưu) trước đó thì khoá vĩnh viễn, không ai được sửa nữa — kể cả người đã chấm.
    const ownField = ['nld', 'ld_phong', 'pho_truong', 'truong_don_vi'].find(f => perm.editable.has(f));
    if (ownField && currentSubmitted[ownField]) {
      return res.status(409).json({ error: 'Điểm này đã được lưu và chốt, không thể chỉnh sửa nữa.' });
    }

    const byId = Object.fromEntries(current.map(r => [r.id, { ...r }]));
    for (const incoming of scores) {
      const row = byId[incoming.id];
      const criterion = EVAL_CRITERIA.find(c => c.id === incoming.id);
      if (!row || !criterion) continue;
      for (const field of ['nld', 'ld_phong', 'pho_truong', 'truong_don_vi']) {
        if (perm.editable.has(field) && incoming[field] !== undefined) {
          const v = Number(incoming[field]);
          if (Number.isFinite(v) && v >= 0 && v <= criterion.max) row[field] = v;
        }
      }
      if (perm.editable.has('ghi_chu') && typeof incoming.ghi_chu === 'string') {
        row.ghi_chu = incoming.ghi_chu.slice(0, 500);
      }
    }
    const merged = EVAL_CRITERIA.map(c => byId[c.id]);
    const newSubmitted = { ...currentSubmitted };
    for (const field of ['nld', 'ld_phong', 'pho_truong', 'truong_don_vi']) {
      if (perm.editable.has(field)) newSubmitted[field] = true;
    }

    await pool.query(
      `INSERT INTO evaluations (username, year, month, scores, submitted, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (username, year, month) DO UPDATE SET scores=$4, submitted=$5, updated_at=now()`,
      [username, year, month, JSON.stringify(merged), JSON.stringify(newSubmitted)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

/* ---------------- SAO LƯU & KHÔI PHỤC (chỉ BGĐ) ---------------- */
app.get('/api/admin/export', auth, requireRole('admin'), async (req, res) => {
  try {
    const usersRes = await pool.query('SELECT username, password_hash, fullname, role, department, eval_title FROM users ORDER BY username');
    const logsRes = await pool.query(
      `SELECT username, to_char(log_date,'YYYY-MM-DD') AS log_date, morning, afternoon, overtime
       FROM logs ORDER BY username, log_date`
    );
    const evalRes = await pool.query(
      `SELECT username, year, month, scores, submitted FROM evaluations ORDER BY username, year, month`
    );
    res.json({ users: usersRes.rows, logs: logsRes.rows, evaluations: evalRes.rows, exportedAt: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Không thể xuất dữ liệu.' });
  }
});

app.post('/api/admin/import', auth, requireRole('admin'), async (req, res) => {
  const { users, logs, evaluations } = req.body || {};
  if (!Array.isArray(users) || !Array.isArray(logs)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let usersImported = 0;
    for (const u of users) {
      if (!u || !u.username || !u.password_hash || !u.fullname || !u.role) continue;
      await client.query(
        `INSERT INTO users (username, password_hash, fullname, role, department, eval_title)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (username) DO UPDATE SET password_hash=$2, fullname=$3, role=$4, department=$5, eval_title=$6`,
        [u.username, u.password_hash, u.fullname, u.role, u.department || '', u.eval_title || null]
      );
      usersImported++;
    }
    let logsImported = 0;
    for (const l of logs) {
      if (!l || !l.username || !l.log_date) continue;
      await client.query(
        `INSERT INTO logs (username, log_date, morning, afternoon, overtime)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (username, log_date) DO UPDATE SET morning=$3, afternoon=$4, overtime=$5`,
        [l.username, l.log_date, JSON.stringify(l.morning || []), JSON.stringify(l.afternoon || []), JSON.stringify(l.overtime || [])]
      );
      logsImported++;
    }
    let evalsImported = 0;
    for (const ev of (Array.isArray(evaluations) ? evaluations : [])) {
      if (!ev || !ev.username || !ev.year || !ev.month) continue;
      await client.query(
        `INSERT INTO evaluations (username, year, month, scores, submitted, updated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (username, year, month) DO UPDATE SET scores=$4, submitted=$5, updated_at=now()`,
        [ev.username, ev.year, ev.month, JSON.stringify(ev.scores || []), JSON.stringify(ev.submitted || defaultEvalSubmitted())]
      );
      evalsImported++;
    }
    await client.query('COMMIT');
    res.json({ ok: true, usersImported, logsImported, evalsImported });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Lỗi khi khôi phục dữ liệu: ' + e.message });
  } finally {
    client.release();
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy.' }));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log('Server đang chạy ở cổng ' + PORT));
  })
  .catch((err) => {
    console.error('Lỗi khởi tạo cơ sở dữ liệu:', err);
    process.exit(1);
  });
