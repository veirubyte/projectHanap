const mysql = require('mysql2');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const requiredConfig = ['DB_HOST', 'DB_USER', 'DB_NAME', 'DB_PASSWORD'];
const missingConfig = requiredConfig.filter((name) => {
    return process.env[name] === undefined ||
        (name !== 'DB_PASSWORD' && process.env[name].trim() === '');
});

if (missingConfig.length > 0) {
    throw new Error(`Missing required database configuration: ${missingConfig.join(', ')}.`);
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool.promise();