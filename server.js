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
      role TEXT NOT NULL CHECK (role IN ('bgd','truong_pho','nhan_vien')),
      department TEXT NOT NULL DEFAULT ''
    );
  `);
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
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, fullname, role, department) VALUES ($1,$2,$3,$4,$5)',
      ['admin', hash, 'Quản trị viên', 'bgd', '']
    );
    console.log('Đã tạo tài khoản quản trị mặc định: admin / admin123 — hãy đăng nhập và đổi mật khẩu ngay.');
  }
}

function sign(user) {
  return jwt.sign(
    { username: user.username, role: user.role, department: user.department, fullname: user.fullname },
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
    const profile = { username: u.username, fullname: u.fullname, role: u.role, department: u.department };
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
app.get('/api/users', auth, requireRole('bgd'), async (req, res) => {
  const { rows } = await pool.query('SELECT username, fullname, role, department FROM users ORDER BY fullname');
  res.json({ users: rows, departments: DEPARTMENTS });
});

app.post('/api/users', auth, requireRole('bgd'), async (req, res) => {
  const { username, password, fullname, role, department } = req.body || {};
  if (!username || !password || !fullname || !role) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc.' });
  if (!['bgd', 'truong_pho', 'nhan_vien'].includes(role)) return res.status(400).json({ error: 'Cấp bậc không hợp lệ.' });
  if (role !== 'bgd' && !DEPARTMENTS.includes(department)) return res.status(400).json({ error: 'Vui lòng chọn phòng ban hợp lệ.' });
  try {
    const exists = await pool.query('SELECT 1 FROM users WHERE username=$1', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, fullname, role, department) VALUES ($1,$2,$3,$4,$5)',
      [username, hash, fullname, role, department || '']
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

app.put('/api/users/:username', auth, requireRole('bgd'), async (req, res) => {
  const { username } = req.params;
  const { password, fullname, role, department } = req.body || {};
  if (!fullname || !role) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc.' });
  if (role !== 'bgd' && !DEPARTMENTS.includes(department)) return res.status(400).json({ error: 'Vui lòng chọn phòng ban hợp lệ.' });
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash=$1, fullname=$2, role=$3, department=$4 WHERE username=$5', [
        hash, fullname, role, department || '', username,
      ]);
    } else {
      await pool.query('UPDATE users SET fullname=$1, role=$2, department=$3 WHERE username=$4', [
        fullname, role, department || '', username,
      ]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

app.delete('/api/users/:username', auth, requireRole('bgd'), async (req, res) => {
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
    if (req.user.role === 'bgd') {
      targetUser = username;
    } else if (req.user.role === 'truong_pho') {
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
app.get('/api/report', auth, requireRole('truong_pho', 'bgd'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Thiếu khoảng ngày.' });
  let department = req.query.department || null;
  if (req.user.role === 'truong_pho') department = req.user.department;

  const useDept = department && department !== 'all';

  const usersParams = [];
  let usersWhere = '';
  if (useDept) { usersParams.push(department); usersWhere = 'WHERE department = $1'; }
  const { rows: users } = await pool.query(
    `SELECT username, fullname, department, role FROM users ${usersWhere} ORDER BY (role = 'truong_pho') DESC, fullname`,
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

/* ---------------- SAO LƯU & KHÔI PHỤC (chỉ BGĐ) ---------------- */
app.get('/api/admin/export', auth, requireRole('bgd'), async (req, res) => {
  try {
    const usersRes = await pool.query('SELECT username, password_hash, fullname, role, department FROM users ORDER BY username');
    const logsRes = await pool.query(
      `SELECT username, to_char(log_date,'YYYY-MM-DD') AS log_date, morning, afternoon, overtime
       FROM logs ORDER BY username, log_date`
    );
    res.json({ users: usersRes.rows, logs: logsRes.rows, exportedAt: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Không thể xuất dữ liệu.' });
  }
});

app.post('/api/admin/import', auth, requireRole('bgd'), async (req, res) => {
  const { users, logs } = req.body || {};
  if (!Array.isArray(users) || !Array.isArray(logs)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let usersImported = 0;
    for (const u of users) {
      if (!u || !u.username || !u.password_hash || !u.fullname || !u.role) continue;
      await client.query(
        `INSERT INTO users (username, password_hash, fullname, role, department)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (username) DO UPDATE SET password_hash=$2, fullname=$3, role=$4, department=$5`,
        [u.username, u.password_hash, u.fullname, u.role, u.department || '']
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
    await client.query('COMMIT');
    res.json({ ok: true, usersImported, logsImported });
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
