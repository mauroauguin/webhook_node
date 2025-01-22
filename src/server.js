require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const moment = require('moment-timezone');
const { OpenAI } = require('openai');
const axios = require('axios');
const routes = require('./routes');
const { initDb, saveConversation, getConversationsByPhone, getBotStatus, db } = require('./database');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuración de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', routes);

// Almacenamiento en memoria del historial de conversaciones
const conversationHistory = {};

// Ruta principal
app.get('/', (req, res) => {
  res.send('WebSocket server is running');
});

// Ruta del dashboard
app.get('/dashboard', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
  } catch (error) {
    console.error('Error al renderizar dashboard:', error);
    res.status(500).send(error.toString());
  }
});

// Función para obtener contexto de Google Sheets
async function getContextFromSheets() {
  try {
    const response = await axios.get(`${process.env.GOOGLE_SHEETS_URL}?action=getContext`);
    return response.data.context || '';
  } catch (error) {
    console.error('Error al obtener contexto:', error);
    return '';
  }
}

// Función para enviar mensaje a ChatGPT
async function sendToChatGPT(history, context) {
  try {
    // Obtener fecha y hora actual en Santiago
    const santiagoTime = moment().tz('America/Santiago');
    const fechaActual = santiagoTime.format('DD-MM-YY');
    const horaActual = santiagoTime.format('HH:mm');
    const diaSemana = santiagoTime.format('dddd');
    
    // Traducir día de la semana
    const diasSemana = {
      'Monday': 'Lunes',
      'Tuesday': 'Martes',
      'Wednesday': 'Miércoles',
      'Thursday': 'Jueves',
      'Friday': 'Viernes',
      'Saturday': 'Sábado',
      'Sunday': 'Domingo'
    };
    
    const contextWithDateTime = `${context}\nHoy es ${diasSemana[diaSemana]}. La fecha actual es: ${fechaActual}. La hora actual en Santiago de Chile es: ${horaActual}.`;

    const messages = [
      { role: "system", content: contextWithDateTime },
      ...history
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      temperature: 0.3
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error en ChatGPT:', error);
    return 'Lo siento, hubo un error al procesar tu mensaje.';
  }
}

// Función para enviar mensaje a WhatsApp
async function sendToWhatsApp(phoneNumber, message) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v12.0/298133750047072/messages`,
      {
        messaging_product: "whatsapp",
        to: phoneNumber,
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error al enviar mensaje WhatsApp:', error);
    throw error;
  }
}

// Webhook para WhatsApp
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const { body } = req;
    
    if (body.object) {
      if (
        body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value.messages &&
        body.entry[0].changes[0].value.messages[0]
      ) {
        const phoneNumber = body.entry[0].changes[0].value.messages[0].from;
        const message = body.entry[0].changes[0].value.messages[0].text.body;

        // Emitir mensaje recibido
        io.emit('new_message', {
          phone_number: phoneNumber,
          incoming_message: message,
          response_message: "",
          timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
        });

        // Procesar respuesta en segundo plano
        processResponse(phoneNumber, message);

        res.status(200).send('OK');
      }
    }
  } catch (error) {
    console.error('Error en webhook:', error);
    res.sendStatus(500);
  }
});

async function processResponse(phoneNumber, message) {
  try {
    // Verificar estado del bot
    const botActive = await getBotStatus(phoneNumber);
    if (!botActive) {
      console.log(`Bot desactivado para ${phoneNumber}`);
      return;
    }

    // Obtener contexto
    const context = await getContextFromSheets();
    
    // Obtener historial
    if (!conversationHistory[phoneNumber]) {
      conversationHistory[phoneNumber] = { history: [] };
    }
    
    conversationHistory[phoneNumber].history.push({
      role: "user",
      content: message
    });

    // Obtener respuesta de ChatGPT
    const gptResponse = await sendToChatGPT(
      conversationHistory[phoneNumber].history,
      context
    );

    // Guardar conversación
    await saveConversation(phoneNumber, message, gptResponse);

    // Emitir respuesta
    io.emit('new_message', {
      phone_number: phoneNumber,
      incoming_message: "",
      response_message: gptResponse,
      timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
    });

    // Actualizar historial
    conversationHistory[phoneNumber].history.push({
      role: "assistant",
      content: gptResponse
    });

    // Enviar respuesta a WhatsApp
    await sendToWhatsApp(phoneNumber, gptResponse);

  } catch (error) {
    console.error('Error procesando respuesta:', error);
  }
}

// Compartir la función sendToWhatsApp y el objeto io con la aplicación
app.set('sendToWhatsApp', sendToWhatsApp);
app.set('io', io);

// Agregar después de la inicialización de la base de datos
app.set('db', db);

// Iniciar servidor
const PORT = process.env.PORT || 5000;

// Inicializar la base de datos antes de iniciar el servidor
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Servidor corriendo en puerto ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Error inicializando la base de datos:', err);
    process.exit(1);
  });