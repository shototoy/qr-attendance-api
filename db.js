import mysql from 'mysql2/promise';

let pool;

export async function initDB() {
  if (pool) return pool;

  const config = {
    host: process.env.MYSQL_HOST || 'localhost',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'qr_attendance',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };

  pool = mysql.createPool(config);
  
  try {
    const connection = await pool.getConnection();
    console.log('✓ MySQL connected');
    connection.release();
  } catch (error) {
    console.error('✗ MySQL connection failed:', error.message);
    throw error;
  }

  return pool;
}

export function getDB() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
}

export async function closeDB() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('✓ MySQL connection closed');
  }
}