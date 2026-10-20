// ============================================================
// Узел Code "Normalize" (n8n). Режим: Run Once for All Items.
// Приводит апдейт Telegram (message / callback_query) к единому виду.
// Дальше все узлы используют только эти поля.
// ============================================================

const data = $input.first().json || {};

const msg = data.message || {};
const cq = data.callback_query || {};
const from = msg.from || cq.from || {};
const chat = msg.chat || (cq.message && cq.message.chat) || {};
const document = msg.document || {};

const isCallback = !!cq.id;

return [{
  json: {
    is_callback: isCallback,
    telegram_id: from.id !== undefined ? String(from.id) : '',
    chat_id: chat.id !== undefined ? String(chat.id) : '',
    message_id: cq.message ? cq.message.message_id : (msg.message_id !== undefined ? msg.message_id : null),
    callback_query_id: cq.id || '',
    callback_data: cq.data || '',
    text: msg.text !== undefined ? msg.text : (cq.data || ''),
    first_name: from.first_name || '',
    last_name: from.last_name || '',
    username: from.username || '',
    file_id: document.file_id || '',
    update_id: data.update_id !== undefined ? data.update_id : null,
    ts: new Date().toISOString()
  }
}];
