import os
from dotenv import load_dotenv
from flask import Flask, request, render_template, jsonify
import requests
import json
import re
import datetime
import pytz 
from database import init_db, save_conversation, get_conversations_by_phone, get_bot_status
from flask_socketio import SocketIO
from routes import api

load_dotenv()  # Carga las variables de entorno desde .env

# Inicializar la base de datos
init_db()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'secret_key_default')
socketio = SocketIO(app, cors_allowed_origins="*")  # Permitir conexiones desde cualquier origen

# Registrar el blueprint
app.register_blueprint(api)

# Diccionario para almacenar el historial de conversaciones y datos de reserva
conversation_history = {}

# Ruta principal
@app.route('/')
def index():
    return 'WebSocket server is running'

# Ruta del dashboard
@app.route('/dashboard')
def dashboard():
    print("Accediendo al dashboard")  # Debug
    try:
        return render_template('dashboard.html')
    except Exception as e:
        print(f"Error al renderizar dashboard: {e}")  # Debug
        return str(e), 500

# Ruta del webhook para recibir mensajes de WhatsApp
@app.route('/webhook', methods=['GET', 'POST'])
def webhook():
    if request.method == 'GET':
        # Manejo de la verificación del webhook
        mode = request.args.get('hub.mode')
        token = request.args.get('hub.verify_token')
        challenge = request.args.get('hub.challenge')

        if mode and token:
            if mode == 'subscribe' and token == os.getenv('VERIFY_TOKEN'):
                return challenge, 200
            else:
                return 'Forbidden', 403
    
    elif request.method == 'POST':
        data = request.get_json()

        try:
            # Obtener el mensaje y número de teléfono
            message = data['entry'][0]['changes'][0]['value']['messages'][0]['text']['body']
            phone_number = data['entry'][0]['changes'][0]['value']['messages'][0]['from']
           
        except KeyError:
            return 'OK', 200

        # Emitir inmediatamente el mensaje recibido
        socketio.emit('new_message', {
            'phone_number': phone_number,
            'incoming_message': message,
            'response_message': "",
            'timestamp': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
        
        # Obtener el contexto y procesar la respuesta en segundo plano
        def process_response():
            try:
                # Verificar si el bot está activo
                if not get_bot_status(phone_number):
                    print(f"Bot desactivado para {phone_number}")
                    return
                    
                # Obtener el contexto de Google Sheets
                context = get_context_from_sheets()
                
                # Obtener el historial de la conversación
                history = conversation_history.get(phone_number, {"history": []})
                history["history"].append({"role": "user", "content": message})
                
                # Obtener la respuesta de ChatGPT
                gpt_response = send_to_chatgpt(history["history"], context)
                print("Respuesta de GPT:", gpt_response)

                # Enviar gpt_response al script y obtener la respuesta
                #script_response = send_to_script(gpt_response, phone_number)
                #print("Respuesta del script:", script_response)

                # Usar la respuesta del script si está disponible
                #response_to_user = script_response["result"]
                
                response_to_user = gpt_response
                

                # Guardar la conversación completa en la base de datos
                save_conversation(phone_number, message, response_to_user)
                
                # Emitir el evento con la respuesta
                socketio.emit('new_message', {
                    'phone_number': phone_number,
                    'incoming_message': "",
                    'response_message': response_to_user,
                    'timestamp': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                })

                # Actualizar el historial
                history["history"].append({"role": "assistant", "content": response_to_user})
                conversation_history[phone_number] = history

                # Enviar la respuesta al usuario de WhatsApp
                send_to_whatsapp(phone_number, response_to_user)
                
            except Exception as e:
                print(f"Error procesando respuesta: {e}")
        
        # Iniciar el procesamiento en segundo plano
        import threading
        thread = threading.Thread(target=process_response)
        thread.start()

        return 'OK', 200

def get_context_from_sheets():
    sheets_url = os.getenv('GOOGLE_SHEETS_URL')
    response = requests.get(f"{sheets_url}?action=getContext")
    
       
    # Intentar decodificar la respuesta JSON
    try:
        return response.json().get('context', '')
    except json.JSONDecodeError:
        print("Error al decodificar JSON. Respuesta no válida:", response.text)
        return ''

def send_to_chatgpt(history, context):
    api_key = os.getenv('OPENAI_API_KEY')
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    
    # Obtener la fecha y hora actual en Santiago de Chile
    santiago_tz = pytz.timezone('America/Santiago')
    fecha_hora_actual = datetime.datetime.now(santiago_tz)
    
    # Formatear la fecha y hora actual
    fecha_actual = fecha_hora_actual.strftime("%d-%m-%y")
    hora_actual = fecha_hora_actual.strftime("%H:%M")
    dia_semana = fecha_hora_actual.strftime("%A")
    # Traducir el día de la semana al español
    dias_semana = {
        'Monday': 'Lunes',
        'Tuesday': 'Martes',
        'Wednesday': 'Miércoles',
        'Thursday': 'Jueves',
        'Friday': 'Viernes',
        'Saturday': 'Sábado',
        'Sunday': 'Domingo'
    }
    dia_semana_es = dias_semana[dia_semana]
    
    
    # Añadir la fecha, hora y día de la semana actual al contexto
    context_with_datetime = f"{context}\nHoy es {dia_semana_es}. La fecha actual es: {fecha_actual}. La hora actual en Santiago de Chile es: {hora_actual}."

    # Crear la lista de mensajes con los roles correctos
    messages = [{"role": "system", "content": context_with_datetime}]
    for message in history:
        messages.append({"role": message["role"], "content": message["content"]})
    
    data = {
        "model": "gpt-3.5-turbo",
        "messages": messages,
        "temperature": 0.3
    }
    
    response = requests.post('https://api.openai.com/v1/chat/completions', headers=headers, json=data)
    response_json = response.json()

    return response_json['choices'][0]['message']['content']

def send_to_script(gpt_response, phone_number):
    script_url = os.getenv('GOOGLE_SHEETS_URL')
    data = {
        'response': gpt_response,
        'phoneNumber': phone_number
    }
    try:
        response = requests.post(script_url, json=data)
        response.raise_for_status()
        
        # Imprimir el contenido de la respuesta
        print("Contenido de la respuesta del script:", response.text)
        
        # Intentar decodificar la respuesta JSON
        try:
            script_response = response.json()
            
            # Verificar si la respuesta contiene un resultado
            if 'result' in script_response and script_response['result']:
                print("Respuesta recibida del script con éxito")
                return script_response
            else:
                print("El script no devolvió un resultado válido")
                return {"result": gpt_response}
        
        except json.JSONDecodeError:
            print(f"Error al decodificar la respuesta JSON. Contenido de la respuesta: {response.text}")
            return {"result": gpt_response}
    
    except requests.exceptions.RequestException as e:
        print(f"Error al enviar la respuesta al script: {e}")
        return {"result": gpt_response}



def send_to_whatsapp(phone_number, gpt_response):
    whatsapp_api_url = os.getenv('WHATSAPP_API_URL')
    
    headers = {
        'Authorization': f'Bearer {os.getenv("META_ACCESS_TOKEN")}',
        'Content-Type': 'application/json',
    }
    
    data = {
        "messaging_product": "whatsapp",
        "to": phone_number,
        "text": {"body": gpt_response}
    }
    
    requests.post(whatsapp_api_url, headers=headers, json=data)

@app.route('/api/send-message', methods=['POST'])
def send_dashboard_message():
    try:
        data = request.json
        phone_number = data.get('phone_number')
        message = data.get('message')
        
        if not phone_number or not message:
            return jsonify({'error': 'Falta número de teléfono o mensaje'}), 400
        
        # Enviar mensaje a WhatsApp
        send_to_whatsapp(phone_number, message)
        
        # Guardar en la base de datos como mensaje enviado
        save_conversation(phone_number, "", message)
        
        # Emitir evento de nuevo mensaje
        socketio.emit('new_message', {
            'phone_number': phone_number,
            'incoming_message': "",
            'response_message': message,
            'timestamp': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
        
        return jsonify({'success': True}), 200
    except Exception as e:
        print(f"Error al enviar mensaje: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    # Asegurarse de que Flask sepa que está detrás de un proxy
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
    
    # Ejecutar la aplicación
    port = int(os.getenv('PORT', 5000))
    socketio.run(app, 
                host='0.0.0.0',  # Importante para acceder desde fuera
                port=port,
                debug=True,
                allow_unsafe_werkzeug=True)  # Solo para desarrollo
