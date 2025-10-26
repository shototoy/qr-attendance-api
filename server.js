import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import os from 'os';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'qr-attendance-secret-2024';
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'qr_attendance.db')
  : './qr_attendance.db';

const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads', 'staff')
  : path.join(__dirname, 'uploads', 'staff');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use('/uploads', express.static(path.dirname(uploadsDir)));

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    department TEXT,
    position TEXT,
    email TEXT,
    phone TEXT,
    role TEXT DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
    photo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id TEXT NOT NULL,
    date DATE NOT NULL,
    check_in DATETIME,
    check_out DATETIME,
    breaks TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES staff(id),
    UNIQUE (staff_id, date)
  );
`);

const adminExists = db.prepare('SELECT id FROM staff WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = await bcrypt.hash('admin123', 10);
  db.prepare(`
    INSERT INTO staff (id, name, username, password, role, department, position) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('ADMIN001', 'Administrator', 'admin', hash, 'admin', 'Management', 'System Administrator');
  console.log('✅ Default admin account created (username: admin, password: admin123)');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const staffId = req.body.staffId || 'temp';
    const ext = path.extname(file.originalname);
    cb(null, `${staffId}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only JPG and PNG images allowed'));
  }
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM staff WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    console.log(`✓ Login: ${username} (${user.role})`);
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        name: user.name, 
        username: user.username, 
        role: user.role, 
        department: user.department, 
        position: user.position 
      } 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff', auth, async (req, res) => {
  try {
    const staff = db.prepare(`
      SELECT id, name, username, department, position, email, phone, role, photo, created_at
      FROM staff 
      ORDER BY name
    `).all();
    const localIP = getLocalIP();
    const protocol = process.env.RAILWAY_STATIC_URL ? 'https' : 'http';
    const host = process.env.RAILWAY_STATIC_URL || `${localIP}:${PORT}`;
    const staffWithFullUrls = staff.map(member => {
      if (member.photo) {
        if (!member.photo.startsWith('http')) {
          member.photo_url = `${protocol}://${host}${member.photo}`;
        } else {
          member.photo_url = member.photo;
        }
      }
      return member;
    });
    res.json(staffWithFullUrls);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/staff', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { id, name, username, password, department, position, email, phone } = req.body;
    const hash = await bcrypt.hash(password, 10);
    db.prepare(
      'INSERT INTO staff (id, name, username, password, department, position, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, username, hash, department, position, email, phone);
    console.log(`✓ Staff added: ${name} (${id})`);
    res.json({ success: true, message: 'Staff added successfully', staffId: id });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') {
      res.status(400).json({ error: 'Username or ID already exists' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

app.post('/api/staff/photo', auth, upload.single('photo'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ error: 'Staff ID required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }
    const photoUrl = `/uploads/staff/${req.file.filename}`;
    const protocol = process.env.RAILWAY_STATIC_URL ? 'https' : 'http';
    const localIP = getLocalIP();
    const host = process.env.RAILWAY_STATIC_URL || `${localIP}:${PORT}`;
    const fullPhotoUrl = `${protocol}://${host}${photoUrl}`;
    try {
      const oldRecord = db.prepare('SELECT photo FROM staff WHERE id = ?').get(staffId);
      if (oldRecord?.photo) {
        const oldFilename = path.basename(oldRecord.photo);
        const oldPath = path.join(uploadsDir, oldFilename);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
    } catch (deleteErr) {}
    const updateResult = db.prepare('UPDATE staff SET photo = ? WHERE id = ?').run(photoUrl, staffId);
    if (updateResult.changes === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(staffId);
    console.log(`✓ Photo uploaded: ${staff?.name || staffId}`);
    res.json({ 
      success: true, 
      photoUrl,
      photo_url: fullPhotoUrl,
      message: 'Photo uploaded successfully'
    });
  } catch (e) {
    if (req.file) {
      const uploadedPath = path.join(uploadsDir, req.file.filename);
      if (fs.existsSync(uploadedPath)) {
        fs.unlinkSync(uploadedPath);
      }
    }
    res.status(500).json({ 
      error: 'Photo upload failed',
      details: e.message 
    });
  }
});

app.delete('/api/staff/:staffId/photo', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { staffId } = req.params;
    if (!staffId) {
      return res.status(400).json({ error: 'Staff ID required' });
    }
    const staffRecord = db.prepare('SELECT photo FROM staff WHERE id = ?').get(staffId);
    if (!staffRecord) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    if (staffRecord.photo) {
      const filename = path.basename(staffRecord.photo);
      const filePath = path.join(uploadsDir, filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (deleteErr) {
          console.error('Error deleting file:', deleteErr);
        }
      }
    }
    const updateResult = db.prepare('UPDATE staff SET photo = NULL WHERE id = ?').run(staffId);
    if (updateResult.changes === 0) {
      return res.status(404).json({ error: 'Failed to update staff record' });
    }
    const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(staffId);
    console.log(`✓ Photo removed: ${staff?.name || staffId}`);
    res.json({ 
      success: true, 
      message: 'Photo removed successfully'
    });
  } catch (e) {
    res.status(500).json({ 
      error: 'Photo removal failed',
      details: e.message 
    });
  }
});

app.post('/api/checkin', auth, async (req, res) => {
  try {
    const { staffId } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const existing = db.prepare(
      'SELECT * FROM attendance WHERE staff_id = ? AND date = ?'
    ).get(staffId, today);
    if (existing) {
      return res.status(400).json({ error: 'Already checked in today' });
    }
    db.prepare(
      "INSERT INTO attendance (staff_id, date, check_in) VALUES (?, ?, datetime('now', 'localtime'))"
    ).run(staffId, today);
    const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(staffId);
    console.log(`✓ Check-in: ${staff?.name || staffId}`);
    res.json({ success: true, message: 'Check-in successful' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkout', auth, async (req, res) => {
  try {
    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ success: false, error: 'Staff ID is required' });
    }
    const record = db.prepare(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1'
    ).get(staffId);
    if (!record) {
      return res.status(400).json({ success: false, error: 'No active check-in found' });
    }
    let breaks = [];
    let breaksAutoEnded = false;
    if (record.breaks) {
      try {
        breaks = JSON.parse(record.breaks);
        if (!Array.isArray(breaks)) breaks = [];
      } catch (e) {
        breaks = [];
      }
    }
    breaks = breaks.map(brk => {
      if (brk.start && !brk.end) {
        breaksAutoEnded = true;
        return { start: brk.start, end: new Date().toISOString(), auto_ended: true };
      }
      return brk;
    });
    db.prepare(
      "UPDATE attendance SET check_out = datetime('now', 'localtime'), breaks = ? WHERE id = ?"
    ).run(JSON.stringify(breaks), record.id);
    const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(staffId);
    const staffName = staff?.name || staffId;
    console.log(`✓ Check-out: ${staffName}${breaksAutoEnded ? ' (break auto-ended)' : ''}`);
    res.json({ 
      success: true, 
      message: breaksAutoEnded ? `${staffName} checked out (active break was auto-ended)` : `${staffName} checked out successfully`,
      breaks_auto_ended: breaksAutoEnded
    });
  } catch (e) {
    console.error('Checkout error:', e);
    res.status(500).json({ success: false, error: 'Server error during checkout', details: e.message });
  }
});

app.post('/api/attendance/break/start', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }
    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ success: false, error: 'Staff ID is required' });
    }
    const record = db.prepare(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1'
    ).get(staffId);
    if (!record) {
      return res.status(400).json({ success: false, error: 'No active shift found. Please check in first.' });
    }
    let breaks = [];
    if (record.breaks) {
      try {
        breaks = JSON.parse(record.breaks);
        if (!Array.isArray(breaks)) breaks = [];
      } catch (e) {
        breaks = [];
      }
    }
    const hasActiveBreak = breaks.some(b => b.start && !b.end);
    if (hasActiveBreak) {
      return res.status(400).json({ success: false, error: 'Already on break' });
    }
    const now = new Date().toISOString();
    breaks.push({ start: now });
    db.prepare('UPDATE attendance SET breaks = ? WHERE id = ?').run(JSON.stringify(breaks), record.id);
    const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(staffId);
    console.log(`✓ Break started: ${staff?.name || staffId}`);
    res.json({ success: true, message: `${staff?.name || 'Staff'} started break`, break_start: now });
  } catch (e) {
    console.error('Start break error:', e);
    res.status(500).json({ success: false, error: 'Server error while starting break', details: e.message });
  }
});

app.post('/api/attendance/break/end', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }
    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ success: false, error: 'Staff ID is required' });
    }
    const record = db.prepare(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1'
    ).get(staffId);
    if (!record) {
      return res.status(400).json({ success: false, error: 'No active shift found' });
    }
    let breaks = [];
    if (record.breaks) {
      try {
        breaks = JSON.parse(record.breaks);
        if (!Array.isArray(breaks)) breaks = [];
      } catch (e) {
        breaks = [];
      }
    }
    const activeBreakIndex = breaks.findIndex(b => b.start && !b.end);
    if (activeBreakIndex === -1) {
      return res.status(400).json({ success: false, error: 'No active break found' });
    }
    const now = new Date().toISOString();
    breaks[activeBreakIndex].end = now;
    db.prepare('UPDATE attendance SET breaks = ? WHERE id = ?').run(JSON.stringify(breaks), record.id);
    const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(staffId);
    const breakStart = new Date(breaks[activeBreakIndex].start);
    const breakEnd = new Date(now);
    const breakMinutes = Math.floor((breakEnd - breakStart) / (1000 * 60));
    console.log(`✓ Break ended: ${staff?.name || staffId} (${breakMinutes} min)`);
    res.json({ 
      success: true, 
      message: `${staff?.name || 'Staff'} ended break (${breakMinutes} minutes)`,
      break_end: now,
      break_duration_minutes: breakMinutes
    });
  } catch (e) {
    console.error('End break error:', e);
    res.status(500).json({ success: false, error: 'Server error while ending break', details: e.message });
  }
});

app.get('/api/attendance/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const records = db.prepare(`
      SELECT a.*, s.name as staff_name, s.department 
      FROM attendance a 
      JOIN staff s ON a.staff_id = s.id 
      WHERE a.date = ? 
      ORDER BY a.check_in DESC
    `).all(today);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attendance/history', auth, async (req, res) => {
  try {
    const { staffId } = req.query;
    let query = `
      SELECT a.*, s.name as staff_name, s.department 
      FROM attendance a 
      JOIN staff s ON a.staff_id = s.id
    `;
    let params = [];
    if (staffId) {
      query += ' WHERE a.staff_id = ?';
      params.push(staffId);
    }
    query += ' ORDER BY a.date DESC, a.check_in DESC LIMIT 100';
    const records = db.prepare(query).all(...params);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff/:id/photo-base64', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const staff = db.prepare('SELECT photo FROM staff WHERE id = ?').get(id);
    if (!staff?.photo) {
      return res.status(404).json({ error: 'No photo found' });
    }
    const photoPath = path.join(__dirname, staff.photo);
    if (!fs.existsSync(photoPath)) {
      return res.status(404).json({ error: 'Photo file not found' });
    }
    const imageBuffer = fs.readFileSync(photoPath);
    const base64 = imageBuffer.toString('base64');
    const ext = path.extname(photoPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64}`;
    res.json({ 
      success: true,
      data: dataUri,
      staffId: id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`\n✅ Server running on:`);
  console.log(`  - Local:   http://localhost:${PORT}`);
  console.log(`  - Network: http://${localIP}:${PORT}`);
  console.log(`  - Database: ${dbPath}\n`);
});