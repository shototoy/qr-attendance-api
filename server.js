import express from 'express';
import cors from 'cors';
import { initDB, getDB } from './db.js';
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

await initDB();

const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'staff')
  : path.join(__dirname, 'uploads', 'staff');

const assetsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

const copyLogoToVolume = () => {
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    const repoLogoPath = path.join(__dirname, 'uploads', 'logo.png');
    const volumeLogoPath = path.join(assetsDir, 'logo.png');
    
    if (fs.existsSync(repoLogoPath) && !fs.existsSync(volumeLogoPath)) {
      try {
        fs.copyFileSync(repoLogoPath, volumeLogoPath);
        console.log('✓ Logo copied to volume');
      } catch (error) {
        console.error('✗ Failed to copy logo:', error);
      }
    }
  }
};

copyLogoToVolume();

app.use('/uploads', express.static(path.dirname(uploadsDir)));
app.use('/uploads', express.static(assetsDir));

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
    const db = getDB();
    const [rows] = await db.execute('SELECT * FROM staff WHERE username = ?', [username]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
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
    const db = getDB();
    const [staff] = await db.execute(`
      SELECT id, name, username, department, position, email, phone, role, photo, created_at
      FROM staff 
      ORDER BY name
    `);
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
    const db = getDB();
    await db.execute(
      'INSERT INTO staff (id, name, username, password, department, position, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, username, hash, department, position, email, phone]
    );
    console.log(`✓ Staff added: ${name} (${id})`);
    res.json({ success: true, message: 'Staff added successfully', staffId: id });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
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
    const db = getDB();
    try {
      const [oldRecord] = await db.execute('SELECT photo FROM staff WHERE id = ?', [staffId]);
      if (oldRecord.length > 0 && oldRecord[0].photo) {
        const oldFilename = path.basename(oldRecord[0].photo);
        const oldPath = path.join(uploadsDir, oldFilename);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
    } catch (deleteErr) {}
    const [updateResult] = await db.execute('UPDATE staff SET photo = ? WHERE id = ?', [photoUrl, staffId]);
    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    console.log(`✓ Photo uploaded: ${staff[0]?.name || staffId}`);
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
    const db = getDB();
    const [staffRecord] = await db.execute('SELECT photo FROM staff WHERE id = ?', [staffId]);
    if (staffRecord.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    if (staffRecord[0].photo) {
      const filename = path.basename(staffRecord[0].photo);
      const filePath = path.join(uploadsDir, filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (deleteErr) {
          console.error('✗ Error deleting file:', deleteErr);
        }
      }
    }
    const [updateResult] = await db.execute('UPDATE staff SET photo = NULL WHERE id = ?', [staffId]);
    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Failed to update staff record' });
    }
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    console.log(`✓ Photo removed: ${staff[0]?.name || staffId}`);
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
    const db = getDB();
    const [existing] = await db.execute(
      'SELECT * FROM attendance WHERE staff_id = ? AND date = ?',
      [staffId, today]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Already checked in today' });
    }
    await db.execute(
      'INSERT INTO attendance (staff_id, date, check_in) VALUES (?, ?, NOW())',
      [staffId, today]
    );
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    console.log(`✓ Check-in: ${staff[0]?.name || staffId}`);
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
    const db = getDB();
    const [records] = await db.execute(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
      [staffId]
    );
    if (records.length === 0) {
      return res.status(400).json({ success: false, error: 'No active check-in found' });
    }
    const record = records[0];
    let breaks = [];
    let breaksAutoEnded = false;
    if (record.breaks) {
      try {
        breaks = typeof record.breaks === 'string' ? JSON.parse(record.breaks) : record.breaks;
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
    await db.execute(
      'UPDATE attendance SET check_out = NOW(), breaks = ? WHERE id = ?',
      [JSON.stringify(breaks), record.id]
    );
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    const staffName = staff[0]?.name || staffId;
    console.log(`✓ Check-out: ${staffName}${breaksAutoEnded ? ' (break auto-ended)' : ''}`);
    res.json({ 
      success: true, 
      message: breaksAutoEnded ? `${staffName} checked out (active break was auto-ended)` : `${staffName} checked out successfully`,
      breaks_auto_ended: breaksAutoEnded
    });
  } catch (e) {
    console.error('✗ Checkout error:', e);
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
    const db = getDB();
    const [records] = await db.execute(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
      [staffId]
    );
    if (records.length === 0) {
      return res.status(400).json({ success: false, error: 'No active shift found. Please check in first.' });
    }
    const record = records[0];
    let breaks = [];
    if (record.breaks) {
      try {
        breaks = typeof record.breaks === 'string' ? JSON.parse(record.breaks) : record.breaks;
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
    await db.execute('UPDATE attendance SET breaks = ? WHERE id = ?', [JSON.stringify(breaks), record.id]);
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    console.log(`✓ Break started: ${staff[0]?.name || staffId}`);
    res.json({ success: true, message: `${staff[0]?.name || 'Staff'} started break`, break_start: now });
  } catch (e) {
    console.error('✗ Start break error:', e);
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
    const db = getDB();
    const [records] = await db.execute(
      'SELECT * FROM attendance WHERE staff_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
      [staffId]
    );
    if (records.length === 0) {
      return res.status(400).json({ success: false, error: 'No active shift found' });
    }
    const record = records[0];
    let breaks = [];
    if (record.breaks) {
      try {
        breaks = typeof record.breaks === 'string' ? JSON.parse(record.breaks) : record.breaks;
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
    await db.execute('UPDATE attendance SET breaks = ? WHERE id = ?', [JSON.stringify(breaks), record.id]);
    const [staff] = await db.execute('SELECT name FROM staff WHERE id = ?', [staffId]);
    const breakStart = new Date(breaks[activeBreakIndex].start);
    const breakEnd = new Date(now);
    const breakMinutes = Math.floor((breakEnd - breakStart) / (1000 * 60));
    console.log(`✓ Break ended: ${staff[0]?.name || staffId} (${breakMinutes} min)`);
    res.json({ 
      success: true, 
      message: `${staff[0]?.name || 'Staff'} ended break (${breakMinutes} minutes)`,
      break_end: now,
      break_duration_minutes: breakMinutes
    });
  } catch (e) {
    console.error('✗ End break error:', e);
    res.status(500).json({ success: false, error: 'Server error while ending break', details: e.message });
  }
});

app.get('/api/attendance/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const db = getDB();
    const [records] = await db.execute(`
      SELECT a.*, s.name as staff_name, s.department 
      FROM attendance a 
      JOIN staff s ON a.staff_id = s.id 
      WHERE a.date = ? 
      ORDER BY a.check_in DESC
    `, [today]);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attendance/history', auth, async (req, res) => {
  try {
    const { staffId } = req.query;
    const db = getDB();
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
    const [records] = await db.execute(query, params);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff/:id/photo-base64', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDB();
    const [staff] = await db.execute('SELECT photo FROM staff WHERE id = ?', [id]);
    if (staff.length === 0 || !staff[0]?.photo) {
      return res.status(404).json({ error: 'No photo found' });
    }
    const photoPath = staff[0].photo.startsWith('/') 
      ? path.join(path.dirname(uploadsDir), staff[0].photo.replace('/uploads/', ''))
      : path.join(__dirname, staff[0].photo);
    
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

app.get('/api/logo/base64', async (req, res) => {
  try {
    const logoPath = path.join(assetsDir, 'logo.png');
    
    if (!fs.existsSync(logoPath)) {
      return res.status(404).json({ error: 'Logo file not found' });
    }
    
    const imageBuffer = fs.readFileSync(logoPath);
    const base64 = imageBuffer.toString('base64');
    const ext = path.extname(logoPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64}`;
    
    res.json({ 
      success: true,
      data: dataUri
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('✓ Server running');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}`);
});