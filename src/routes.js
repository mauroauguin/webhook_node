const express = require('express');
const router = express.Router();
const { saveConversation } = require('./database');

router.post('/send-message', async (req, res) => {
  try {
    const { phone_number, message } = req.body;

    if (!phone_number || !message) {
      return res.status(400).json({ error: 'Falta número de teléfono o mensaje' });
    }

    // Obtener la función sendToWhatsApp del objeto app
    const sendToWhatsApp = req.app.get('sendToWhatsApp');
    
    // Enviar mensaje a WhatsApp
    await sendToWhatsApp(phone_number, message);

    // Guardar en la base de datos
    await saveConversation(phone_number, "", message);

    // Emitir evento
    const io = req.app.get('io');
    io.emit('new_message', {
      phone_number: phone_number,
      incoming_message: "",
      response_message: message,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error al enviar mensaje:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener todos los contactos
router.get('/contacts', async (req, res) => {
  try {
    const db = req.app.get('db');
    const contacts = await new Promise((resolve, reject) => {
      db.all(`
        SELECT DISTINCT phone_number, 
               MAX(timestamp) as last_message 
        FROM conversations 
        GROUP BY phone_number 
        ORDER BY last_message DESC
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    res.json(contacts);
  } catch (error) {
    console.error('Error obteniendo contactos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener mensajes de un contacto específico
router.get('/messages/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const db = req.app.get('db');
    const messages = await new Promise((resolve, reject) => {
      db.all(`
        SELECT * 
        FROM conversations 
        WHERE phone_number = ? 
        ORDER BY timestamp ASC
      `, [phone], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    res.json(messages);
  } catch (error) {
    console.error('Error obteniendo mensajes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener estado del bot
router.get('/bot-status/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const db = req.app.get('db');
    const status = await new Promise((resolve, reject) => {
      db.get(
        'SELECT is_active FROM bot_status WHERE phone_number = ?',
        [phone],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row.is_active : true);
        }
      );
    });
    res.json({ is_active: status });
  } catch (error) {
    console.error('Error obteniendo estado del bot:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cambiar estado del bot
router.post('/toggle-bot', async (req, res) => {
  try {
    const { phone_number, is_active } = req.body;
    const db = req.app.get('db');
    
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO bot_status (phone_number, is_active) 
         VALUES (?, ?)
         ON CONFLICT(phone_number) 
         DO UPDATE SET is_active = ?`,
        [phone_number, is_active, is_active],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error cambiando estado del bot:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router; 