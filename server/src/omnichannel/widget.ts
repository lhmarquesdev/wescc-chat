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
#app { display: flex; flex-direction: column; height: 100%; position: relative; }
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
.msg > div { display: flex; flex-direction: column; align-items: flex-start; max-width: 80%; min-width: 0; }
.msg .b { max-width: 100%; padding: 8px 11px; border-radius: 12px; background: #fff; border: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.me { justify-content: flex-end; }
.msg.me > div { align-items: flex-end; }
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
.attach { flex: none; width: 40px; background: none; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font-size: 17px; cursor: pointer; }
.attach:hover { color: var(--c); border-color: var(--c); }
.upl { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12px; color: var(--muted); background: #fff; border-top: 1px solid var(--line); }
.upl:empty { display: none; }
.upl .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upl .bar { flex: none; width: 90px; height: 4px; border-radius: 2px; background: var(--soft); overflow: hidden; }
.upl .bar i { display: block; height: 100%; background: var(--c); transition: width .2s; }
.upl.err { color: #ec0d2a; }
.upl.err .name { white-space: normal; }
.upl button { background: none; border: 0; color: inherit; cursor: pointer; font-size: 13px; }
.att + .att, .b > span + .att { margin-top: 6px; }
.att-img { display: block; max-width: min(220px, 100%); max-height: 200px; min-width: 120px; min-height: 80px; border-radius: 8px; background: rgba(0,0,0,.06); cursor: zoom-in; }
.att-img.ok { min-width: 0; min-height: 0; background: none; }
.att-file { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; background: rgba(0,0,0,.05); text-decoration: none; cursor: pointer; }
.msg.me .att-file { background: rgba(255,255,255,.18); }
.att-file strong { display: block; font-size: 13px; overflow-wrap: anywhere; }
.att-file small { display: block; font-size: 11px; opacity: .8; }
.att-file.busy { opacity: .6; cursor: progress; }
.att-desc { font-size: 12px; margin-top: 3px; }
.drop { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; padding: 20px; text-align: center; background: rgba(255,255,255,.93); border: 2px dashed var(--c); color: var(--c); font-weight: 600; pointer-events: none; }
.lightbox { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; background: rgba(0,0,0,.85); }
.lightbox img { max-width: 100%; max-height: calc(100% - 64px); border-radius: 6px; }
.lightbox div { display: flex; gap: 8px; }
.lightbox .btn { text-decoration: none; }
.lightbox .btn.ghost { color: #fff; border-color: #fff; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  'use strict';
  var app = document.getElementById('app');
  var state = { config: null, token: null, room: null, messages: [], ws: null, page: null, department: null, prefill: null, typing: {}, unread: 0, closed: false, triggered: {}, draft: '', upload: null, uploadError: '' };
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

  // ---------- Arquivos ----------
  // Os arquivos são baixados com o cabeçalho x-visitor-token (nunca na URL) e exibidos por blob: URLs.
  var blobs = {};
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
    return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  }
  // Só /file-upload/<id>/<nome> no formato que o servidor gera (encodeURIComponent) e sem nada que o navegador
  // normalize para outro caminho (barra invertida, "..", "%2e"...): o token do visitante não vai para outra rota.
  function isFileUrl(url) {
    if (typeof url !== 'string' || !/^\\/file-upload\\/[A-Za-z0-9]+\\/[A-Za-z0-9%._~!'()*-]+$/.test(url)) return false;
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname === url;
    } catch (e) {
      return false;
    }
  }
  function fileBlob(url) {
    if (!blobs[url]) {
      blobs[url] = fetch(url, { headers: { 'x-visitor-token': token() }, credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error(r.status === 404 ? 'Arquivo não encontrado.' : 'Arquivo indisponível.');
        return r.blob();
      }).then(function (b) { return URL.createObjectURL(b); });
      blobs[url].catch(function () { delete blobs[url]; });
    }
    return blobs[url];
  }
  function resetBlobs() {
    for (var k in blobs) blobs[k].then(function (u) { URL.revokeObjectURL(u); }, function () {});
    blobs = {};
  }
  function saveBlob(href, name) {
    var a = el('a', { href: href, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function openLightbox(src, name) {
    var box = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': name, onclick: function (e) { if (e.target === box) close(); } }, [
      el('img', { src: src, alt: name }),
      el('div', null, [el('a', { class: 'btn', href: src, download: name, text: 'Baixar' }), el('button', { class: 'btn ghost', type: 'button', text: 'Fechar', onclick: function () { close(); } })])
    ]);
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() { box.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
  }
  function fileLink(a) {
    var name = a.title || 'arquivo';
    var link = el('a', { class: 'att att-file', href: '#', title: 'Baixar ' + name }, [
      el('span', { text: '📄', 'aria-hidden': 'true' }),
      el('span', null, [el('strong', { text: name }), el('small', { text: [a.format, fmtSize(a.size)].filter(Boolean).join(' · ') })])
    ]);
    link.addEventListener('click', function (e) {
      e.preventDefault();
      if (link.classList.contains('busy')) return;
      link.classList.add('busy');
      fileBlob(a.title_link).then(function (u) { saveBlob(u, name); }).catch(function (x) { setUploadError(x.message); }).then(function () { link.classList.remove('busy'); });
    });
    return link;
  }
  function renderAttachment(a) {
    // Só anexos de arquivo deste servidor; citações e links externos não são exibidos aqui.
    if (!a || !isFileUrl(a.title_link)) return null;
    var name = a.title || 'arquivo';
    var desc = a.description ? el('div', { class: 'att-desc', text: a.description }) : null;
    if (!a.image_url || !isFileUrl(a.image_url)) return desc ? el('div', { class: 'att' }, [fileLink(a), desc]) : fileLink(a);
    var img = el('img', { class: 'att-img', alt: name, title: name });
    var box = el('div', { class: 'att' }, [img, desc]);
    fileBlob(a.image_url).then(function (u) {
      var stick = atBottom();
      img.onload = function () { img.classList.add('ok'); if (stick) scroll(); };
      img.onerror = fallback;
      img.src = u;
      img.addEventListener('click', function () { openLightbox(u, name); });
    }).catch(fallback);
    function fallback() { if (img.parentNode === box) box.replaceChild(fileLink(a), img); }
    return box;
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

  var list, typingEl, input, uplEl, hint, nodes = {};
  function renderChat() {
    app.appendChild(header());
    list = el('main', { 'aria-live': 'polite' });
    typingEl = el('div', { class: 'typing' });
    uplEl = null;
    nodes = {};
    app.appendChild(list);
    app.appendChild(typingEl);
    hint = !state.messages.length && !state.room ? el('div', { class: 'sys', text: 'Envie uma mensagem para começar.' }) : null;
    if (hint) list.appendChild(hint);
    state.messages.forEach(function (m) { list.appendChild(nodes[m._id] = renderMessage(m)); });
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
      box.appendChild(el('button', { class: 'btn', text: 'Nova conversa', onclick: function () { state.room = null; state.closed = false; state.messages = []; state.config.agent = null; resetBlobs(); render(); } }));
      app.appendChild(box);
    } else {
      input = el('textarea', { placeholder: 'Digite sua mensagem…', maxlength: String(state.config.settings.limitTextLength || 5000), onkeydown: function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      }, oninput: function () { state.draft = input.value; typingPing(); }, onpaste: onPaste });
      input.value = state.draft;
      var picker = null, attach = null;
      if (canUpload()) {
        picker = el('input', { type: 'file', multiple: true, hidden: true, accept: state.config.settings.fileUploadAcceptedTypes.join(',') || null, onchange: function () { uploadFiles(picker.files); picker.value = ''; } });
        attach = el('button', { class: 'attach', type: 'button', title: 'Enviar arquivo', 'aria-label': 'Enviar arquivo', text: '📎', onclick: function () { picker.click(); } });
      }
      uplEl = el('div', { class: 'upl', 'aria-live': 'polite' });
      app.appendChild(uplEl);
      app.appendChild(el('footer', null, [attach, picker, input, el('button', { class: 'btn', text: 'Enviar', onclick: send })]));
      renderUpload();
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
    var body = m.msg ? [el('span', null, [richText(m.msg)])] : [];
    (m.attachments || []).forEach(function (a) { body.push(renderAttachment(a)); });
    return el('div', { class: 'msg' + (me ? ' me' : '') }, [el('div', null, [el('div', { class: 'n', text: m.u.name || m.u.username }), el('div', { class: 'b' }, body)])]);
  }
  function scroll() { if (list) list.scrollTop = list.scrollHeight; }
  function atBottom() { return !list || list.scrollHeight - list.scrollTop - list.clientHeight < 40; }

  function addMessage(m) {
    var i = state.messages.findIndex(function (x) { return x._id === m._id; });
    if (i >= 0) state.messages[i] = m; else state.messages.push(m);
    if (list && app.contains(list)) {
      // Substitui no lugar: um render() completo apagaria o que o visitante está digitando.
      var node = renderMessage(m), old = nodes[m._id];
      if (old && old.parentNode === list) list.replaceChild(node, old); else list.appendChild(node);
      nodes[m._id] = node;
      if (hint && hint.parentNode) hint.remove();
      scroll();
    }
    var me = m.visitorId && state.config.guest && m.visitorId === state.config.guest._id;
    if (i < 0 && !me && !m.t && document.hidden !== false) { state.unread++; parentPost({ type: 'wescc:unread', count: state.unread }); }
  }

  var typingTimer = null, typingOn = false;
  function typingPing() {
    if (!state.room || !state.ws || state.ws.readyState !== 1) return;
    if (!typingOn) { typingOn = true; state.ws.send(JSON.stringify({ type: 'typing', rid: state.room._id, typing: true })); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { typingOn = false; if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'typing', rid: state.room._id, typing: false })); }, 3000);
  }

  var roomPending = null;
  function ensureRoom() {
    if (state.room) return Promise.resolve(state.room);
    // Texto e arquivo enviados juntos esperam a mesma criação da conversa.
    if (roomPending) return roomPending;
    var p = state.config.guest ? Promise.resolve() : api('POST', 'livechat/visitor', { visitor: { token: token(), name: state.prefill && state.prefill.name, email: state.prefill && state.prefill.email, department: state.department || undefined } }).then(function (r) { state.config.guest = r.visitor; });
    roomPending = p.then(function () { return api('GET', 'livechat/room', { department: state.department || '', url: (state.page && state.page.url) || '' }); })
      .then(function (r) { state.room = r.room; roomPending = null; connect(true); return r.room; }, function (e) { roomPending = null; throw e; });
    return roomPending;
  }
  function offlineError(e) { return /atendente|agentes|online/i.test(e.message); }

  function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    state.draft = '';
    ensureRoom().then(function (room) {
      return api('POST', 'livechat/message', { token: token(), rid: room._id, msg: text });
    }).then(function (r) { addMessage(r.message); }).catch(function (e) {
      input.value = state.draft = text;
      if (offlineError(e)) { state.config.online = false; render(); } else alert(e.message);
    });
  }

  // ---------- Envio de arquivos ----------
  var uploadQueue = [], uploadBusy = false, uploadErrTimer = null;
  function canUpload() { var s = state.config && state.config.settings; return !!(s && s.fileUpload); }
  function typeMatches(type, patterns) {
    return (patterns || []).some(function (p) { return p.slice(-2) === '/*' ? type.indexOf(p.slice(0, -1)) === 0 : type === p; });
  }
  function checkFile(f) {
    var s = state.config.settings;
    var type = (f.type || 'application/octet-stream').toLowerCase();
    if (!f.size) return 'O arquivo "' + f.name + '" está vazio.';
    if (s.fileUploadMaxSize > 0 && f.size > s.fileUploadMaxSize) return 'O arquivo "' + f.name + '" passa do limite de ' + fmtSize(s.fileUploadMaxSize) + '.';
    if (typeMatches(type, s.fileUploadBlockedTypes) || (s.fileUploadAcceptedTypes.length && !typeMatches(type, s.fileUploadAcceptedTypes))) return 'O tipo do arquivo "' + f.name + '" não é permitido.';
    return '';
  }
  function setUploadError(msg) {
    state.uploadError = msg;
    renderUpload();
    clearTimeout(uploadErrTimer);
    if (msg) uploadErrTimer = setTimeout(function () { setUploadError(''); }, 8000);
  }
  function renderUpload() {
    if (!uplEl) return;
    uplEl.textContent = '';
    uplEl.className = 'upl';
    var u = state.upload;
    if (u) {
      var pct = Math.round(u.progress * 100) + '%';
      var bar = el('i');
      bar.style.width = pct;
      uplEl.appendChild(el('span', { class: 'name', text: 'Enviando ' + u.name + '…' + (uploadQueue.length ? ' (+' + uploadQueue.length + ' na fila)' : '') }));
      uplEl.appendChild(el('span', { class: 'bar' }, [bar]));
      uplEl.appendChild(el('span', { text: pct }));
    } else if (state.uploadError) {
      uplEl.className = 'upl err';
      uplEl.appendChild(el('span', { class: 'name', role: 'alert', text: state.uploadError }));
      uplEl.appendChild(el('button', { type: 'button', text: '✕', title: 'Fechar aviso', onclick: function () { setUploadError(''); } }));
    }
  }
  function uploadFiles(files) {
    if (!canUpload() || state.closed) return;
    var errors = [];
    Array.prototype.slice.call(files || []).forEach(function (f) { var err = checkFile(f); if (err) errors.push(err); else uploadQueue.push(f); });
    if (errors.length) setUploadError(errors.join(' '));
    nextUpload();
  }
  function nextUpload() {
    if (uploadBusy) return;
    var f = uploadQueue.shift();
    state.upload = f ? { name: f.name, progress: 0 } : null;
    renderUpload();
    if (!f) return;
    uploadBusy = true;
    ensureRoom().then(function (room) { return postFile(room, f); }).then(function (r) { addMessage(r.message); }).catch(function (e) {
      if (offlineError(e)) { uploadQueue = []; state.config.online = false; render(); }
      else if (e.errorType === 'error-file-upload-disabled') { uploadQueue = []; state.config.settings.fileUpload = false; render(); setUploadError(e.message); }
      else setUploadError(e.message);
    }).then(function () { uploadBusy = false; nextUpload(); });
  }
  function postFile(room, f) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/livechat/upload/' + encodeURIComponent(room._id));
      xhr.setRequestHeader('x-visitor-token', token());
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && state.upload) { state.upload.progress = e.loaded / e.total; renderUpload(); } };
      xhr.onload = function () {
        var j = {};
        try { j = JSON.parse(xhr.responseText); } catch (x) {}
        if (xhr.status >= 200 && xhr.status < 300 && j.success) return resolve(j);
        var err = new Error(j.error || (xhr.status === 413 ? 'Arquivo grande demais.' : 'Não foi possível enviar o arquivo.'));
        err.errorType = j.errorType;
        reject(err);
      };
      xhr.onerror = function () { reject(new Error('Falha de conexão ao enviar o arquivo.')); };
      var fd = new FormData();
      fd.append('file', f, f.name);
      xhr.send(fd);
    });
  }
  function onPaste(e) {
    var cd = e.clipboardData;
    if (!cd || !cd.files || !cd.files.length || !canUpload()) return;
    // Texto copiado de planilhas e editores vem também como imagem: nesse caso, cola o texto.
    if (Array.prototype.indexOf.call(cd.types || [], 'text/plain') >= 0) return;
    e.preventDefault();
    uploadFiles(cd.files);
  }
  var dragDepth = 0, dropEl = null;
  function hasFiles(e) { return !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  function canDrop() { return canUpload() && !!list && app.contains(list) && !state.closed && !!uplEl; }
  function showDrop(on) {
    if (on && !dropEl) dropEl = el('div', { class: 'drop', text: 'Solte o arquivo aqui para enviar' });
    if (on && dropEl.parentNode !== app) app.appendChild(dropEl);
    if (!on && dropEl && dropEl.parentNode) dropEl.remove();
  }
  // Sem preventDefault, soltar um arquivo faria o navegador abri-lo no lugar do widget.
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; showDrop(canDrop()); });
  document.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = canDrop() ? 'copy' : 'none'; });
  document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrop(false); });
  document.addEventListener('drop', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; showDrop(false); if (canDrop()) uploadFiles(e.dataTransfer.files); });

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
    api('GET', 'livechat/config', { department: state.department || '' }).then(function (r) {
      state.config = r.config;
      if (r.config.room) {
        state.room = r.config.room;
        connect();
        return api('GET', 'livechat/messages.history/' + r.config.room._id, { limit: 100 }).then(function (h) { state.messages = h.messages.reverse(); });
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
