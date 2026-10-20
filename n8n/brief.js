// ============================================================
// Узел Code "Build Brief" (n8n). Режим: Run Once for All Items.
//
// Собирает HTML-бриф из ответов пользователя и готовит данные заявки.
// На выходе: json для записи в Leads + binary (HTML-файл) для Send Document.
//
// Требуются узлы: Engine, Get Settings, Get Screens, Get Options.
// ============================================================

const engine = $('Engine').first().json;
const lead = engine.lead || {};
const answers = JSON.parse(engine.state.answers_json || '{}');

const settings = {};
for (const item of $('Get Settings').all()) {
  const row = item.json || {};
  if (row.key) settings[String(row.key).trim()] = row.value;
}

const screensById = {};
for (const item of $('Get Screens').all()) {
  const row = item.json || {};
  if (row.screen_id) screensById[String(row.screen_id).trim()] = row;
}

const optionsByScreen = {};
const seenOptions = {};
for (const item of $('Get Options').all()) {
  const row = item.json || {};
  if (!row.screen_id || !row.option_id) continue;
  const key = String(row.screen_id).trim();
  const dedupKey = key + '/' + String(row.option_id).trim();
  if (seenOptions[dedupKey]) continue;
  seenOptions[dedupKey] = true;
  if (!optionsByScreen[key]) optionsByScreen[key] = [];
  optionsByScreen[key].push(row);
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function optLabel(screenId, optionId) {
  const options = optionsByScreen[screenId] || [];
  const opt = options.find(o => String(o.option_id) === String(optionId));
  return opt ? String(opt.label || optionId) : String(optionId);
}

function renderAnswer(screenId, value) {
  const screen = screensById[screenId] || { type: 'text' };
  if (Array.isArray(value)) return value.map(v => optLabel(screenId, v)).join('; ');
  if (screen.type === 'single' || screen.type === 'multi') return optLabel(screenId, value);
  if (screen.type === 'document') return 'Файл получен (id: ' + String(value) + ')';
  return String(value);
}

function questionOf(screenId) {
  const screen = screensById[screenId] || {};
  return String(screen.text || screenId).replace(/\s+/g, ' ').trim();
}

// Контактные поля показываем отдельным блоком — из списка ответов исключаем.
const CONTACT_KEYS = ['final_name', 'final_phone', 'final_messenger', 'final_time'];

const rows = [];
for (const key of Object.keys(answers)) {
  if (key.indexOf('__') === 0) continue;
  if (CONTACT_KEYS.indexOf(key) >= 0) continue;
  const value = answers[key];
  if (value === null || value === undefined || value === '') continue;
  if (Array.isArray(value) && value.length === 0) continue;
  rows.push('<tr><td class="q">' + esc(questionOf(key)) + '</td><td class="a">' + esc(renderAnswer(key, value)) + '</td></tr>');
}

const now = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
const briefFile = 'brief_' + String(lead.telegram_id || 'na') + '_' + stamp + '.html';
const leadId = 'L-' + stamp + '-' + String(lead.telegram_id || 'na') + '-' + Math.random().toString(36).slice(2, 6);

const messenger = lead.messenger ? esc(lead.messenger) : '—';
const title = settings.brief_title || 'Бриф на сайт';

const html = '<!DOCTYPE html>\n' +
'<html lang="ru"><head><meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>' + esc(title) + '</title>\n' +
'<style>\n' +
'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;padding:24px;background:#f5f6f8;color:#1f2329;line-height:1.5}\n' +
'.wrap{max-width:720px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px;box-shadow:0 1px 4px rgba(0,0,0,.08)}\n' +
'h1{font-size:20px;margin:0 0 4px}\n' +
'.sub{color:#7a8290;font-size:13px;margin-bottom:20px}\n' +
'.contacts{background:#f0f4ff;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:14px}\n' +
'.contacts div{margin:3px 0}\n' +
'table{width:100%;border-collapse:collapse;font-size:14px}\n' +
'td{padding:9px 10px;border-bottom:1px solid #eceef1;vertical-align:top}\n' +
'td.q{width:46%;color:#5a6270}\n' +
'td.a{font-weight:600}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
'<h1>' + esc(title) + '</h1>\n' +
'<div class="sub">' + esc(now.toLocaleString('ru-RU')) + '</div>\n' +
'<div class="contacts">' +
'<div><b>Имя:</b> ' + esc(lead.name || '—') + '</div>' +
'<div><b>Телефон:</b> ' + esc(lead.phone || '—') + '</div>' +
'<div><b>Мессенджер:</b> ' + messenger + '</div>' +
'<div><b>Удобное время:</b> ' + esc(lead.contact_time || '—') + '</div>' +
'</div>\n' +
'<table>' + rows.join('') + '</table>\n' +
'</div></body></html>';

const managerText = 'Новая заявка с квиза\n' +
  'Имя: ' + (lead.name || '—') + '\n' +
  'Телефон: ' + (lead.phone || '—') + '\n' +
  'Мессенджер: ' + (lead.messenger || '—') + '\n' +
  'Удобное время: ' + (lead.contact_time || '—');

const buffer = Buffer.from(html, 'utf-8');
const binary = await this.helpers.prepareBinaryData(buffer, briefFile, 'text/html');

// Куда отправлять бриф: менеджеру, если id задан в Settings; иначе — тестировщику (демо).
const managerChatId = String(settings.manager_chat_id || '').trim();
const briefChatId = managerChatId || String(lead.telegram_id || '');

return [{
  json: {
    lead_id: leadId,
    created_at: now.toISOString(),
    telegram_id: String(lead.telegram_id || ''),
    name: String(lead.name || ''),
    phone: String(lead.phone || ''),
    messenger: String(lead.messenger || ''),
    contact_time: String(lead.contact_time || ''),
    answers_json: String((engine.lead && engine.lead.answers_json) || engine.state.answers_json || '{}'),
    brief_file: briefFile,
    manager_chat_id: managerChatId,
    brief_chat_id: briefChatId,
    manager_text: managerText
  },
  binary: { data: binary }
}];
