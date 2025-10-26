import { initDB, closeDB } from './db.js';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Setting up database...');

const uploadsDir = path.join(__dirname, 'uploads', 'staff');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('✓ Created uploads directory');
}

const db = await initDB();

await db.execute(`
  CREATE TABLE IF NOT EXISTS staff (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    department VARCHAR(100),
    position VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(50),
    role ENUM('admin', 'staff') DEFAULT 'staff',
    photo TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`);

await db.execute(`
  CREATE TABLE IF NOT EXISTS attendance (
    id INT AUTO_INCREMENT PRIMARY KEY,
    staff_id VARCHAR(50) NOT NULL,
    date DATE NOT NULL,
    check_in DATETIME,
    check_out DATETIME,
    breaks JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
    UNIQUE KEY unique_staff_date (staff_id, date),
    INDEX idx_staff_date (staff_id, date),
    INDEX idx_check_in (check_in)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`);

console.log('✓ Tables created successfully');

const [adminRows] = await db.execute('SELECT id FROM staff WHERE username = ?', ['admin']);
if (adminRows.length === 0) {
  const hash = await bcrypt.hash('admin123', 10);
  await db.execute(
    'INSERT INTO staff (id, name, username, password, role, department, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['ADMIN001', 'Administrator', 'admin', hash, 'admin', 'Management', 'System Administrator']
  );
  console.log('✓ Default admin created (username: admin, password: admin123)');
} else {
  console.log('✓ Admin account exists');
}

const [staffCount] = await db.execute('SELECT COUNT(*) as count FROM staff');
const [attendanceCount] = await db.execute('SELECT COUNT(*) as count FROM attendance');

console.log(`✓ Staff records: ${staffCount[0].count}`);
console.log(`✓ Attendance records: ${attendanceCount[0].count}`);
console.log('✓ Database ready');

await closeDB();