import { getSetting } from '../services/settings';

// Widget de atendimento para sites externos: um script de carregamento (widget.js) que abre
// um iframe com esta página. Tudo em JavaScript puro, sem dependências, e sem innerHTML com dados do usuário.

export function widgetLoaderJs() {
  return `(function () {
  if (window.WesccLivechat) return;
  var script = document.currentScript;
  var base = new URL(script ? script.src : '/livechat/widget.js', location.href).origin;
  var color = ${JSON.stringify(String(getSetting('Livechat_title_color') ?? '#1d74f5'))};
  var opened = false, ready = false, queue = [];
  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Abrir atendimento');
  btn.style.cssText = 'position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;z-index:2147483646;box-shadow:0 4px 14px rgba(0,0,0,.25);color:#fff;font-size:26px;background:' + color;
  btn.textContent = '💬';
  var badge = document.createElement('span');
  badge.style.cssText = 'position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;background:#ec0d2a;color:#fff;font:bold 11px/18px sans-serif;display:none;padding:0 5px';
  btn.appendChild(badge);
  var frame = document.createElement('iframe');
  frame.title = 'Atendimento';
  frame.src = base + '/livechat';
  frame.style.cssText = 'position:fixed;right:20px;bottom:88px;width:370px;height:560px;max-width:calc(100vw - 40px);max-height:calc(100vh - 110px);border:0;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);z-index:2147483647;display:none;background:#fff';
  function post(msg) { if (ready) frame.contentWindow.postMessage(msg, base); else queue.push(msg); }
  function setOpen(v) { opened = v; frame.style.display = v ? 'block' : 'none'; btn.textContent = v ? '✕' : '💬'; btn.appendChild(badge); if (v) { badge.style.display = 'none'; post({ type: 'wescc:open' }); } }
  btn.onclick = function () { setOpen(!opened); };
  window.addEventListener('message', function (e) {
    if (e.origin !== base || !e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'wescc:ready') { ready = true; post({ type: 'wescc:page', url: location.href, title: document.title }); queue.splice(0).forEach(function (m) { frame.contentWindow.postMessage(m, base); }); }
    if (e.data.type === 'wescc:unread' && !opened) { badge.textContent = String(e.data.count); badge.style.display = e.data.count ? 'inline-block' : 'none'; }
    if (e.data.type === 'wescc:open') setOpen(true);
    if (e.data.type === 'wescc:minimize') setOpen(false);
  });
  function mount() { document.body.appendChild(frame); document.body.appendChild(btn); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  window.WesccLivechat = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    setDepartment: function (id) { post({ type: 'wescc:department', id: id }); },
    setGuest: function (g) { post({ type: 'wescc:guest', guest: g }); }
  };
})();
`;
}

export function widgetHtml() {
  const color = String(getSetting('Livechat_title_color') ?? '#1d74f5').replace(/[^#a-zA-Z0-9(),. %]/g, '');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Atendimento</title>
<style>
:root { --c: ${color}; --bg: #fff; --fg: #2f343d; --muted: #6c727a; --line: #e4e7ea; --soft: #f2f3f5; color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--fg); background: var(--bg); }
#app { display: flex; flex-direction: column; height: 100%; }
header { background: var(--c); color: #fff; padding: 12px 14px; display: flex; align-items: center; gap: 10px; }
header .t { flex: 1; min-width: 0; }
header .t strong { display: block; font-size: 15px; }
header .t span { font-size: 12px; opacity: .85; }
header button { background: rgba(255,255,255,.18); border: 0; color: #fff; border-radius: 6px; padding: 5px 8px; cursor: pointer; font-size: 12px; }
main { flex: 1; overflow-y: auto; padding: 12px; background: var(--soft); }
.form { display: flex; flex-direction: column; gap: 10px; padding: 16px; overflow-y: auto; flex: 1; }
.form p { margin: 0 0 4px; color: var(--muted); }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 500; }
input, select, textarea { font: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; color: var(--fg); background: #fff; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--c); outline-offset: -1px; }
.btn { background: var(--c); color: #fff; border: 0; border-radius: 6px; padding: 9px 14px; font-weight: 600; cursor: pointer; }
.btn.ghost { background: transparent; color: var(--c); border: 1px solid var(--c); }
.btn:disabled { opacity: .5; cursor: default; }
.msg { display: flex; margin: 6px 0; }
.msg .b { max-width: 80%; padding: 8px 11px; border-radius: 12px; background: #fff; border: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.me { justify-content: flex-end; }
.msg.me .b { background: var(--c); color: #fff; border-color: var(--c); }
.msg .n { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
.msg.me .n { display: none; }
.msg .b a { color: inherit; }
.sys { text-align: center; color: var(--muted); font-size: 12px; margin: 10px 0; }
.typing { font-size: 12px; color: var(--muted); padding: 0 14px; min-height: 18px; background: var(--soft); }
footer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--line); background: #fff; }
footer textarea { flex: 1; resize: none; height: 40px; max-height: 120px; }
.err { color: #ec0d2a; font-size: 13px; }
.stars { display: flex; gap: 6px; justify-content: center; font-size: 28px; }
.stars button { background: none; border: 0; cursor: pointer; filter: grayscale(1); font-size: 28px; }
.stars button.on { filter: none; }
.center { text-align: center; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  'use strict';
  var app = document.getElementById('app');
  var state = { config: null, token: null, room: null, messages: [], ws: null, page: null, department: null, prefill: null, typing: {}, unread: 0, closed: false, triggered: {} };
  var STORE = 'wescc.livechat.token';
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function token() {
    if (state.token) return state.token;
    try { state.token = localStorage.getItem(STORE); } catch (e) {}
    if (!state.token) {
      var a = new Uint8Array(18); crypto.getRandomValues(a);
      state.token = Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      try { localStorage.setItem(STORE, state.token); } catch (e) {}
    }
    return state.token;
  }
  function api(method, path, body) {
    var url = '/api/v1/' + path;
    var opts = { method: method, headers: { 'x-visitor-token': token() } };
    if (method === 'GET' && body) url += '?' + new URLSearchParams(body).toString();
    else if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) { return r.json().then(function (j) { if (!j.success) throw new Error(j.error || 'Erro'); return j; }); });
  }
  function parentPost(msg) { try { parent.postMessage(msg, '*'); } catch (e) {} }

  // Texto com links clicáveis, sem HTML.
  function richText(text) {
    var frag = document.createDocumentFragment();
    var re = /(https?:\\/\\/[^\\s<]+)/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(el('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer', text: m[1] }));
      last = m.index + m[1].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function header(sub) {
    var c = state.config;
    var agent = c && c.agent;
    return el('header', null, [
      el('div', { class: 't' }, [el('strong', { text: c ? (c.online || state.room ? c.theme.title : c.theme.offlineTitle) : 'Atendimento' }), el('span', { text: sub || (agent ? 'Você fala com ' + (agent.name || agent.username) : '') })]),
      state.room && !state.closed ? el('button', { text: 'Encerrar', onclick: closeChat }) : null,
      el('button', { text: '–', title: 'Minimizar', onclick: function () { parentPost({ type: 'wescc:minimize' }); } })
    ]);
  }

  function render() {
    app.textContent = '';
    var c = state.config;
    if (!c) { app.appendChild(header('Carregando…')); return; }
    if (!c.enabled) { app.appendChild(header()); app.appendChild(el('div', { class: 'form' }, [el('p', { text: 'O atendimento não está disponível.' })])); return; }
    if (state.survey) return renderSurvey();
    if (!state.room && !c.online) return renderOffline();
    if (!state.room && !state.registered && c.settings.registrationForm && !c.guest) return renderRegistration();
    renderChat();
  }

  function renderRegistration() {
    var c = state.config;
    app.appendChild(header());
    var err = el('div', { class: 'err' });
    var fields = [];
    var name = el('input', { required: true, autocomplete: 'name', value: (state.prefill && state.prefill.name) || '' });
    var email = el('input', { type: 'email', autocomplete: 'email', value: (state.prefill && state.prefill.email) || '' });
    if (c.settings.nameFieldRegistrationForm) fields.push(el('label', null, ['Nome', name]));
    if (c.settings.emailFieldRegistrationForm) fields.push(el('label', null, ['E-mail', email]));
    var deps = c.departments.filter(function (d) { return d.showOnRegistration; });
    var dep = null;
    if (deps.length > 1 && !state.department) {
      dep = el('select', null, [el('option', { value: '', text: 'Escolha o assunto' })].concat(deps.map(function (d) { return el('option', { value: d._id, text: d.name }); })));
      fields.push(el('label', null, ['Departamento', dep]));
    }
    var custom = {};
    c.customFields.forEach(function (f) {
      var input = f.options && f.options.length
        ? el('select', null, [el('option', { value: '', text: '' })].concat(f.options.map(function (o) { return el('option', { value: o, text: o }); })))
        : el('input', { value: f.defaultValue || '' });
      custom[f._id] = input;
      fields.push(el('label', null, [f.label + (f.required ? ' *' : ''), input]));
    });
    var submit = el('button', { class: 'btn', text: 'Iniciar conversa' });
    var form = el('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault();
      submit.disabled = true; err.textContent = '';
      var cf = {}; for (var k in custom) cf[k] = custom[k].value;
      var department = state.department || (dep && dep.value) || (deps.length === 1 ? deps[0]._id : undefined);
      api('POST', 'livechat/visitor', { visitor: { token: token(), name: name.value, email: email.value || undefined, department: department, customFields: cf } })
        .then(function (r) { state.config.guest = r.visitor; state.registered = true; state.department = department || null; render(); })
        .catch(function (e) { err.textContent = e.message; submit.disabled = false; });
    } }, [el('p', { text: c.messages.registrationFormMessage })].concat(fields, [err, submit]));
    app.appendChild(form);
  }

  function renderOffline() {
    var c = state.config;
    app.appendChild(header());
    if (!c.settings.displayOfflineForm) { app.appendChild(el('div', { class: 'form' }, [el('p', { text: c.messages.offlineMessage })])); return; }
    if (state.offlineSent) { app.appendChild(el('div', { class: 'form' }, [el('p', { text: c.messages.offlineSuccessMessage })])); return; }
    var err = el('div', { class: 'err' });
    var name = el('input', { required: true }), email = el('input', { type: 'email', required: true }), msg = el('textarea', { rows: 5, required: true });
    var deps = c.departments.filter(function (d) { return d.showOnOfflineForm; });
    var dep = deps.length > 1 ? el('select', null, [el('option', { value: '', text: 'Departamento (opcional)' })].concat(deps.map(function (d) { return el('option', { value: d._id, text: d.name }); }))) : null;
    var submit = el('button', { class: 'btn', text: 'Enviar mensagem' });
    app.appendChild(el('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault(); submit.disabled = true;
      api('POST', 'livechat/offline.message', { name: name.value, email: email.value, message: msg.value, department: dep ? dep.value || undefined : undefined })
        .then(function () { state.offlineSent = true; render(); })
        .catch(function (e) { err.textContent = e.message; submit.disabled = false; });
    } }, [el('p', { text: c.messages.offlineMessage }), el('label', null, ['Nome', name]), el('label', null, ['E-mail', email]), dep ? el('label', null, ['Departamento', dep]) : null, el('label', null, ['Mensagem', msg]), err, submit]));
  }

  var list, typingEl, input;
  function renderChat() {
    app.appendChild(header());
    list = el('main', { 'aria-live': 'polite' });
    typingEl = el('div', { class: 'typing' });
    app.appendChild(list);
    app.appendChild(typingEl);
    if (!state.messages.length && !state.room) list.appendChild(el('div', { class: 'sys', text: 'Envie uma mensagem para começar.' }));
    state.messages.forEach(function (m) { list.appendChild(renderMessage(m)); });
    if (state.closed) {
      var box = el('div', { class: 'form center' }, [el('p', { text: state.config.messages.conversationFinishedMessage })]);
      if (state.config.settings.transcript && state.room) {
        var em = el('input', { type: 'email', placeholder: 'seu@email.com', value: (state.config.guest && state.config.guest.email) || '' });
        box.appendChild(el('p', { text: state.config.messages.transcriptMessage }));
        box.appendChild(em);
        box.appendChild(el('button', { class: 'btn ghost', text: 'Enviar transcrição', onclick: function (e) {
          e.target.disabled = true;
          api('POST', 'livechat/transcript', { rid: state.room._id, email: em.value }).then(function () { e.target.textContent = 'Transcrição enviada ✓'; }).catch(function (x) { e.target.disabled = false; alert(x.message); });
        } }));
      }
      box.appendChild(el('button', { class: 'btn', text: 'Nova conversa', onclick: function () { state.room = null; state.closed = false; state.messages = []; state.config.agent = null; render(); } }));
      app.appendChild(box);
    } else {
      input = el('textarea', { placeholder: 'Digite sua mensagem…', maxlength: String(state.config.settings.limitTextLength || 5000), onkeydown: function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      }, oninput: typingPing });
      app.appendChild(el('footer', null, [input, el('button', { class: 'btn', text: 'Enviar', onclick: send })]));
      setTimeout(function () { input && input.focus(); }, 0);
    }
    scroll();
  }

  function renderMessage(m) {
    var sysTypes = { 'livechat-started': 'Atendimento iniciado', 'livechat-close': 'Conversa encerrada', 'livechat_transfer_history': 'Conversa transferida', 'omnichannel_placed_chat_on_hold': 'Conversa em espera', 'omnichannel_on_hold_chat_resumed': 'Conversa retomada', 'uj': '' };
    if (m.t) {
      var text = m.t === 'livechat_queue' ? m.msg : sysTypes[m.t];
      return text ? el('div', { class: 'sys', text: text }) : document.createTextNode('');
    }
    var me = m.visitorId && state.config.guest && m.visitorId === state.config.guest._id;
    return el('div', { class: 'msg' + (me ? ' me' : '') }, [el('div', null, [el('div', { class: 'n', text: m.u.name || m.u.username }), el('div', { class: 'b' }, [richText(m.msg || '')])])]);
  }
  function scroll() { if (list) list.scrollTop = list.scrollHeight; }

  function addMessage(m) {
    var i = state.messages.findIndex(function (x) { return x._id === m._id; });
    if (i >= 0) state.messages[i] = m; else state.messages.push(m);
    if (list) { if (i < 0) list.appendChild(renderMessage(m)); else render(); scroll(); }
    var me = m.visitorId && state.config.guest && m.visitorId === state.config.guest._id;
    if (!me && !m.t && document.hidden !== false) { state.unread++; parentPost({ type: 'wescc:unread', count: state.unread }); }
  }

  var typingTimer = null, typingOn = false;
  function typingPing() {
    if (!state.room || !state.ws || state.ws.readyState !== 1) return;
    if (!typingOn) { typingOn = true; state.ws.send(JSON.stringify({ type: 'typing', rid: state.room._id, typing: true })); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { typingOn = false; if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'typing', rid: state.room._id, typing: false })); }, 3000);
  }

  function ensureRoom() {
    if (state.room) return Promise.resolve(state.room);
    var p = state.config.guest ? Promise.resolve() : api('POST', 'livechat/visitor', { visitor: { token: token(), name: state.prefill && state.prefill.name, email: state.prefill && state.prefill.email, department: state.department || undefined } }).then(function (r) { state.config.guest = r.visitor; });
    return p.then(function () { return api('GET', 'livechat/room', { token: token(), department: state.department || '', url: (state.page && state.page.url) || '' }); })
      .then(function (r) { state.room = r.room; connect(true); return r.room; });
  }

  function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    ensureRoom().then(function (room) {
      return api('POST', 'livechat/message', { token: token(), rid: room._id, msg: text });
    }).then(function (r) { addMessage(r.message); }).catch(function (e) {
      input.value = text;
      if (/atendente|agentes|online/i.test(e.message)) { state.config.online = false; render(); } else alert(e.message);
    });
  }

  function closeChat() {
    if (!state.room || !confirm('Encerrar a conversa?')) return;
    api('POST', 'livechat/room.close', { token: token(), rid: state.room._id }).then(function () { onClosed(); }).catch(function (e) { alert(e.message); });
  }
  function onClosed() {
    if (state.closed) return;
    state.closed = true;
    if (state.config.settings.survey && state.room) state.survey = true;
    render();
  }

  function renderSurvey() {
    app.appendChild(header('Como foi o atendimento?'));
    var value = 0;
    var stars = el('div', { class: 'stars' });
    for (var i = 1; i <= 5; i++) (function (n) {
      stars.appendChild(el('button', { type: 'button', text: '⭐', 'aria-label': n + ' estrelas', onclick: function () { value = n; Array.prototype.forEach.call(stars.children, function (b, j) { b.className = j < n ? 'on' : ''; }); } }));
    })(i);
    var fb = el('textarea', { rows: 3, placeholder: 'Comentário (opcional)' });
    app.appendChild(el('div', { class: 'form center' }, [el('p', { text: 'Avalie de 1 a 5' }), stars, fb,
      el('button', { class: 'btn', text: 'Enviar avaliação', onclick: function () {
        var data = []; if (value) data.push({ name: 'satisfaction', value: String(value) }); if (fb.value.trim()) data.push({ name: 'additionalFeedback', value: fb.value.trim() });
        api('POST', 'livechat/room.survey', { token: token(), rid: state.room._id, data: data }).catch(function () {}).then(function () { state.survey = false; render(); });
      } }),
      el('button', { class: 'btn ghost', text: 'Pular', onclick: function () { state.survey = false; render(); } })]));
  }

  // ---------- Tempo real ----------
  var retry = 0;
  function connect(force) {
    if (state.ws && !force) return;
    if (state.ws) { try { state.ws.onclose = null; state.ws.close(); } catch (e) {} }
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/livechat/websocket?token=' + encodeURIComponent(token()));
    state.ws = ws;
    ws.onopen = function () { retry = 0; };
    ws.onmessage = function (e) {
      var ev; try { ev = JSON.parse(e.data); } catch (x) { return; }
      if (!state.room) return;
      if (ev.type === 'message' && ev.message.rid === state.room._id) { addMessage(ev.message); if (ev.message.t === 'livechat-close') onClosed(); }
      if (ev.type === 'typing' && ev.rid === state.room._id) {
        var guestName = state.config.guest && (state.config.guest.name || state.config.guest.username);
        if (ev.username === guestName) return;
        if (ev.typing) state.typing[ev.username] = Date.now(); else delete state.typing[ev.username];
        var names = Object.keys(state.typing);
        if (typingEl) typingEl.textContent = names.length ? names.join(', ') + ' está digitando…' : '';
      }
      if (ev.type === 'livechat.room' && ev.room && ev.room._id === state.room._id) {
        var wasAgent = state.config.agent && state.config.agent._id;
        state.config.agent = ev.room.servedBy || null;
        if (ev.room.status === 'closed') onClosed();
        else if ((state.config.agent && state.config.agent._id) !== wasAgent) render();
      }
    };
    ws.onclose = function () { state.ws = null; setTimeout(function () { connect(); }, Math.min(30000, 1000 * Math.pow(2, retry++))); };
  }
  setInterval(function () { if (state.ws && state.ws.readyState === 1) state.ws.send('{"type":"ping"}'); }, 25000);

  // ---------- Gatilhos ----------
  function runTriggers() {
    var c = state.config;
    if (!c || !c.triggers || state.room) return;
    c.triggers.forEach(function (t) {
      var key = 'wescc.trigger.' + t._id;
      if (state.triggered[t._id]) return;
      try { if (t.runOnce && localStorage.getItem(key)) return; } catch (e) {}
      t.conditions.forEach(function (cond) {
        var fire = function () {
          if (state.triggered[t._id] || state.room) return;
          state.triggered[t._id] = true;
          try { localStorage.setItem(key, '1'); } catch (e) {}
          t.actions.forEach(function (a) {
            if (a.name !== 'send-message') return;
            var name = a.params.sender === 'custom' ? a.params.name : (c.theme.title || 'Atendimento');
            state.messages.push({ _id: 'trigger-' + t._id, msg: a.params.msg, u: { username: name, name: name }, ts: new Date().toISOString() });
          });
          render();
          parentPost({ type: 'wescc:open' });
        };
        if (cond.name === 'time-on-site') setTimeout(fire, Math.max(0, Number(cond.value) || 0) * 1000);
        if (cond.name === 'page-url' && state.page) { try { if (new RegExp(cond.value).test(state.page.url)) fire(); } catch (e) {} }
        if (cond.name === 'chat-opened-by-visitor') state.onOpen = fire;
      });
    });
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d.type !== 'string' || d.type.indexOf('wescc:') !== 0) return;
    if (d.type === 'wescc:page') { state.page = { url: String(d.url || '').slice(0, 500), title: String(d.title || '').slice(0, 200) }; runTriggers(); }
    if (d.type === 'wescc:department') { state.department = String(d.id || '') || null; }
    if (d.type === 'wescc:guest' && d.guest) { state.prefill = { name: String(d.guest.name || ''), email: String(d.guest.email || '') }; }
    if (d.type === 'wescc:open') { state.unread = 0; parentPost({ type: 'wescc:unread', count: 0 }); if (state.onOpen) { state.onOpen(); state.onOpen = null; } }
  });

  function load() {
    api('GET', 'livechat/config', { token: token(), department: state.department || '' }).then(function (r) {
      state.config = r.config;
      if (r.config.room) {
        state.room = r.config.room;
        connect();
        return api('GET', 'livechat/messages.history/' + r.config.room._id, { token: token(), limit: 100 }).then(function (h) { state.messages = h.messages.reverse(); });
      }
    }).catch(function () { state.config = { enabled: false }; }).then(function () { render(); runTriggers(); });
  }
  render();
  load();
  parentPost({ type: 'wescc:ready' });
})();
</script>
</body>
</html>`;
}
