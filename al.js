// Alloha — отдельный плагин для Lampa (по образцу tu.js).
// Цепочка: kinopoisk id -> p.linkpp.ink/api/players -> Alloha token ->
// api.alloha.tv (метаданные + каталожные озвучки) -> страница плеера (viewporti
// + fileList) -> POST /bnsi/movies/<active.id> -> hlsSource (звуковые дорожки
// файла с качествами) + tracks (субтитры). Карточки фильма — каталожные
// озвучки, карточки сериала — серии; потоки прогреваются в фоне и в карточке
// показываются реальные качества и субтитры, а дорожка озвучки подбирается
// молча (без лишнего диалога). Заголовок
// Borth = sha256('fp|'+viewporti) + '|' + подпись(viewporti). CDN
// (*.vkvideo.cloud) отдаёт поток только с заголовком Origin плеера.
(function () {
  'use strict';

  if (window.alloha_plugin) return;

  var API_PLAYERS = 'https://p.linkpp.ink/api/players?kinopoisk=';
  var EXTERNALIDS_URL = 'https://akter-black.com/externalids';
  var ALLOHA_API = 'https://api.alloha.tv/';
  // rte-узлы proxy4..7 (Timeweb): для API их хватает.
  var API_PROXIES = [
    'https://proxy5.rte.net.ru/',
    'https://proxy6.rte.net.ru/',
    'https://proxy4.rte.net.ru/',
    'https://proxy7.rte.net.ru/'
  ];

  // ext.rte.net.ru:8443 — отдельный прокси с egress в другом ASN (не Timeweb),
  // поэтому обслуживает UHD-edge, который режет Timeweb. Держим его только для
  // МЕДИА (первым), чтобы разгрузить от API-запросов; rte-узлы — фолбэк.
  var MEDIA_PROXIES = ['https://ext.rte.net.ru:8443/'].concat(API_PROXIES);
  var TIMEOUT = 15000;

  // Токен linkpp меняется, но живой. Если p.linkpp.ink не отдал Alloha —
  // используем проверенный резервный.
  var DEFAULT_TOKEN = '5009a7a2d05cb714cc53c8408471e3';
  var LINKPP_REFERER = 'https://linkpp.ink/';

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  var preferProxy = false;

  // --- ДИАГНОСТИКА --------------------------------------------------------
  //
  // Логи (сеть, резолв, события <video>) идут в console.log('ALLOHA', …).
  // Экранная панель выключена по умолчанию и интерфейс не перекрывает.
  // При необходимости включить на сессию:
  //   window.alloha_dbg.on() / .off() / .clear() / .lines()
  //   клавиша F2 (или keyCode 113) — переключить панель.
  // Настройка не сохраняется: после перезапуска панель снова выключена.

  var DBG = {
    on: false,
    max: 160,
    lines: [],
    box: null,
    body: null,
    style: false,
    paint: null,
    videoTimer: 0,
    lastSample: 0,
    mediaOk: 0,
    mediaFail: 0,
    lastMediaOk: 0,
    lastMediaFail: 0
  };

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return String(url || '').slice(0, 40); }
  }

  function isMediaUrl(url) {
    var u = String(url || '');
    if (u.indexOf('/param/') !== -1) return true;
    if (u.indexOf('vkvideo.cloud') !== -1) return true;
    return /\.(m3u8|ts|m4s|mp4|mpd|vtt|aac)(\?|$)/i.test(u);
  }

  function shortUrl(url) {
    var s = String(url || '');

    // Медиа через rte: .../param/Origin=.../param/Referer=.../param/User-Agent=.../<target>
    if (s.indexOf('/param/') !== -1) {
      var m = s.match(/^[a-z]+:\/\/[^/]+\/([\s\S]*)$/i);
      var rest = m ? m[1] : s;
      rest = rest.replace(/^(?:param\/[^/]+\/)+/, '');
      return 'rte>' + hostOf(rest) + String(rest).replace(/^[a-z]+:\/\/[^/]+/i, '').slice(0, 44);
    }

    return hostOf(s) + s.replace(/^[a-z]+:\/\/[^/]+/i, '').slice(0, 72);
  }

  // Подпись CDN Alloha живёт ~5-6.5 мин; после этого медиа-запросы → 403.
  // Сигналим компоненту, чтобы тот перезапустил поток со свежим URL.
  function notifyMedia403() {
    try { document.dispatchEvent(new CustomEvent('alloha-media-403')); } catch (e) {}
  }

  function locInfo() {
    try { return (location.protocol || '') + '//' + (location.host || ''); } catch (e) { return 'n/a'; }
  }

  // Экранная панель выключена по умолчанию (перекрывает интерфейс). Логи всегда
  // идут в console.log('ALLOHA', …); панель можно включить вручную на сессию:
  // window.alloha_dbg.on() / .off() / .clear() / .lines().
  function dbgEnabled() {
    return DBG.on;
  }

  function dbgInstallStyle() {
    if (DBG.style) return;
    DBG.style = true;
    try {
      $('head').append(
        '<style>' +
        '.alloha-dbg{position:fixed;left:8px;bottom:8px;width:48%;max-height:54%;z-index:2147483000;' +
        'background:rgba(0,0,0,.72);color:#8ef;font:12px/1.35 monospace;border:1px solid rgba(120,200,255,.35);' +
        'border-radius:8px;overflow:hidden;pointer-events:none}' +
        '.alloha-dbg__bar{display:flex;justify-content:space-between;padding:3px 8px;background:rgba(20,60,90,.85);' +
        'color:#cfe;font-weight:700}' +
        '.alloha-dbg__x{pointer-events:auto;cursor:pointer;padding:0 4px}' +
        '.alloha-dbg__body{padding:4px 8px;overflow:hidden;white-space:pre-wrap;word-break:break-all}' +
        '</style>'
      );
    } catch (e) {}
  }

  function dbgEnsure() {
    if (DBG.box && DBG.box.parent && DBG.box.parent().length) return true;
    if (!$ || !document.body) return false;
    dbgInstallStyle();
    DBG.box = $(
      '<div class="alloha-dbg">' +
        '<div class="alloha-dbg__bar"><span>ALLOHA DEBUG (F2)</span>' +
        '<span class="alloha-dbg__x">выкл</span></div>' +
        '<div class="alloha-dbg__body"></div>' +
      '</div>'
    );
    DBG.body = DBG.box.find('.alloha-dbg__body');
    DBG.box.find('.alloha-dbg__x').on('click', function () { dbgSet(false); });
    $('body').append(DBG.box);
    return true;
  }

  function dbgSet(on) {
    DBG.on = !!on;
    if (!on && DBG.box) { DBG.box.remove(); DBG.box = null; DBG.body = null; }
    else if (on) { dbgEnsure(); dbgPaint(); }
  }

  function dbgPaint() {
    if (!dbgEnabled()) return;
    if (DBG.paint) return;
    DBG.paint = setTimeout(function () {
      DBG.paint = null;
      if (!dbgEnsure()) return;
      DBG.body.text(DBG.lines.join('\n'));
      try { DBG.body.scrollTop(DBG.body[0].scrollHeight); } catch (e) {}
    }, 120);
  }

  function dbgClear() { DBG.lines = []; dbgPaint(); }

  function clockText() {
    try {
      var d = new Date();
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) +
             ':' + ('0' + d.getSeconds()).slice(-2);
    } catch (e) { return ''; }
  }

  function dbg(tag, msg) {
    try { console.log('ALLOHA', tag, msg); } catch (e) {}
    if (!dbgEnabled()) return;
    DBG.lines.push(clockText() + ' [' + tag + '] ' + msg);
    if (DBG.lines.length > DBG.max) DBG.lines.shift();
    dbgPaint();
  }

  function diag(msg) { dbg('diag', msg); }

  // --- Хуки: сеть и <video> ----------------------------------------------

  // Выжимка тела ответа для диагностики 403 на ТВ: размер + начало.
  // 146b = гейт CDN/бан egress, 548b = WAF rte, 0b = CORS/сеть.
  function bodyInfo(x) {
    try {
      if (x.responseType && x.responseType !== 'text') return '';
      var t = x.responseText;
      if (t == null) return '';
      return ' [' + t.length + 'b: ' + String(t).replace(/\s+/g, ' ').slice(0, 64) + ']';
    } catch (e) { return ''; }
  }

  function dbgHookNet() {
    try {
      if (window.XMLHttpRequest && !XMLHttpRequest.__alHooked) {
        XMLHttpRequest.__alHooked = true;
        var open = XMLHttpRequest.prototype.open;
        var send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__alM = m; this.__alU = u; return open.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
          var x = this, t0 = Date.now();
          try {
            x.addEventListener('loadend', function () {
              var st = x.status || 0;
              var u = String(x.__alU || '');
              if (isMediaUrl(u)) {
                if (st >= 200 && st < 400) { DBG.mediaOk++; DBG.lastMediaOk = Date.now(); }
                else { DBG.mediaFail++; DBG.lastMediaFail = Date.now(); }
                if (st === 403) notifyMedia403();
              }
              var important = st >= 400 || st === 0 ||
                u.indexOf('.m3u8') !== -1 ||
                String(x.__alM || '').toUpperCase() === 'POST';
              if (important) {
                var info = (isMediaUrl(u) && (st >= 400 || st === 0)) ? bodyInfo(x) : '';
                dbg(st >= 400 || st === 0 ? 'NET!' : 'net',
                  (x.__alM || 'GET') + ' ' + st + ' ' + (Date.now() - t0) + 'ms ' + shortUrl(u) + info);
              }
            });
          } catch (e) {}
          return send.apply(this, arguments);
        };
      }
    } catch (e) {}

    try {
      if (window.fetch && !window.fetch.__alHooked) {
        var origFetch = window.fetch;
        var wrapped = function (input) {
          var url = (input && input.url) ? input.url : String(input);
          var t0 = Date.now();
          return origFetch.apply(this, arguments).then(function (res) {
            var st = (res && res.status) || 0;
            if (isMediaUrl(url)) {
              if (st >= 200 && st < 400) { DBG.mediaOk++; DBG.lastMediaOk = Date.now(); }
              else { DBG.mediaFail++; DBG.lastMediaFail = Date.now(); }
              if (st === 403) notifyMedia403();
            }
            if (st >= 400) dbg('NET!', 'fetch ' + st + ' ' + (Date.now() - t0) + 'ms ' + shortUrl(url));
            else if (String(url).indexOf('.m3u8') !== -1) dbg('net', 'm3u8 ' + st + ' ' + (Date.now() - t0) + 'ms ' + shortUrl(url));
            return res;
          }, function (err) {
            dbg('NET!', 'fetch FAIL ' + (Date.now() - t0) + 'ms ' + shortUrl(url) + ' ' + (err && err.message || ''));
            throw err;
          });
        };
        wrapped.__alHooked = true;
        window.fetch = wrapped;
      }
    } catch (e) {}
  }

  function dbgWatchVideo() {
    if (DBG.videoTimer) return;
    var misses = 0;
    DBG.videoTimer = setInterval(function () {
      var v = findMediaEl();

      if (!v) {
        if (++misses > 8) { clearInterval(DBG.videoTimer); DBG.videoTimer = 0; }
        return;
      }
      misses = 0;

      if (!v.__alDbg) {
        v.__alDbg = true;
        dbg('vid', 'attach src=' + shortUrl(v.currentSrc || v.src));
        ['loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'error', 'ended', 'seeking', 'seeked', 'emptied', 'pause'].forEach(function (ev) {
          v.addEventListener(ev, function () {
            var buf = 0, end = 0;
            try { if (v.buffered.length) { end = v.buffered.end(v.buffered.length - 1); buf = end - v.currentTime; } } catch (e) {}
            var bad = ev === 'stalled' || ev === 'error' || ev === 'emptied';
            dbg(bad ? 'VID!' : 'vid',
              ev + ' t=' + Math.round(v.currentTime) + ' end=' + Math.round(end) + ' buf=' + Math.round(buf) + 's' +
              ' rs=' + v.readyState + ' ns=' + v.networkState + (v.error ? ' ERR=' + v.error.code : ''));
          });
        });
      }

      var now = Date.now();
      if (now - DBG.lastSample > 5000) {
        DBG.lastSample = now;
        var buf2 = 0, end2 = 0;
        try { if (v.buffered.length) { end2 = v.buffered.end(v.buffered.length - 1); buf2 = end2 - v.currentTime; } } catch (e) {}
        var agoOk = DBG.lastMediaOk ? Math.round((now - DBG.lastMediaOk) / 1000) + 's' : '-';
        dbg('tick', 't=' + Math.round(v.currentTime) + ' end=' + Math.round(end2) + ' buf=' + Math.round(buf2) +
          's rs=' + v.readyState + ' ns=' + v.networkState +
          ' seg=' + DBG.mediaOk + '/' + DBG.mediaFail + ' lastOk=' + agoOk);
      }
    }, 1500);
  }

  function dbgKeys(e) {
    var k = (e && (e.key || '')) || '';
    if (k === 'F2' || (e && e.keyCode === 113)) {
      var on = !dbgEnabled();
      dbgSet(on);
      dbg('diag', 'debug ' + (on ? 'ON' : 'OFF'));
    }
  }

  try { document.addEventListener('keydown', dbgKeys, true); } catch (e) {}

  window.alloha_dbg = {
    on: function () { dbgSet(true); dbg('diag', 'manual ON'); },
    off: function () { dbgSet(false); },
    toggle: function () { var on = !dbgEnabled(); dbgSet(on); dbg('diag', 'debug ' + (on ? 'ON' : 'OFF')); },
    clear: dbgClear,
    lines: function () { return DBG.lines.slice(); }
  };

  // Активный обработчик 403 от медиа-CDN (ставит текущий компонент Alloha).
  var media403Handler = null;
  try {
    document.addEventListener('alloha-media-403', function () {
      if (media403Handler) media403Handler();
    });
  } catch (e) {}

  // --- Tizen: прямой поток + заголовок Origin через AVPlay -----------------
  //
  // CDN требует Origin плеера. На Tizen Lampa вызывает webapis.avplay.open(url)
  // без заголовков, а из JS Origin не выставить. Но AVPlay умеет
  // setStreamingProperty('HTTP_HEADER', ...) — патчим open и подставляем
  // Origin/Referer/User-Agent для нашей ссылки. Если прошивка не поддерживает —
  // сторож (restartStream при раннем стопе) отключит режим и уйдёт на прокси.
  //
  // Прямой путь важен: публичные прокси (rte/ext) режут по ASN egress (548b),
  // а IP телевизора CDN не блокирует.
  var TIZEN_HEADERS = true;
  var AVPLAY = { url: null, headers: null };

  function tizenDirect() {
    return TIZEN_HEADERS && Lampa.Platform.is('tizen');
  }

  function directPlatform() {
    return Lampa.Platform.is('android') || tizenDirect();
  }

  function patchAvplay() {
    try {
      if (!(window.webapis && webapis.avplay) || webapis.avplay.__alPatched) return;
      var open = webapis.avplay.open;
      webapis.avplay.__alPatched = true;
      webapis.avplay.open = function (url) {
        var res = open.apply(this, arguments);
        try {
          if (AVPLAY.headers && AVPLAY.url && url === AVPLAY.url) {
            webapis.avplay.setStreamingProperty('HTTP_HEADER', AVPLAY.headers);
            dbg('tizen', 'HTTP_HEADER set (' + AVPLAY.headers.split('\r\n').length + ' hdr)');
          }
        } catch (e) {
          dbg('tizen', 'HTTP_HEADER FAIL: ' + (e && e.message));
        }
        return res;
      };
    } catch (e) {}
  }

  function avplayHeaders(element) {
    var h = (element && element.headers) || {};
    var parts = [];
    if (h.Origin) parts.push('Origin: ' + h.Origin);
    if (h.Referer) parts.push('Referer: ' + h.Referer);
    parts.push('User-Agent: ' + (h['User-Agent'] || UA));
    return parts.join('\r\n');
  }

  // На Tizen плеер Lampa — это <object type="application/avplayer">, не <video>;
  // на остальных платформах — обычный <video>. Возвращаем текущий элемент плеера.
  function findMediaEl() {
    try {
      return document.querySelector('video') ||
        document.querySelector('.player-video_video') ||
        document.querySelector('object[type="application/avplayer"]') ||
        null;
    } catch (e) { return null; }
  }

  function isProxy(url) {
    return MEDIA_PROXIES.some(function (base) { return url.indexOf(base) === 0; });
  }

  // --- Прокси для медиапотока --------------------------------------------
  //
  // CDN Alloha (*.vkvideo.cloud) отдаёт файлы только с заголовком Origin плеера,
  // иначе 403. На Android Lampa играет нативно и Origin подставляет сама
  // (element.headers), а в браузере и на Tizen — нет: Origin запрещено задавать
  // из JS, а <video>/hls.js его не шлют.
  //
  // Решение — публичный прокси rte: он принимает произвольные заголовки в виде
  // param/<Имя>=<значение>/ и добавляет их к запросу на своей стороне. Ссылки
  // внутри HLS относительные — плеер достраивает их прямо в путь прокси, а
  // прокси отрезает param-префикс спереди, поэтому сегменты и вложенные
  // плейлисты уходят корректно, без ручного переписывания манифеста.
  var proxyIndex = 0;

  // URL медиа-хопа через конкретный прокси (param/... добавляют заголовки).
  function mediaProxyUrl(base, url, origin) {
    return base +
      'param/Origin=' + encodeURIComponent(origin) + '/' +
      'param/Referer=' + encodeURIComponent(origin + '/') + '/' +
      'param/User-Agent=' + encodeURIComponent(UA) + '/' +
      url;
  }

  function proxStream(url, origin, base) {
    if (!url) return url;
    if (directPlatform()) return url;
    if (isProxy(url)) return url;

    var proxy = base || MEDIA_PROXIES[proxyIndex++ % MEDIA_PROXIES.length];
    return mediaProxyUrl(proxy, url, origin);
  }

  // CDN Alloha блокирует часть IP (в т.ч. часть rte-нод) → медиа отдаёт 403.
  // Перед выдачей потока проверяем прокси коротким запросом манифеста и
  // закрепляем за потоком тот, что реально отвечает.
  function probeOnce(base, url, origin) {
    return new Promise(function (resolve) {
      var network = new Lampa.Reguest();
      network.timeout(7000);
      network.silent(mediaProxyUrl(base, url, origin), function (data) {
        resolve(!!data);
      }, function () {
        resolve(false);
      }, false, {
        dataType: 'text',
        headers: { 'User-Agent': UA, Origin: origin, Referer: origin + '/' }
      });
    });
  }

  // Общий egress у ext/rte периодически режет CDN: одиночный 403 не приговор,
  // следующая попытка часто проходит. Пробуем узел до PROBE_TRIES раз; успех —
  // при первой удачной попытке.
  var PROBE_TRIES = 3;
  var PROBE_DELAY = 400;

  function probeProxy(base, url, origin, tries) {
    var left = tries == null ? PROBE_TRIES : tries;
    return probeOnce(base, url, origin).then(function (ok) {
      if (ok) return true;
      if (left <= 1) return false;
      return new Promise(function (r) { setTimeout(r, PROBE_DELAY); })
        .then(function () { return probeProxy(base, url, origin, left - 1); });
    });
  }

  function chooseProxy(url, origin) {
    if (!url || directPlatform()) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var i = 0;
      (function next() {
        if (i >= MEDIA_PROXIES.length) {
          // Все пробы упали: чаще всего это кратковременный бан общего egress.
          // Не отдаём «мёртвый» false (это блокировало воспроизведение) — играем
          // через первый узел (ext) без пробы, а сторож перезапустит по 403.
          dbg('proxy', 'все пробы 403 → играю через ' + hostOf(MEDIA_PROXIES[0]) + ' без пробы');
          resolve(MEDIA_PROXIES[0]);
          return;
        }
        var base = MEDIA_PROXIES[i++];
        probeProxy(base, url, origin).then(function (ok) {
          if (ok) { dbg('proxy', 'выбран ' + hostOf(base)); resolve(base); }
          else { dbg('proxy', hostOf(base) + ' FAIL'); next(); }
        });
      })();
    });
  }

  // --- Сетевой слой (как в tu.js: прямой запрос, при неудаче — CORS-прокси) --

  // Гарантирует, что промис завершится не позже ms (иначе resolve(null)).
  // Нужно из-за возможных зависаний нативной сети на ТВ: один «зависший» слот
  // резолвера иначе держит очередь и блокирует все следующие запуски.
  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      promise.then(function (value) {
        if (done) return; done = true; clearTimeout(timer); resolve(value);
      }, function () {
        if (done) return; done = true; clearTimeout(timer); resolve(null);
      });
    });
  }

  function netOne(url, dataType, headers, post) {
    return new Promise(function (resolve) {
      var network = new Lampa.Reguest();
      network.timeout(TIMEOUT);
      network.silent(url, function (data) {
        resolve(data);
      }, function () {
        resolve(null);
      }, post || false, {
        dataType: dataType || 'text',
        headers: headers || {}
      });
    });
  }

  function fetchOne(url, dataType, headers) {
    return netOne(url, dataType, headers, false);
  }

  function postOne(url, body, headers) {
    return netOne(url, 'text', headers, body);
  }

  function orderFor(url) {
    var order = [url];

    // На Android у Lampa нативный сетевой слой — CORS/запрещённых заголовков
    // нет, поэтому прокси не нужны. В вебе — пробуем прокси.
    if (!Lampa.Platform.is('android')) {
      var proxied = API_PROXIES.map(function (base) { return base + url; });
      order = preferProxy ? proxied.concat([url]) : [url].concat(proxied);
    }

    return order;
  }

  function walk(order, headers, post) {
    return order.reduce(function (chain, candidate) {
      return chain.then(function (result) {
        if (result) return result;
        var t0 = Date.now();
        return withTimeout(netOne(candidate, 'text', headers, post), TIMEOUT + 2000).then(function (data) {
          if (data && isProxy(candidate)) preferProxy = true;
          dbg('api', (post ? 'POST ' : 'GET ') + (isProxy(candidate) ? 'proxy ' : '') + hostOf(candidate) +
            (data ? ' ok ' : ' FAIL ') + (Date.now() - t0) + 'ms');
          return data;
        });
      });
    }, Promise.resolve(null));
  }

  function req(url, dataType, headers) {
    return walk(orderFor(url), headers, false);
  }

  // POST: тело — form-urlencoded. Заголовки (Origin/Referer/Borth) несут гейт,
  // поэтому на Android идут напрямую, в вебе — через прокси.
  function reqPost(url, body, headers) {
    return walk(orderFor(url), headers, body);
  }

  function asObject(data) {
    if (!data) return null;
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch (e) { return null; }
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function originOf(url) {
    try { return new URL(url).origin; } catch (e) { return ''; }
  }

  function num(text, fallback) {
    var m = String(text == null ? '' : text).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : fallback;
  }

  // "MM:SS" / "HH:MM:SS" -> секунды.
  function timeToSeconds(text) {
    var parts = String(text || '').split(':').map(function (p) { return parseInt(p, 10) || 0; });
    if (!parts.length) return 0;
    return parts.reduce(function (acc, p) { return acc * 60 + p; }, 0);
  }

  // Длительность Alloha: "01:00" = 1 ч 0 мин (H:MM), а не 60 секунд (MM:SS).
  // Отсюда и бралось "00:01" на всех карточках.
  function allohaDuration(text) {
    var parts = String(text || '').split(':');
    if (parts.length === 2) {
      return (parseInt(parts[0], 10) || 0) * 3600 + (parseInt(parts[1], 10) || 0) * 60;
    }
    return timeToSeconds(text);
  }

  // "2019-07-26" -> "26.07.2019".
  function dateText(value) {
    var m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
  }

  // --- Подпись Borth: sha256('fp|'+viewporti) + '|' + sign(viewporti) -------

  function sha256hex(msg) {
    function rr(n, x) { return (x >>> n) | (x << (32 - n)); }
    var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
             0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
             0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
             0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
             0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
             0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
             0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
             0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var bytes = [];
    for (var i = 0; i < msg.length; i++) {
      var c = msg.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) { bytes.push(192 | (c >> 6), 128 | (c & 63)); }
      else if (c < 0xD800 || c >= 0xE000) { bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63)); }
      else {
        i++; var c2 = msg.charCodeAt(i);
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
        bytes.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
      }
    }
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(0,0,0,0, (bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);
    var w = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      for (var j = 0; j < 16; j++) w[j] = (bytes[off+j*4]<<24) | (bytes[off+j*4+1]<<16) | (bytes[off+j*4+2]<<8) | bytes[off+j*4+3];
      for (j = 16; j < 64; j++) {
        var s0 = rr(7, w[j-15]) ^ rr(18, w[j-15]) ^ (w[j-15] >>> 3);
        var s1 = rr(17, w[j-2]) ^ rr(19, w[j-2]) ^ (w[j-2] >>> 10);
        w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
      }
      var a=H[0],b=H[1],cc=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for (j = 0; j < 64; j++) {
        var S1 = rr(6,e) ^ rr(11,e) ^ rr(25,e);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[j] + w[j]) | 0;
        var S0 = rr(2,a) ^ rr(13,a) ^ rr(22,a);
        var mj = (a & b) ^ (a & cc) ^ (b & cc);
        var t2 = (S0 + mj) | 0;
        h=g; g=f; f=e; e=(d+t1)|0; d=cc; cc=b; b=a; a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+cc)|0; H[3]=(H[3]+d)|0;
      H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }

  // Три перемешивания, снятые с плеера Alloha (см. tools). sign(vp) — их
  // композиция; проверено на живых страницах.
  function zy2(s) {
    var len = s.length; if (len <= 1) return s;
    var bits = 0; while ((1 << bits) < len) bits++;
    function bl(v) { if (v === 0) return 0; var n = 0; while (v > 0) { n++; v >>>= 1; } return n; }
    var c = new Array(bits + 1).fill(0);
    for (var i = 0; i < len; i++) c[bl(i)]++;
    var b2 = new Array(bits + 1), p = 0;
    for (var b = bits; b >= 0; b--) { var x = c[b]; b2[b] = s.slice(p, p + x); p += x; }
    var cur = new Array(bits + 1).fill(0), o = new Array(len);
    for (var j = 0; j < len; j++) { var k = bl(j); o[j] = b2[k].charAt(cur[k]++); }
    return o.join('');
  }

  function zZ2(s) {
    var len = s.length; if (len <= 1) return s;
    var bits = 0; while ((1 << bits) < len) bits++;
    function bo(v) { if (v === 0) return bits; var n = 0; while ((v & 1) === 0) { n++; v >>= 1; } return n; }
    var c = new Array(bits + 1).fill(0);
    for (var i = 0; i < len; i++) c[bo(i)]++;
    var b2 = new Array(bits + 1), p = 0;
    for (var b = 0; b <= bits; b++) { b2[b] = s.slice(p, p + c[b]); p += c[b]; }
    var cur = new Array(bits + 1).fill(0), o = new Array(len);
    for (var j = 0; j < len; j++) { var k = bo(j); o[j] = b2[k].charAt(cur[k]++); }
    return o.join('');
  }

  function z92(s) {
    var len = s.length; if (len <= 1) return s;
    function ip(v) {
      if (v < 2) return false;
      if (v % 2 === 0) return v === 2;
      for (var d = 3; d * d <= v; d += 2) if (v % d === 0) return false;
      return true;
    }
    var mod = (function (n) { for (var p = Math.max(2, n); !ip(p);) p++; return p; })(len + 1);
    var u = new Array(len).fill(false), ord = [], cur = 0;
    while (ord.length < len) { cur = (cur + 2) % mod; if (cur < len && !u[cur]) { ord.push(cur); u[cur] = true; } }
    var o = new Array(len);
    for (var i = 0; i < len; i++) o[ord[i]] = s[i];
    return o.join('');
  }

  function sign(vp) { return z92(zZ2(zy2(vp))); }

  function borthHeader(viewporti) {
    return sha256hex('fp|' + viewporti) + '|' + sign(viewporti);
  }

  // --- Разбор страницы плеера --------------------------------------------

  // Возвращает { viewporti, fileList } либо null. fileList встроен как
  //   fileList = JSON.parse('{...}');
  function parsePlayer(html) {
    var s = String(html || '');

    var vpMatch = s.match(/<meta\s+name=["']viewporti["']\s+content=["']([^"']+)["']/);
    var viewporti = vpMatch ? vpMatch[1] : null;

    var marker = 'JSON.parse(';
    var at = s.indexOf('fileList');
    if (at === -1) return null;
    at = s.indexOf(marker, at);
    if (at === -1) return null;
    at += marker.length;
    // Первый аргумент — строка в одинарных кавычках.
    var quote = s.charAt(at);
    if (quote !== "'" && quote !== '"') return null;
    var end = s.indexOf(quote + ')', at + 1);
    if (end === -1) return null;

    var raw = s.slice(at + 1, end);
    var fileList = null;
    try { fileList = JSON.parse(raw); } catch (e) { return null; }

    if (!fileList || !fileList.active || fileList.active.id == null) return null;
    if (!viewporti) return null;

    return { viewporti: viewporti, fileList: fileList };
  }

  // GET страницы плеера -> POST /bnsi -> { hlsSource, tracks, origin }
  function fetchStream(iframe, token) {
    dbg('resolve', 'page ' + shortUrl(iframe));
    return req(iframe, 'text', { 'User-Agent': UA, Referer: LINKPP_REFERER }).then(function (html) {
      var parsed = parsePlayer(html);
      if (!parsed) { dbg('resolve', 'parse FAIL (' + (html ? String(html).length : 0) + 'b)'); return null; }

      var fl = parsed.fileList;
      dbg('resolve', 'page ok active.id=' + fl.active.id + ' type=' + fl.type);
      var kind = fl.type === 'trailer' ? 'trailers' : 'movies';
      var origin = originOf(iframe);
      if (!origin) return null;

      var url = origin + '/bnsi/' + kind + '/' + fl.active.id;
      var headers = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        Origin: origin,
        Referer: iframe,
        Borth: borthHeader(parsed.viewporti)
      };
      // av1=1 -> в hlsSource появляются 1440/2160 (AV1/HEVC).
      var body = 'token=' + token + '&av1=1&autoplay=1&audio=&subtitle=';

      return reqPost(url, body, headers).then(function (data) {
        var json = asObject(data);
        if (!json || !json.hlsSource || !json.hlsSource.length) {
          dbg('resolve', 'bnsi FAIL (' + (data ? String(data).length : 0) + 'b) ' + shortUrl(url));
          return null;
        }
        dbg('resolve', 'bnsi ok voices=' + json.hlsSource.length + ' subs=' + ((json.tracks || []).length));

        return {
          hlsSource: json.hlsSource,
          tracks: json.tracks || [],
          origin: origin,
          iframe: iframe,
          active: fl.active
        };
      });
    });
  }

  // --- Модель потоков -----------------------------------------------------

  // quality: {"360":"url",...} -> { 360: "url", ... } (числовые ключи для меню).
  function qualityDict(entry) {
    var q = (entry && entry.quality) || {};
    var dict = {};
    Object.keys(q).forEach(function (key) {
      var n = parseInt(key, 10);
      if (n && q[key]) dict[n] = q[key];
    });
    return dict;
  }

  function qualityNumbers(dict) {
    return Object.keys(dict).map(Number).sort(function (a, b) { return a - b; });
  }

  // По умолчанию играем лучшее качество до 1080p включительно: 1440/2160 у
  // Alloha приходят только при av1=1 и могут не проиграться на части
  // устройств. Полный набор всё равно уходит в меню качества Lampa.
  function defaultQuality(dict) {
    var nums = qualityNumbers(dict);
    if (!nums.length) return null;

    var safe = nums.filter(function (n) { return n <= 1080; });
    if (safe.length) return safe[safe.length - 1];
    return nums[nums.length - 1];
  }

  function bestUrl(dict) {
    var n = defaultQuality(dict);
    return n ? dict[n] : null;
  }

  function subsOf(tracks) {
    return (tracks || []).filter(function (t) {
      return t && t.kind === 'captions' && t.src;
    }).map(function (t, index) {
      // У некоторых дорожек src содержит несколько адресов через ' or '.
      var url = String(t.src).split(/\s+or\s+/)[0];
      return { label: t.label || ('Субтитры ' + (index + 1)), url: url, index: index };
    }).filter(function (sub) { return !!sub.url; });
  }

  // Метка озвучки из метаданных ("HDrezka Studio") и метка hlsSource
  // ("(Russian) DUB HDrezka Studio") различаются языковым префиксом —
  // сравниваем «хвост» без него.
  function normalizeVoice(label) {
    return String(label == null ? '' : label)
      .replace(/^\([^)]*\)\s*/, '')
      .trim()
      .toLowerCase();
  }

  // hlsSource = список озвучек физического файла. Находим нужную по метке из
  // фильтра; если точного совпадения нет — мягкое совпадение по включению.
  function findTrack(stream, preferred) {
    var list = (stream && stream.hlsSource) || [];
    if (!list.length) return null;

    var want = normalizeVoice(preferred);
    if (!want) return null;

    var i;
    for (i = 0; i < list.length; i++) {
      if (normalizeVoice(list[i].label) === want) return list[i];
    }
    for (i = 0; i < list.length; i++) {
      var have = normalizeVoice(list[i].label);
      if (have && (have.indexOf(want) !== -1 || want.indexOf(have) !== -1)) return list[i];
    }

    return null;
  }

  // --- Прогрев карточек: реальные качества и субтитры из /bnsi -------------
  //
  // Реальных качеств и субтитров в метаданных api.alloha.tv нет — они приходят
  // только из ответа /bnsi, причём набор (hlsSource) у каждого translation
  // свой (§6.1 журнала). Поэтому карточки прогреваем в фоне: резолвим поток
  // заранее и обновляем подпись; кэш потом отдаёт поток по клику мгновенно.

  var streamCache = {};        // iframe -> { promise, time }  (time=0 пока идёт)
  var resolveActive = 0;
  var resolveQueue = [];
  var RESOLVE_MAX = 2;
  // Прогрев карточек (подписи качеств/субтитров) может жить долго — подпись
  // CDN всё равно проверяется при воспроизведении.
  var STREAM_TTL = 10 * 60 * 1000;
  // А вот ДЛЯ ВОСПРОИЗВЕДЕНИЯ подписанный URL нельзя брать из старого кэша:
  // используем его только для дедупа быстрых повторных кликов.
  var PLAY_TTL = 20 * 1000;

  function pumpResolve() {
    while (resolveActive < RESOLVE_MAX && resolveQueue.length) {
      (function (job) {
        resolveActive++;
        var t0 = Date.now();
        dbg('queue', 'start (active=' + resolveActive + ' waiting=' + resolveQueue.length + ')');
        withTimeout(fetchStream(job.iframe, job.token), 30000).then(function (stream) {
          resolveActive--;
          if (!stream) { delete streamCache[job.iframe]; dbg('queue', 'null ' + (Date.now() - t0) + 'ms'); }
          else job.rec.time = Date.now();
          job.resolve(stream);
          pumpResolve();
        }, function () {
          resolveActive--;
          delete streamCache[job.iframe];
          dbg('queue', 'error ' + (Date.now() - t0) + 'ms');
          job.resolve(null);
          pumpResolve();
        });
      })(resolveQueue.shift());
    }
  }

  // iframe -> Promise<stream>. Повторные запросы дедуплицируются, параллелизм
  // ограничен RESOLVE_MAX, а готовый поток живёт STREAM_TTL — после этого
  // перерезолвим, чтобы подписанный m3u8 не успел протухнуть.
  function resolveStream(iframe, token, maxAge) {
    if (!iframe) return Promise.resolve(null);

    var ttl = typeof maxAge === 'number' ? maxAge : STREAM_TTL;
    var cached = streamCache[iframe];
    if (cached) {
      var age = cached.time ? (Date.now() - cached.time) : 0;
      if (cached.time === 0 || age < ttl) {
        dbg('resolve', 'cache hit age=' + Math.round(age / 1000) + 's ' + shortUrl(iframe));
        return cached.promise;
      }
      dbg('resolve', 'cache STALE age=' + Math.round(age / 1000) + 's -> re-resolve');
      delete streamCache[iframe];
    }

    var rec = { time: 0, promise: null };
    rec.promise = new Promise(function (resolve) {
      resolveQueue.push({ iframe: iframe, token: token, resolve: resolve, rec: rec });
      pumpResolve();
    });
    streamCache[iframe] = rec;
    return rec.promise;
  }

  // Мягкий выбор дорожки физического файла: совпадение с выбранной озвучкой →
  // первая русская → первая. Диалог не показываем: озвучку пользователь уже
  // выбрал карточкой, а один translation может содержать несколько дорожек
  // (§6.1), из-за чего и вылезал лишний выбор.
  function pickTrack(stream, preferred) {
    var list = (stream && stream.hlsSource) || [];
    if (!list.length) return null;

    var matched = findTrack(stream, preferred);
    if (matched) return matched;

    var russian = list.filter(function (src) {
      return /\(russian\)|\b(rus|рус)/i.test(src.label || '');
    });

    return russian[0] || list[0];
  }

  function maxQuality(stream) {
    var max = 0;
    ((stream && stream.hlsSource) || []).forEach(function (src) {
      qualityNumbers(qualityDict(src)).forEach(function (n) { if (n > max) max = n; });
    });
    return max;
  }

  function qualityText(nums) {
    return (nums || []).map(function (n) { return n + 'p'; }).join(' / ');
  }

  // Объединённые качества всех дорожек файла + список субтитров.
  function describeStream(stream) {
    if (!stream) return '';

    var union = {};
    (stream.hlsSource || []).forEach(function (src) {
      qualityNumbers(qualityDict(src)).forEach(function (n) { union[n] = true; });
    });
    var nums = Object.keys(union).map(Number).sort(function (a, b) { return a - b; });

    var parts = [];
    if (nums.length) parts.push(qualityText(nums));
    if (subsOf(stream.tracks).length) parts.push('Субтитры');

    return parts.join(' · ');
  }

  // Сериал: сезоны -> серии, у серии карта "озвучка -> {iframe, quality}".
  function serialModel(meta) {
    var voices = [];
    var seasons = [];

    var seasonKeys = Object.keys(meta.seasons || {}).sort(function (a, b) { return Number(a) - Number(b); });

    seasonKeys.forEach(function (sk, seasonIndex) {
      var season = meta.seasons[sk] || {};
      var seasonNumber = num(season.season, num(sk, seasonIndex + 1));

      var episodeKeys = Object.keys(season.episodes || {}).sort(function (a, b) { return Number(a) - Number(b); });
      var episodes = [];

      episodeKeys.forEach(function (ek, epIndex) {
        var ep = season.episodes[ek] || {};
        var number = num(ep.episode, num(ek, epIndex + 1));
        var tr = ep.translation || {};
        var map = {};

        Object.keys(tr).forEach(function (tk) {
          var t = tr[tk] || {};
          var name = t.translation || t.name;
          if (!name || !t.iframe) return;
          map[name] = { iframe: t.iframe, quality: t.quality || '' };
          if (voices.indexOf(name) === -1) voices.push(name);
        });

        if (Object.keys(map).length) {
          episodes.push({ number: number, translation: map });
        }
      });

      if (episodes.length) {
        seasons.push({ number: seasonNumber, episodes: episodes });
      }
    });

    return { voices: voices, seasons: seasons };
  }

  // Фильм: каталожные озвучки из translation_iframe; у каждой свой iframe
  // (translation= выбирает физический файл). Резолвим по клику, чтобы не
  // долбить /bnsi заранее.
  function movieVoices(meta) {
    var ti = meta.translation_iframe || {};
    var out = [];

    Object.keys(ti).forEach(function (tk) {
      var t = ti[tk] || {};
      if (!t.iframe) return;
      out.push({
        title: t.name || t.translation || ('Озвучка ' + tk),
        sub: t.quality || '',
        iframe: t.iframe,
        tk: tk
      });
    });

    if (!out.length && meta.iframe) {
      out.push({ title: 'Смотреть', sub: meta.quality || '', iframe: meta.iframe, tk: '' });
    }

    return out;
  }

  // --- Компонент ----------------------------------------------------------

  function Alloha(object) {
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var files = new Lampa.Explorer(object);
    var filter = new Lampa.Filter(object);
    var last = false;
    var initialized = false;
    var serial = null;
    var serialVoice = null;
    var serialSeason = null;
    var token = null;
    var metaTmdbId = null;

    // Сторож протухшей подписи CDN (URL Alloha живёт ~5-6.5 мин): при 403 на
    // медиа или при зависании воспроизведения перерезолвим поток и продолжим
    // с текущей позиции (Lampa сама доигрывает по timeline).
    var watchdog = null;
    var currentPlay = null;      // { item, hash, pick, playlist }
    var lastPos = -1;
    var lastPosAt = 0;
    var restarting = false;
    var restartCooldown = 0;
    var STALL_MS = 10000;

    this.create = function () {
      return this.render();
    };

    this.render = function () {
      return files.render();
    };

    this.back = function () {
      Lampa.Activity.backward();
    };

    this.loading = function (status) {
      if (status) this.activity.loader(true);
      else {
        this.activity.loader(false);
        this.activity.toggle();
      }
    };

    function status(html) {
      scroll.body().empty().append('<div class="alloha-status">' + escapeHtml(html) + '</div>');
    }

    function getKinopoiskId() {
      var movie = object.movie || {};
      if (movie.kinopoisk_id) return Promise.resolve(movie.kinopoisk_id);

      var query = ['id=' + encodeURIComponent(movie.id)];
      query.push('serial=' + (movie.name ? 1 : 0));
      if (movie.imdb_id) query.push('imdb_id=' + encodeURIComponent(movie.imdb_id));

      return req(EXTERNALIDS_URL + '?' + query.join('&'), 'text').then(function (data) {
        var json = asObject(data);
        return json ? json.kinopoisk_id : null;
      });
    }

    function movieTitle() {
      return object.movie.title || object.movie.name || 'Alloha';
    }

    function posterUrl(path) {
      if (!path) return null;
      try { return Lampa.TMDB.image('t/p/w300' + path); } catch (e) { return null; }
    }

    function movieArtwork() {
      var movie = object.movie || {};
      return movie.backdrop_path || movie.poster_path || null;
    }

    // --- TMDB: названия/даты/кадры серий и длительность ---------------------
    //
    // Alloha не отдаёт названия серий и точную длительность — берём из TMDB по
    // id_tmdb из метаданных api.alloha.tv (в замере 76479 для «Пацанов»).

    function tmdbReady() {
      return !!(Lampa.Api && Lampa.Api.sources && Lampa.Api.sources.tmdb &&
                typeof Lampa.Api.sources.tmdb.get === 'function');
    }

    function tmdbId() {
      if (metaTmdbId) return metaTmdbId;
      var movie = object.movie || {};
      return movie.tmdb_id || null;
    }

    var seasonMetaCache = {};

    // Номер сезона -> { номер_серии: {name, air_date, runtime, still} }.
    function seasonMeta(seasonNumber) {
      if (!tmdbReady() || !tmdbId()) return Promise.resolve(null);
      if (seasonMetaCache[seasonNumber]) return seasonMetaCache[seasonNumber];

      var p = new Promise(function (resolve) {
        try {
          Lampa.Api.sources.tmdb.get('tv/' + tmdbId() + '/season/' + seasonNumber, {}, function (data) {
            var map = {};
            ((data && data.episodes) || []).forEach(function (ep) {
              map[ep.episode_number] = {
                name: ep.name || '',
                air_date: ep.air_date || '',
                runtime: ep.runtime || 0,
                still: ep.still_path || ''
              };
            });
            resolve(Object.keys(map).length ? map : null);
          }, function () { resolve(null); });
        } catch (e) { resolve(null); }
      });

      p.then(function (map) { if (!map) delete seasonMetaCache[seasonNumber]; });
      seasonMetaCache[seasonNumber] = p;
      return p;
    }

    var movieRuntimeCache = null;

    // Рантайм фильма (секунды) из TMDB; 0 — неизвестно.
    function movieRuntime() {
      if (movieRuntimeCache !== null) return Promise.resolve(movieRuntimeCache);
      if (!tmdbReady() || !tmdbId()) return Promise.resolve(0);

      return new Promise(function (resolve) {
        try {
          Lampa.Api.sources.tmdb.get('movie/' + tmdbId(), {}, function (data) {
            movieRuntimeCache = ((data && data.runtime) || 0) * 60;
            resolve(movieRuntimeCache);
          }, function () { resolve(0); });
        } catch (e) { resolve(0); }
      });
    }

    function timeText(seconds) {
      if (!seconds) return '';
      try { return Lampa.Utils.secondsToTime(seconds, true); } catch (e) { return ''; }
    }

    // Хеши таймлайна — как в tu.js (двойной хеш для серий: original_name и
    // original_title), чтобы прогресс показывался и в списке серий, и на карточке.
    function episodeHash(season, episode, title) {
      return Lampa.Utils.hash('' + season + (season > 10 ? ':' : '') + episode + (title || ''));
    }

    function movieHash(title) {
      return Lampa.Utils.hash('' + (title || ''));
    }

    function timelineHash(season, episode) {
      var movie = object.movie || {};
      if (season) return episodeHash(season, episode, movie.original_name || movie.original_title);
      return movieHash(movie.original_title);
    }

    function timelineFor(season, episode) {
      var movie = object.movie || {};

      if (!season) return Lampa.Timeline.view(movieHash(movie.original_title));

      var primary = Lampa.Timeline.view(episodeHash(season, episode, movie.original_name || movie.original_title));
      var alt = Lampa.Timeline.view(episodeHash(season, episode, movie.original_title));
      var base = primary.handler;

      primary.handler = function (percent, time, duration) {
        base(percent, time, duration);
        alt.handler(percent, time, duration);
      };

      return primary;
    }

    function markWatch(item) {
      var movie = object.movie || {};

      if (movie.id) {
        try { if (Lampa.Favorite && Lampa.Favorite.add) Lampa.Favorite.add('history', movie, 100); } catch (e) {}
      }

      if (item && item.season) {
        try {
          var lastSeen = Lampa.Storage.cache('online_watched_last', 5000, {});
          var entry = { season: item.season, episode: item.episode };
          lastSeen[Lampa.Utils.hash('' + (movie.original_name || ''))] = entry;
          lastSeen[Lampa.Utils.hash('' + (movie.original_title || ''))] = entry;
          Lampa.Storage.set('online_watched_last', lastSeen);
        } catch (e) {}
      }
    }

    function makeCard(fields) {
      var html = $(
        '<div class="alloha-card selector">' +
          '<div class="alloha-card__img">' +
            (fields.poster ? '<img>' : '') +
            '<div class="alloha-card__loader"></div>' +
            '<div class="alloha-card__sub' + (fields.sub ? '' : ' hide') + '">' + escapeHtml(fields.sub || '') + '</div>' +
          '</div>' +
          '<div class="alloha-card__body">' +
            '<div class="alloha-card__head">' +
              '<div class="alloha-card__title">' + escapeHtml(fields.title) + '</div>' +
              '<div class="alloha-card__time' + (fields.time ? '' : ' hide') + '">' + escapeHtml(fields.time || '') + '</div>' +
            '</div>' +
            (fields.timeline ? '<div class="alloha-card__timeline"></div>' : '') +
            '<div class="alloha-card__info">' + escapeHtml(fields.info || '') + '</div>' +
          '</div>' +
        '</div>'
      );

      var loader = html.find('.alloha-card__loader');

      if (fields.poster) {
        var img = html.find('img')[0];
        img.onload = function () {
          $(img).addClass('loaded');
          loader.remove();
        };
        img.onerror = function () {
          img.src = './img/img_broken.svg';
        };
        img.src = fields.poster;
      } else {
        loader.remove();
      }

      if (fields.timeline) {
        try {
          var tl = typeof fields.timeline === 'object' ? fields.timeline : Lampa.Timeline.view(fields.timeline);
          // render() прячет трек при percent=0; снимаем hide, чтобы пустая
          // полоса прогресса была видна и на несмотренных карточках.
          html.find('.alloha-card__timeline').append(Lampa.Timeline.render(tl).removeClass('hide'));
        } catch (e) {}
      }

      html.on('hover:focus', function (e) {
        last = e.target;
        scroll.update($(e.target), true);
      });

      return html;
    }

    // Фоновый прогрев карточки: резолвим /bnsi и обновляем подпись реальными
    // качествами/субтитрами. Для фильмов максимальное качество уходит в бейдж;
    // у серий бейдж занят номером серии — там обновляем только info.
    function decorateCard(card, iframe, voice, useBadge) {
      resolveStream(iframe, token).then(function (stream) {
        if (!stream) return;

        var info = describeStream(stream);
        if (info) card.find('.alloha-card__info').text(info);

        if (!useBadge) return;
        var max = maxQuality(stream);
        if (!max) return;

        var badge = card.find('.alloha-card__sub');
        if (!badge.length) {
          badge = $('<div class="alloha-card__sub"></div>');
          card.find('.alloha-card__img').append(badge);
        }
        badge.removeClass('hide').text(max + 'p');
      });
    }

    function focusFirst() {
      Lampa.Controller.collectionSet(scroll.render(), files.render());
      Lampa.Controller.collectionFocus(last || false, scroll.render());
      Lampa.Controller.toggle('content');
    }

    // --- Воспроизведение ---------------------------------------------------

    // Превращаем результат bnsi в элемент плеера Lampa. entry — конкретная
    // озвучка из stream.hlsSource (выбранная или единственная).
    function toElement(stream, entry, item, hash, proxyBase) {
      var dict = qualityDict(entry);
      var url = proxStream(bestUrl(dict) || entry.url || null, stream.origin, proxyBase);
      if (!url) return null;

      var element = {
        title: movieTitle() +
          (item.season ? ' S' + item.season + 'E' + item.episode : '') +
          (item.title ? ' · ' + item.title : ''),
        url: url,
        // Нативный плеер (Android) шлёт эти заголовки сам; CDN Alloha
        // (*.vkvideo.cloud) требует Origin плеера, иначе 403. В браузере и на
        // Tizen заголовки подставляет прокси (proxStream).
        headers: {
          Origin: stream.origin,
          Referer: stream.origin + '/',
          'User-Agent': UA
        },
        timeline: timelineFor(item.season, item.episode),
        duration: item.duration,
        thumbnail: item.poster || null,
        isonline: true
      };

      if (item.season) element.season = item.season;
      if (item.episode) element.episode = item.episode;

      var nums = qualityNumbers(dict);
      if (nums.length) {
        // Меню качества Lampa тоже ходит на CDN — значения проксируем.
        var qdict = {};
        nums.forEach(function (n) { qdict[n] = proxStream(dict[n], stream.origin, proxyBase); });
        element.quality = qdict;
      }

      var subs = subsOf(stream.tracks);
      if (subs.length) {
        element.subtitles = subs.map(function (sub) {
          return { label: sub.label, url: proxStream(sub.url, stream.origin, proxyBase), index: sub.index };
        });
      }

      return element;
    }

    // Собрать элемент плеера: выбрать рабочий прокси и завернуть медиа.
    function buildElement(stream, entry, item, hash) {
      var dict = qualityDict(entry);
      var mainUrl = bestUrl(dict) || entry.url || null;
      return chooseProxy(mainUrl, stream.origin).then(function (base) {
        if (base === false) return null;      // ни один прокси не отдал поток
        return toElement(stream, entry, item, hash, base);
      });
    }

    // Нативный лоадер Lampa на время сетевого резолва потока.
    function withLoader(run) {
      var active = true;
      try {
        Lampa.Loading.start(function () {
          active = false;
          try { Lampa.Loading.stop(); } catch (e) {}
        }, 'Запускаю…');
      } catch (e) {}

      run(function stopLoad() {
        if (!active) return;
        active = false;
        try { Lampa.Loading.stop(); } catch (e) {}
      });
    }

    function play(element, item) {
      try {
        DBG.mediaOk = 0; DBG.mediaFail = 0; DBG.lastMediaOk = 0; DBG.lastMediaFail = 0;
        dbg('play', 'host=' + hostOf(element.url) + ' q=' + Object.keys(element.quality || {}).length +
          ' subs=' + ((element.subtitles || []).length) + ' urlLen=' + String(element.url || '').length +
          (tizenDirect() ? ' tizen=headers' : ''));
        dbgWatchVideo();

        if (tizenDirect()) {
          patchAvplay();
          AVPLAY.url = element.url;
          AVPLAY.headers = avplayHeaders(element);
        }
        markWatch(item);
        Lampa.Player.play(element);
        if (element.playlist) Lampa.Player.playlist(element.playlist);
        // element.subtitles достаточно только на событии ready, поэтому
        // дублируем явным вызовом — так кнопка субтитров появляется надёжно.
        if (element.subtitles && typeof Lampa.Player.subtitles === 'function') {
          Lampa.Player.subtitles(element.subtitles);
        }
      } catch (e) {
        Lampa.Noty.show('Ошибка плеера: ' + (e && e.message ? e.message : 'unknown'));
      }
    }

    // --- Сторож перезапуска потока ----------------------------------------

    function beginWatch(item, hash, pick, playlist) {
      currentPlay = { item: item, hash: hash, pick: pick, playlist: playlist || null };
      lastPos = -1;
      lastPosAt = Date.now();
      restarting = false;
      media403Handler = handleMedia403;

      if (watchdog) clearInterval(watchdog);
      watchdog = setInterval(watchTick, 2000);
    }

    function stopWatch() {
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      currentPlay = null;
      if (media403Handler === handleMedia403) media403Handler = null;
    }

    function watchTick() {
      if (restarting || !currentPlay) return;

      var v = findMediaEl();
      if (!v) { stopWatch(); return; }

      // Пауза/перемотка — сбрасываем отсчёт.
      if (v.paused || v.seeking) { lastPos = v.currentTime; lastPosAt = Date.now(); return; }

      if (v.currentTime > lastPos + 0.8) { lastPos = v.currentTime; lastPosAt = Date.now(); return; }

      if (Date.now() - lastPosAt > STALL_MS) {
        lastPosAt = Date.now();
        dbg('watchdog', 'stall t=' + Math.round(v.currentTime) + 's -> restart');
        restartStream();
      }
    }

    // 403 на медиа — свежий резолв и перезапуск с текущей позиции.
    function handleMedia403() {
      if (restarting || !currentPlay) return;
      if (Date.now() - restartCooldown < 15000) return;
      restartCooldown = Date.now();
      dbg('watchdog', 'media 403 -> restart');
      restartStream();
    }

    function restartStream() {
      if (restarting || !currentPlay) return;
      restarting = true;

      var cp = currentPlay;
      var at = 0, dur = 0;
      try {
        var v = findMediaEl();
        at = v ? v.currentTime : 0;
        dur = v ? (v.duration || 0) : 0;
      } catch (e) {}

      // Прямой режим Tizen не поехал (поток так и не начался) — значит
      // HTTP_HEADER не сработал: отключаем и уходим на прокси.
      if (tizenDirect() && at < 5) {
        TIZEN_HEADERS = false;
        dbg('tizen', 'заголовки не сработали -> proxy');
      }

      withLoader(function (stopLoad) {
        resolveStream(cp.item.iframe, token, 0).then(function (stream) {
          stopLoad();
          if (!stream) { restarting = false; Lampa.Noty.show('Не удалось перезапустить поток'); return; }

          var chosen = pickTrack(stream, cp.pick);
          buildElement(stream, chosen, cp.item, cp.hash).then(function (el) {
            if (!el) {
              restarting = false;
              dbg('watchdog', 'перезапуск не удался (403)');
              Lampa.Noty.show('Не удалось перезапустить поток');
              return;
            }

            if (at && dur) {
              el.timeline.time = at;
              el.timeline.percent = Math.min(99, Math.round(at / dur * 100));
              el.timeline.duration = dur;
            }

            if (cp.playlist && cp.playlist.length > 1) {
              el.playlist = buildPlaylist(cp.playlist, cp.item, el);
            }

            play(el, cp.item);
            restarting = false;
            lastPos = -1;
            lastPosAt = Date.now();
          });
        });
      });
    }

    // Фильм: играем ровно выбранную озвучку (никакого автоподбора).
    function playMovieCard(item, hash) {
      withLoader(function (stopLoad) {
        resolveStream(item.iframe, token, PLAY_TTL).then(function (stream) {
          stopLoad();
          if (!stream) { Lampa.Noty.show('Нет ссылки на поток'); return; }

          var chosen = pickTrack(stream, item.title);
          buildElement(stream, chosen, item, hash).then(function (element) {
            if (!element) { Lampa.Noty.show('Нет ссылки на поток'); return; }

            beginWatch(item, hash, item.title, null);
            play(element, item);
          });
        });
      });
    }

    // --- Отрисовка: фильм (карточки = озвучки) ------------------------------

    function renderItems(list) {
      scroll.body().empty();
      last = false;

      var hash = timelineHash();

      list.forEach(function (item) {
        var card = makeCard({
          title: item.title,
          sub: item.sub || '',
          poster: posterUrl(movieArtwork()),
          time: timeText(item.duration),
          timeline: hash,
          info: ''
        });

        card.on('hover:enter', function () {
          playMovieCard(item, hash);
        });

        scroll.append(card);
        decorateCard(card, item.iframe, item.title, true);
      });

      focusFirst();
    }

    // --- Отрисовка: сериал (дерево фильтруется выбранной озвучкой) ---------

    function episodeIframe(episode, voice) {
      var entry = episode.translation[voice];
      return entry ? entry.iframe : null;
    }

    function seasonsForVoice(model, voice) {
      return model.seasons.filter(function (season) {
        return season.episodes.some(function (episode) { return episodeIframe(episode, voice); });
      });
    }

    function episodesForVoice(season, voice) {
      return season.episodes.filter(function (episode) { return episodeIframe(episode, voice); });
    }

    function getSerialChoice() {
      var all = Lampa.Storage.cache('alloha_serial_choice', 5000, {});
      return all[object.movie.id] || null;
    }

    function saveSerialChoice() {
      var all = Lampa.Storage.cache('alloha_serial_choice', 5000, {});
      all[object.movie.id] = { voice: serialVoice, season: serialSeason };
      Lampa.Storage.set('alloha_serial_choice', all);
    }

    function buildSerialFilter() {
      if (!serial) return;

      var seasons = seasonsForVoice(serial, serialVoice);

      filter.set('filter', [
        {
          title: 'Озвучка',
          subtitle: serialVoice,
          stype: 'voice',
          items: serial.voices.map(function (voice, index) {
            return { title: voice, selected: voice === serialVoice, index: index };
          })
        },
        {
          title: 'Сезон',
          subtitle: 'Сезон ' + serialSeason,
          stype: 'season',
          items: seasons.map(function (season, index) {
            return { title: 'Сезон ' + season.number, selected: season.number === serialSeason, index: index };
          })
        }
      ]);

      filter.chosen('filter', ['Озвучка: ' + serialVoice, 'Сезон: ' + serialSeason]);
    }

    function renderSeason() {
      if (!serial) return;

      var season = seasonsForVoice(serial, serialVoice).filter(function (s) {
        return s.number === serialSeason;
      })[0];

      if (!season) {
        status('Серии не найдены');
        return;
      }

      scroll.body().empty();
      last = false;

      var episodeList = episodesForVoice(season, serialVoice);
      var playlist = [];
      var cards = {};

      episodeList.forEach(function (episode) {
        var hash = timelineHash(season.number, episode.number);
        var sub = 'S' + season.number + ' E' + episode.number;

        var entry = {
          iframe: episodeIframe(episode, serialVoice),
          voice: serialVoice,
          hash: hash,
          sub: sub,
          name: '',
          season: season.number,
          episode: episode.number,
          poster: posterUrl(movieArtwork()),
          duration: 0
        };
        playlist.push(entry);

        var card = makeCard({
          title: 'Серия ' + episode.number,
          sub: sub,
          poster: entry.poster,
          time: '',
          timeline: hash,
          info: ''
        });
        cards[episode.number] = card;

        card.on('hover:enter', function () {
          playEpisode(entry, hash, playlist);
        });

        scroll.append(card);
      });

      focusFirst();

      // Название, дата выхода, длительность и кадр серии — из TMDB.
      seasonMeta(season.number).then(function (meta) {
        if (!meta) return;

        playlist.forEach(function (entry) {
          var info = meta[entry.episode];
          if (!info) return;

          var card = cards[entry.episode];
          var art = info.still ? posterUrl(info.still) : null;

          if (info.name) card.find('.alloha-card__title').text(info.name);

          var date = dateText(info.air_date);
          if (date) card.find('.alloha-card__info').text(date);
          if (info.runtime) {
            card.find('.alloha-card__time').removeClass('hide').text(timeText(info.runtime * 60));
          }

          if (art) {
            entry.poster = art;
            var img = card.find('img')[0];
            if (img) img.src = art;
          }

          entry.name = info.name || '';
          entry.duration = info.runtime ? info.runtime * 60 : 0;
        });
      });
    }

    // Серия: соседние серии текущего сезона уходят в нативный плейлист
    // (ленивый резолв при переключении).
    function playEpisode(item, hash, playlist) {
      withLoader(function (stopLoad) {
        resolveStream(item.iframe, token, PLAY_TTL).then(function (stream) {
          stopLoad();
          if (!stream) {
            Lampa.Noty.show('Нет ссылки на поток');
            return;
          }

          var chosen = pickTrack(stream, item.voice);
          buildElement(stream, chosen, item, hash).then(function (element) {
            if (!element) {
              Lampa.Noty.show('Нет ссылки на поток');
              return;
            }

            if (playlist && playlist.length > 1) {
              element.playlist = buildPlaylist(playlist, item, element);
            }

            beginWatch(item, hash, item.voice, playlist);
            play(element, item);
          });
        });
      });
    }

    function buildPlaylist(entries, currentItem, currentElement) {
      return entries.map(function (entry) {
        var cell = {
          title: entry.name || entry.sub,
          season: entry.season,
          episode: entry.episode,
          timeline: Lampa.Timeline.view(entry.hash),
          thumbnail: entry.poster || null
        };

        if (entry.season === currentItem.season && entry.episode === currentItem.episode) {
          cell.url = currentElement.url;
          cell.headers = currentElement.headers;
          if (currentElement.quality) cell.quality = currentElement.quality;
          if (currentElement.subtitles) cell.subtitles = currentElement.subtitles;
        } else {
          cell.url = function (call) {
            resolveStream(entry.iframe, token, PLAY_TTL).then(function (stream) {
              if (!stream) {
                cell.url = '';
                Lampa.Noty.show('Нет ссылки на поток');
                call();
                return;
              }

              // Тихий выбор: в ленивом резолве диалог показывать нельзя.
              var chosen = pickTrack(stream, entry.voice);
              buildElement(stream, chosen, entry, entry.hash).then(function (el) {
                if (el) {
                  cell.url = el.url;
                  cell.headers = el.headers;
                  if (el.quality) cell.quality = el.quality;
                  if (el.subtitles) cell.subtitles = el.subtitles;
                  // Переключились на другую серию — сторож теперь ведёт её.
                  beginWatch(entry, entry.hash, entry.voice, entries);
                } else {
                  cell.url = '';
                  Lampa.Noty.show('Нет ссылки на поток');
                }
                call();
              });
            });
          };
        }

        return cell;
      });
    }

    function startSerial(model) {
      serial = model;

      var saved = getSerialChoice();
      serialVoice = (saved && serial.voices.indexOf(saved.voice) !== -1) ? saved.voice : serial.voices[0];

      var seasons = seasonsForVoice(serial, serialVoice);
      serialSeason = (saved && seasons.some(function (s) { return s.number === saved.season; }))
        ? saved.season : (seasons[0] ? seasons[0].number : null);

      files.appendHead(filter.render());
      scroll.minus(files.render().find('.explorer__files-head'));
      filter.render().find('.filter--search').addClass('hide');
      filter.render().find('.filter--sort').addClass('hide');

      filter.onBack = function () {
        try { Lampa.Controller.toggle('content'); } catch (e) {}
      };

      filter.onSelect = function (type, a, b) {
        if (type !== 'filter' || !serial) return;

        if (a.stype === 'voice') {
          serialVoice = serial.voices[b.index];
        } else if (a.stype === 'season') {
          var list = seasonsForVoice(serial, serialVoice);
          if (list[b.index]) serialSeason = list[b.index].number;
        }

        var valid = seasonsForVoice(serial, serialVoice);
        if (!valid.some(function (s) { return s.number === serialSeason; })) {
          serialSeason = valid[0] ? valid[0].number : null;
        }

        saveSerialChoice();

        setTimeout(function () {
          try { Lampa.Select.close(); } catch (e) {}
          buildSerialFilter();
          renderSeason();
          try { Lampa.Controller.toggle('content'); } catch (e) {}
        }, 20);
      };

      if (filter.addButtonBack) filter.addButtonBack();

      buildSerialFilter();
      renderSeason();
    }

    // --- Запуск ------------------------------------------------------------

    function discoverToken(kp) {
      return req(API_PLAYERS + kp, 'text', { 'User-Agent': UA, Referer: LINKPP_REFERER }).then(function (data) {
        var json = asObject(data);
        var list = (json && json.data) || [];
        var alloha = list.filter(function (p) { return p && p.type === 'Alloha'; })[0];
        var url = alloha && (alloha.iframeUrl ||
          (alloha.translations && alloha.translations[0] && alloha.translations[0].iframeUrl));
        if (!url) return null;
        try { return new URL(url).searchParams.get('token'); } catch (e) { return null; }
      });
    }

    function loadMeta(tok, kp) {
      return req(ALLOHA_API + '?token=' + tok + '&kp=' + kp, 'text').then(function (data) {
        var json = asObject(data);
        return json && json.data ? json.data : null;
      });
    }

    this.initialize = function () {
      this.loading(true);

      scroll.body().addClass('alloha-list');
      files.appendFiles(scroll.render());
      scroll.minus(files.render().find('.explorer__files-head'));

      Lampa.Controller.enable('content');
      this.loading(false);

      if (!object.movie) {
        status('Откройте карточку фильма и нажмите Alloha');
        return;
      }

      var load_on = true;
      var load_started = false;

      function loadDone() {
        load_on = false;
        try { Lampa.Loading.stop(); } catch (e) {}
      }

      function load(text) {
        if (!load_on) return;
        try {
          if (!load_started) {
            load_started = true;
            Lampa.Loading.start(function () {
              loadDone();
              try { Lampa.Activity.backward(); } catch (e) {}
            }, text || 'Поиск источника…');
          } else {
            Lampa.Loading.setText(text);
          }
        } catch (e) {}
      }

      function fail(html) {
        loadDone();
        status(html);
      }

      load('Поиск источника…');

      var plat = (Lampa.Platform && Lampa.Platform.is)
        ? ['tizen', 'webos', 'android', 'orsay', 'netcast'].filter(function (p) { return Lampa.Platform.is(p); }).join(',') || 'browser'
        : '?';
      dbg('start', 'loc=' + locInfo() + ' plat=' + plat + ' kp=' + (object.movie && object.movie.kinopoisk_id) +
        ' title=' + ((object.movie && (object.movie.title || object.movie.name)) || ''));

      getKinopoiskId().then(function (id) {
        if (!id) {
          dbg('start', 'kp id НЕ найден');
          fail('Не удалось определить kinopoisk ID');
          return;
        }
        dbg('start', 'kp=' + id);

        load('Ищу источник…');

        return discoverToken(id).then(function (tok) {
          token = tok || DEFAULT_TOKEN;
          dbg('start', 'token ' + (tok ? 'из linkpp' : 'DEFAULT') + ' ' + String(token).slice(0, 8) + '…');

          load('Загружаю данные…');

          return loadMeta(token, id).then(function (meta) {
            if (!meta) {
              dbg('start', 'meta НЕТ');
              fail('Alloha недоступен для этого фильма');
              return;
            }

            metaTmdbId = meta.id_tmdb || null;
            dbg('start', 'meta ok name=' + meta.name + ' tmdb=' + meta.id_tmdb +
              ' translation_iframe=' + Object.keys(meta.translation_iframe || {}).length +
              ' seasons=' + Object.keys(meta.seasons || {}).length);

            var isSerial = !!meta.seasons && Object.keys(meta.seasons).length > 0;

            if (isSerial) {
              var model = serialModel(meta);
              if (!model.seasons.length) {
                fail('Серии не найдены');
                return;
              }
              loadDone();
              startSerial(model);
              return;
            }

            // Фильм: карточки = каталожные озвучки; поток резолвим по клику.
            var voices = movieVoices(meta);
            if (!voices.length) {
              fail('Дорожки не найдены');
              return;
            }

            var duration = allohaDuration(meta.time);
            voices.forEach(function (item) {
              item.duration = duration;
              item.poster = meta.poster || null;
            });

            loadDone();
            renderItems(voices);

            // Длительность уточняем из TMDB (Alloha даёт только H:MM).
            movieRuntime().then(function (sec) {
              if (!sec) return;
              voices.forEach(function (item) { item.duration = sec; });
              scroll.body().find('.alloha-card__time').removeClass('hide').text(timeText(sec));
            });
          });
        });
      });
    };

    this.start = function () {
      if (Lampa.Activity.active().activity !== this.activity) return;

      if (!initialized) {
        initialized = true;
        this.initialize();
      }

      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render(), files.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        gone: function () {},
        left: function () {
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        right: function () {
          if (Navigator.canmove('right')) Navigator.move('right');
        },
        up: function () {
          if (Navigator.canmove('up')) Navigator.move('up');
          else Lampa.Controller.toggle('head');
        },
        down: function () {
          Navigator.move('down');
        },
        back: this.back.bind(this)
      });

      Lampa.Controller.toggle('content');
    };

    this.pause = function () {};
    this.stop = function () {};

    this.destroy = function () {
      stopWatch();
      if (files && typeof files.destroy === 'function') files.destroy();
      if (scroll && typeof scroll.destroy === 'function') scroll.destroy();
    };
  }

  function injectStyles() {
    if (document.getElementById('alloha-style')) return;
    var style = document.createElement('style');
    style.id = 'alloha-style';
    style.textContent = [
      '.alloha-status{padding:1.5em;color:rgba(255,255,255,.6)}',
      '.alloha-card{display:flex;align-items:center;gap:1em;padding:1em 1.2em;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.alloha-card.focus{background:rgba(255,255,255,.08)}',
      '.alloha-card__img{position:relative;flex:0 0 auto;width:8em;height:4.5em;border-radius:.4em;overflow:hidden;background:rgba(255,255,255,.06)}',
      '.alloha-card__img img{display:block;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .25s}',
      '.alloha-card__img img.loaded{opacity:1}',
      '.alloha-card__loader{position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.13),rgba(255,255,255,.05));background-size:200% 100%;animation:alloha-shimmer 1.2s infinite}',
      '@keyframes alloha-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '.alloha-card__sub{position:absolute;left:.3em;bottom:.3em;padding:.1em .45em;border-radius:.25em;background:rgba(0,0,0,.65);font-size:.8em;font-weight:600}',
      '.alloha-card__sub.hide{display:none}',
      '.alloha-card__time.hide{display:none}',
      '.alloha-card__body{flex:1 1 auto;min-width:0}',
      '.alloha-card__head{display:flex;justify-content:space-between;gap:1em}',
      '.alloha-card__title{font-size:1.1em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.alloha-card__time{flex:0 0 auto;font-size:.9em;color:rgba(255,255,255,.5)}',
      '.alloha-card__timeline{margin-top:.6em}',
      '.alloha-card__info{margin-top:.5em;font-size:.9em;color:rgba(255,255,255,.5)}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function addButton(render, movie) {
    if (!render || !render.length) return;
    if (render.find('.alloha--button').length) return;

    var button = $(
      '<div class="full-start__button selector view--alloha alloha--button">' +
        '<svg viewBox="0 0 24 24" width="1.2em" height="1.2em" fill="currentColor">' +
          '<path d="M8 5v14l11-7z"></path>' +
        '</svg>' +
        '<span>Alloha</span>' +
      '</div>'
    );

    button.on('hover:enter', function () {
      Lampa.Activity.push({
        url: '',
        title: 'Alloha',
        component: 'alloha',
        movie: movie
      });
    });

    render.after(button);
  }

  function startPlugin() {
    if (window.lampa_settings && window.lampa_settings.read_only) return;

    window.alloha_plugin = true;

    injectStyles();
    dbgHookNet();
    patchAvplay();
    if (dbgEnabled()) { dbgEnsure(); dbg('diag', 'plugin start ' + locInfo()); }
    Lampa.Component.add('alloha', Alloha);

    var manifest = {
      type: 'video',
      version: '1.0.0',
      name: 'Alloha',
      description: 'Онлайн-источник Alloha по Kinopoisk ID',
      component: 'alloha',
      onContextMenu: function () {
        return { name: 'Смотреть (Alloha)', description: '' };
      },
      onContextLauch: function (movie) {
        Lampa.Activity.push({
          url: '',
          title: 'Alloha',
          component: 'alloha',
          movie: movie
        });
      }
    };

    Lampa.Manifest.plugins = manifest;

    Lampa.Listener.follow('full', function (e) {
      if (e.type === 'complite') {
        addButton(e.object.activity.render().find('.view--torrent'), e.data.movie);
      }
    });

    try {
      var active = Lampa.Activity.active();
      if (active.component === 'full') {
        addButton(active.activity.render().find('.view--torrent'), active.card);
      }
    } catch (e) {}
  }

  if (window.alloha_test) {
    window.alloha_debug = {
      sha256hex: sha256hex,
      zy2: zy2,
      zZ2: zZ2,
      z92: z92,
      sign: sign,
      borthHeader: borthHeader,
      parsePlayer: parsePlayer,
      qualityDict: qualityDict,
      qualityNumbers: qualityNumbers,
      defaultQuality: defaultQuality,
      subsOf: subsOf,
      normalizeVoice: normalizeVoice,
      findTrack: findTrack,
      pickTrack: pickTrack,
      describeStream: describeStream,
      maxQuality: maxQuality,
      movieVoices: movieVoices,
      serialModel: serialModel,
      timeToSeconds: timeToSeconds,
      allohaDuration: allohaDuration,
      dateText: dateText
    };
  }

  if (window.appready) {
    startPlugin();
  } else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') startPlugin();
    });
  }
})();
