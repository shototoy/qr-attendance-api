import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import os from 'os';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const app = express();
const JWT_SECRET = 'qr-attendance-secret-2024';
const PORT = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

const uploadsDir = path.join(__dirname, 'uploads', 'staff');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'qr_attendance',
  waitForConnections: true,
  connectionLimit: 10
});

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
    const [users] = await pool.query('SELECT * FROM staff WHERE username = ?', [username]);
    if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    
    const user = users[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    
    console.log(`[LOGIN] ${username} - ${user.role}`);
    
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
    const [staff] = await pool.query(`
      SELECT 
        id, 
        name, 
        username, 
        department, 
        position, 
        email, 
        phone, 
        role, 
        photo,
        created_at
      FROM staff 
      ORDER BY name
    `);
    
    const localIP = getLocalIP();
    const protocol = 'http';
    
    const staffWithFullUrls = staff.map(member => {
      if (member.photo) {
        if (!member.photo.startsWith('http')) {
          member.photo_url = `${protocol}://${localIP}:${PORT}${member.photo}`;
        } else {
          member.photo_url = member.photo;
        }
      }
      return member;
    });
    
    console.log(`[GET] /api/staff - ${staff.length} records`);
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
    
    await pool.query(
      'INSERT INTO staff (id, name, username, password, department, position, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, username, hash, department, position, email, phone]
    );
    
    console.log(`[POST] /api/staff - Added: ${name} (${id})`);
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
    const localIP = getLocalIP();
    const fullPhotoUrl = `http://${localIP}:${PORT}${photoUrl}`;
    
    try {
      const [oldRecord] = await pool.query('SELECT photo FROM staff WHERE id = ?', [staffId]);
      if (oldRecord[0]?.photo) {
        const oldFilename = path.basename(oldRecord[0].photo);
        const oldPath = path.join(uploadsDir, oldFilename);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
    } catch (deleteErr) {
    }
    
    const [updateResult] = await pool.query(
      'UPDATE staff SET photo = ? WHERE id = ?', 
      [photoUrl, staffId]
    );
    
    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    
    console.log(`[POST] /api/staff/photo - ${staffId}`);
    
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

app.post('/api/checkin', auth, async (req, res) => {
  try {
    const { staffId } = req.body;
    const today = new Date().toISOString().split('T')[0];
    
    const [existing] = await pool.query(
      'SELECT * FROM attendance WHERE staff_id = ? AND date = ?', 
      [staffId, today]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Already checked in today' });
    }
    
    await pool.query(
      'INSERT INTO attendance (staff_id, date, check_in) VALUES (?, ?, NOW())', 
      [staffId, today]
    );
    
    console.log(`[POST] /api/checkin - ${staffId}`);
    res.json({ success: true, message: 'Check-in successful' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkout', auth, async (req, res) => {
  try {
    const { staffId } = req.body;
    const today = new Date().toISOString().split('T')[0];
    
    const [record] = await pool.query(
      'SELECT * FROM attendance WHERE staff_id = ? AND date = ? AND check_out IS NULL', 
      [staffId, today]
    );
    
    if (record.length === 0) {
      return res.status(400).json({ error: 'No active check-in found' });
    }
    
    await pool.query(
      'UPDATE attendance SET check_out = NOW() WHERE staff_id = ? AND date = ?', 
      [staffId, today]
    );
    
    console.log(`[POST] /api/checkout - ${staffId}`);
    res.json({ success: true, message: 'Check-out successful' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attendance/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [records] = await pool.query(`
      SELECT a.*, s.name as staff_name, s.department 
      FROM attendance a 
      JOIN staff s ON a.staff_id = s.id 
      WHERE a.date = ? 
      ORDER BY a.check_in DESC
    `, [today]);
    
    console.log(`[GET] /api/attendance/today - ${records.length} records`);
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
    const [records] = await pool.query(query, params);
    
    console.log(`[GET] /api/attendance/history - ${records.length} records`);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff/:id/photo-base64', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const [staff] = await pool.query('SELECT photo FROM staff WHERE id = ?', [id]);
    
    if (!staff[0]?.photo) {
      return res.status(404).json({ error: 'No photo found' });
    }
    
    const photoPath = path.join(__dirname, staff[0].photo);
    
    if (!fs.existsSync(photoPath)) {
      return res.status(404).json({ error: 'Photo file not found' });
    }
    
    const imageBuffer = fs.readFileSync(photoPath);
    const base64 = imageBuffer.toString('base64');
    const ext = path.extname(photoPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    
    const dataUri = `data:${mimeType};base64,${base64}`;
    
    console.log(`[GET] /api/staff/${id}/photo-base64`);
    
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
  console.log(`  - Network: http://${localIP}:${PORT}\n`);
});