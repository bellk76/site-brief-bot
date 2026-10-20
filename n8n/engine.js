// ============================================================
// Узел Code "Engine" (n8n). Режим: Run Once for All Items.
//
// Читает контент и состояние из Google Sheets через upstream-узлы
// и возвращает: метод Telegram, текст, клавиатуру, новое состояние,
// признак сохранения заявки.
//
// Требуются узлы с ИМЕННО такими именами:
//   Normalize, Get Settings, Get State, Get Screens, Get Options
//
// Поля Sheets:
//   Screens: screen_id, type, text, parse_mode, next_screen_id,
//            min_select, max_select, confirm_label, required,
//            validation, is_active, sort_order, back_screen_id,
//            condition, skip_to
//   Options: screen_id, option_id, label, action, value, exclusive,
//            next_screen_id, sort_order, is_active
//   Settings: key, value
// ============================================================

// ---------- утилиты ----------
function toBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === null || value === undefined) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === 'да' || s === '1' || s === 'yes';
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return '';
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

// ---------- чтение входных данных ----------
const update = $('Normalize').first().json;

// Служебные/неизвестные апдейты (edited_message, chat_member и т.п.) — пропускаем.
if (!update.telegram_id) {
  return [{
    json: {
      method: 'noop',
      skip: true,
      is_callback: false,
      chat_id: '',
      message_id: null,
      callback_query_id: '',
      save_lead: false,
      lead: null,
      state: null
    }
  }];
}

const settings = {};
for (const item of $('Get Settings').all()) {
  const row = item.json || {};
  const key = row.key;
  if (key !== undefined && key !== null && String(key).trim() !== '') {
    settings[String(key).trim()] = row.value;
  }
}

const screens = {};
const seenScreens = {};
for (const item of $('Get Screens').all()) {
  const row = item.json || {};
  if (!row.screen_id) continue;
  if (!toBool(firstDefined(row.is_active, true))) continue;
  const id = String(row.screen_id).trim();
  if (seenScreens[id]) continue;
  seenScreens[id] = true;
  screens[id] = row;
}

const optionsByScreen = {};
const seenOptions = {};
for (const item of $('Get Options').all()) {
  const row = item.json || {};
  if (!row.screen_id || !row.option_id) continue;
  if (!toBool(firstDefined(row.is_active, true))) continue;
  const key = String(row.screen_id).trim();
  const dedupKey = key + '/' + String(row.option_id).trim();
  if (seenOptions[dedupKey]) continue;
  seenOptions[dedupKey] = true;
  if (!optionsByScreen[key]) optionsByScreen[key] = [];
  optionsByScreen[key].push(row);
}
for (const key of Object.keys(optionsByScreen)) {
  optionsByScreen[key].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
}

// ---------- состояние пользователя ----------
const startScreen = String(settings.start_screen_id || 'privacy');

let foundState = null;
for (const item of $('Get State').all()) {
  const row = item.json || {};
  if (row.telegram_id === undefined || row.telegram_id === null) continue;
  if (String(row.telegram_id).trim() === String(update.telegram_id)) {
    foundState = row;
    break;
  }
}

const state = {
  screen_id: foundState ? String(foundState.screen_id || startScreen) : startScreen,
  answers: foundState ? parseJson(foundState.answers_json, {}) : {},
  back_stack: foundState ? parseJson(foundState.back_stack_json, []) : [],
  lead_saved: foundState ? toBool(foundState.lead_saved) : false
};
if (!Array.isArray(state.back_stack)) state.back_stack = [];
if (typeof state.answers !== 'object' || state.answers === null) state.answers = {};

// ---------- доступ к экранам и опциям ----------
function getScreen(id) {
  return screens[id] || null;
}

function getOptions(id) {
  return optionsByScreen[id] || [];
}

function resolveUrl(value) {
  if (!value) return '';
  const m = String(value).match(/^\{(.+)\}$/);
  if (m) return String(settings[m[1]] || '');
  return String(value);
}

// Переход вперёд: текущий экран кладём в историю.
function goForward(target) {
  if (!target) return;
  if (target === '{back}') {
    state.screen_id = state.back_stack.pop() || startScreen;
  } else if (state.screen_id !== target) {
    state.back_stack.push(state.screen_id);
    state.screen_id = target;
  }
}

// Проверка условия вида: promo_current in [paid, seo], active == yes, x != no.
function evalCondition(cond) {
  if (!cond) return true;
  const text = String(cond).trim();

  let m = text.match(/^([A-Za-z0-9_]+)\s+in\s+\[(.*)\]$/);
  if (m) {
    const list = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const value = state.answers[m[1]];
    if (Array.isArray(value)) return value.some(v => list.includes(String(v)));
    return list.includes(String(value));
  }

  m = text.match(/^([A-Za-z0-9_]+)\s*!=\s*(.+)$/);
  if (m) return String(state.answers[m[1]]) !== m[2].trim().replace(/^['"]|['"]$/g, '');

  m = text.match(/^([A-Za-z0-9_]+)\s*==\s*(.+)$/);
  if (m) return String(state.answers[m[1]]) === m[2].trim().replace(/^['"]|['"]$/g, '');

  return true;
}

// Пропускаем условные экраны: пока условие ложно — идём по skip_to.
function resolveScreen(id) {
  let current = id;
  let guard = 0;
  while (current && screens[current] && guard < 200) {
    guard++;
    const screen = screens[current];
    if (screen.condition && !evalCondition(screen.condition)) {
      const skip = firstDefined(screen.skip_to, screen.next_screen_id);
      if (!skip || skip === current) break;
      current = skip;
      continue;
    }
    break;
  }
  return current || startScreen;
}

function isValidPhone(text) {
  const digits = String(text).replace(/[^0-9]/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function ruleOf(screen) {
  const v = String(screen.validation || '').trim().toLowerCase();
  if (v && v !== 'none') return v;
  if (screen.type === 'phone') return 'phone';
  return 'none';
}

function inputError(screen, text) {
  if (toBool(screen.required) && !text) {
    return 'Это обязательный вопрос, напишите, пожалуйста, ответ.';
  }
  const rule = ruleOf(screen);
  if (rule === 'phone' && !isValidPhone(text)) {
    return 'Похоже, номер введён некорректно. Пришлите телефон в формате +7 999 123-45-67.';
  }
  if (rule === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return 'Укажите корректный email.';
  }
  if (rule === 'number' && !/^[0-9]+$/.test(text)) {
    return 'Введите корректное число.';
  }
  return null;
}

// ---------- обработка апдейта ----------
const isCallback = !!update.is_callback;
const cbData = String(update.callback_data || '');
const userText = String(update.text || '').trim();

let handled = false;

if (!isCallback && /^\/start(\s|$)/i.test(userText)) {
  state.screen_id = startScreen;
  state.answers = {};
  state.back_stack = [];
  handled = true;
} else if (!isCallback && /^\/(menu|help)(\s|$)/i.test(userText)) {
  state.screen_id = 'main_menu';
  handled = true;
} else if (isCallback) {
  const parts = cbData.split(':');

  if (cbData === 'b') {
    // Назад: берём экран из истории.
    state.screen_id = state.back_stack.pop() || startScreen;
    handled = true;
  } else if (parts[0] === 'o' && parts[1] && parts[1] !== state.screen_id) {
    // Устаревшая кнопка — просто перерисуем текущий экран.
    handled = true;
  } else if (parts[0] === 'd' && parts[1] && parts[1] === state.screen_id) {
    // Подтверждение мультивыбора.
    const screen = getScreen(parts[1]);
    if (screen) {
      const selected = Array.isArray(state.answers[parts[1]]) ? state.answers[parts[1]] : [];
      const minSelect = Number(screen.min_select || 0);
      if (minSelect > 0 && selected.length < minSelect) {
        state.error = 'Выберите минимум ' + minSelect + '.';
      } else {
        goForward(screen.next_screen_id);
      }
    }
    handled = true;
  } else if (parts[0] === 'o' && parts[1] && parts[2]) {
    const screenId = parts[1];
    const optionId = parts[2];
    const screen = getScreen(screenId);
    const option = getOptions(screenId).find(o => String(o.option_id) === optionId);

    if (screen && option) {
      const action = String(option.action || 'goto');

      if (action === 'toggle') {
        let selected = Array.isArray(state.answers[screenId]) ? state.answers[screenId].slice() : [];
        const exclusiveIds = getOptions(screenId).filter(o => toBool(o.exclusive)).map(o => String(o.option_id));
        const isExclusive = toBool(option.exclusive);
        const idx = selected.findIndex(v => String(v) === optionId);

        if (idx >= 0) {
          selected.splice(idx, 1);
          delete state.error;
        } else if (isExclusive) {
          selected = [optionId];
          delete state.error;
        } else {
          selected = selected.filter(v => !exclusiveIds.includes(String(v)));
          const maxSelect = Number(screen.max_select || 0);
          if (maxSelect > 0 && selected.length >= maxSelect) {
            state.error = 'Можно выбрать не более ' + maxSelect + '.';
          } else {
            selected.push(optionId);
          }
        }
        state.answers[screenId] = selected;
      } else if (action === 'input') {
        state.answers[screenId] = optionId;
        goForward(option.next_screen_id);
      } else if (action === 'goto' || action === 'submit') {
        if (screen.type === 'single') state.answers[screenId] = optionId;
        goForward(option.next_screen_id);
      }
      handled = true;
    }
  }
}

if (!handled && !isCallback) {
  const screen = getScreen(state.screen_id);

  if (screen && (screen.type === 'text' || screen.type === 'phone')) {
    const err = inputError(screen, userText);
    if (err) {
      state.error = err;
    } else {
      state.answers[state.screen_id] = userText;
      delete state.error;
      goForward(screen.next_screen_id);
    }
  } else if (screen && screen.type === 'document') {
    if (update.file_id) {
      state.answers[state.screen_id] = update.file_id;
      delete state.error;
      goForward(screen.next_screen_id);
    } else {
      state.error = 'Пришлите, пожалуйста, файл.';
    }
  } else {
    // Ждали нажатие кнопки — просто перерисуем экран.
    delete state.error;
  }
}

// ---------- разрешаем условные экраны ----------
state.screen_id = resolveScreen(state.screen_id);
const current = getScreen(state.screen_id) || getScreen(startScreen) || { screen_id: startScreen, type: 'message', text: 'Экран не найден: ' + state.screen_id };

// ---------- рендер ----------
function escHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function subst(text) {
  let out = String(text || '');
  return out
    .replace(/\{name\}/g, escHtml(state.answers.final_name || update.first_name || 'друг'))
    .replace(/\{first_name\}/g, escHtml(update.first_name || 'друг'));
}

function renderText(screen) {
  let text = subst(screen.text);
  if (state.error) text += '\n\n⚠️ ' + state.error;
  return text;
}

function buildKeyboard(screen) {
  const rows = [];
  const opts = getOptions(screen.screen_id);

  for (const opt of opts) {
    const action = String(opt.action || 'goto');

    if (action === 'url') {
      const url = resolveUrl(opt.value);
      if (!url || url.startsWith('[')) continue;
      rows.push([{ text: String(opt.label || ''), url }]);
      continue;
    }

    let label = String(opt.label || '');
    if (screen.type === 'multi' && action === 'toggle') {
      const selected = Array.isArray(state.answers[screen.screen_id]) ? state.answers[screen.screen_id] : [];
      const isOn = selected.some(v => String(v) === String(opt.option_id));
      label = (isOn ? '✅ ' : '⬜ ') + label;
    }
    rows.push([{ text: label, callback_data: 'o:' + screen.screen_id + ':' + opt.option_id }]);
  }

  if (screen.type === 'multi') {
    const confirm = firstDefined(screen.confirm_label, settings.default_confirm_label, 'Готово');
    rows.push([{ text: String(confirm), callback_data: 'd:' + screen.screen_id }]);
  }

  if (screen.back_screen_id) {
    rows.push([{ text: String(settings.back_label || 'Назад'), callback_data: 'b' }]);
  }

  return rows;
}

// ---------- заявка ----------
const isFinal = current.screen_id === 'final_success';
let saveLead = false;
if (isFinal && !state.lead_saved) {
  saveLead = true;
  state.lead_saved = true;
}

function answerLabel(screenId, value) {
  const opt = getOptions(screenId).find(o => String(o.option_id) === String(value));
  return opt ? String(opt.label || value) : String(value);
}

const leadAnswers = {};
for (const k of Object.keys(state.answers)) {
  if (k.indexOf('__') !== 0) leadAnswers[k] = state.answers[k];
}

const lead = saveLead
  ? {
      telegram_id: update.telegram_id,
      name: String(state.answers.final_name || ''),
      phone: String(state.answers.final_phone || ''),
      messenger: Array.isArray(state.answers.final_messenger)
        ? state.answers.final_messenger.map(v => answerLabel('final_messenger', v)).join(', ')
        : '',
      contact_time: state.answers.final_time ? answerLabel('final_time', state.answers.final_time) : '',
      answers_json: JSON.stringify(leadAnswers)
    }
  : null;

// ---------- результат ----------
const keyboard = buildKeyboard(current);

return [{
  json: {
    method: isCallback ? 'editMessageText' : 'sendMessage',
    is_callback: isCallback,
    chat_id: update.chat_id,
    message_id: update.message_id,
    callback_query_id: update.callback_query_id,
    parse_mode: current.parse_mode || '',
    text: renderText(current),
    reply_markup: JSON.stringify({ inline_keyboard: keyboard }),
    save_lead: saveLead,
    lead: lead,
    state: {
      telegram_id: update.telegram_id,
      screen_id: state.screen_id,
      answers_json: JSON.stringify(state.answers),
      back_stack_json: JSON.stringify(state.back_stack),
      lead_saved: state.lead_saved,
      updated_at: new Date().toISOString()
    }
  }
}];
