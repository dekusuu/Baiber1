const mysql = require('mysql2/promise');

module.exports = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '09365164324',
  database: process.env.DB_NAME || 'bai_ber',
  charset: 'utf8mb4',
  dateStrings: true,
  connectionLimit: 10
});
