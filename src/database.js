const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('whatsapp.db');

function initDb() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Crear tabla de conversaciones
      db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone_number TEXT,
          incoming_message TEXT,
          response_message TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) reject(err);
      });

      // Crear tabla de estado del bot
      db.run(`
        CREATE TABLE IF NOT EXISTS bot_status (
          phone_number TEXT PRIMARY KEY,
          is_active BOOLEAN DEFAULT 1
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function saveConversation(phoneNumber, incomingMessage, responseMessage) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO conversations (phone_number, incoming_message, response_message) VALUES (?, ?, ?)',
      [phoneNumber, incomingMessage, responseMessage],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function getConversationsByPhone(phoneNumber) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM conversations WHERE phone_number = ? ORDER BY timestamp DESC',
      [phoneNumber],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

function getBotStatus(phoneNumber) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT is_active FROM bot_status WHERE phone_number = ?',
      [phoneNumber],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.is_active : true);
      }
    );
  });
}

module.exports = {
  db,
  initDb,
  saveConversation,
  getConversationsByPhone,
  getBotStatus
}; 