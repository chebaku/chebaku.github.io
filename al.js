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
  var PROXIES = [
    'https://proxy4.rte.net.ru/',
    'https://proxy5.rte.net.ru/',
    'https://proxy6.rte.net.ru/',
    'https://proxy7.rte.net.ru/'
  ];
  var TIMEOUT = 15000;

  // Токен linkpp меняется, но живой. Если p.linkpp.ink не отдал Alloha —
  // используем проверенный резервный.
  var DEFAULT_TOKEN = '5009a7a2d05cb714cc53c8408471e3';
  var LINKPP_REFERER = 'https://linkpp.ink/';

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  var preferProxy = false;

  // --- ДИАГНОСТИКА (временно, для TV) -------------------------------------
  var DIAG = false;

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return String(url || '').slice(0, 40); }
  }

  function locInfo() {
    try { return (location.protocol || '') + '//' + (location.host || ''); } catch (e) { return 'n/a'; }
  }

  function diag(msg) {
    try { console.log('ALLOHA-DIAG', msg); } catch (e) {}
    try { Lampa.Noty.show('ALLOHA: ' + msg); } catch (e) {}
  }

  function isProxy(url) {
    return PROXIES.some(function (base) { return url.indexOf(base) === 0; });
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

  function proxStream(url, origin) {
    if (!url) return url;
    if (Lampa.Platform.is('android')) return url;
    if (isProxy(url)) return url;

    var base = PROXIES[proxyIndex++ % PROXIES.length];

    return base +
      'param/Origin=' + encodeURIComponent(origin) + '/' +
      'param/Referer=' + encodeURIComponent(origin + '/') + '/' +
      'param/User-Agent=' + encodeURIComponent(UA) + '/' +
      url;
  }

  // --- Сетевой слой (как в tu.js: прямой запрос, при неудаче — CORS-прокси) --

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
      var proxied = PROXIES.map(function (base) { return base + url; });
      order = preferProxy ? proxied.concat([url]) : [url].concat(proxied);
    }

    return order;
  }

  function walk(order, headers, post) {
    return order.reduce(function (chain, candidate) {
      return chain.then(function (result) {
        if (result) return result;
        return netOne(candidate, 'text', headers, post).then(function (data) {
          if (data && isProxy(candidate)) preferProxy = true;
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
    return req(iframe, 'text', { 'User-Agent': UA, Referer: LINKPP_REFERER }).then(function (html) {
      var parsed = parsePlayer(html);
      if (!parsed) return null;

      var fl = parsed.fileList;
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
        if (!json || !json.hlsSource || !json.hlsSource.length) return null;

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

  var streamCache = {};
  var resolveActive = 0;
  var resolveQueue = [];
  var RESOLVE_MAX = 2;

  function pumpResolve() {
    while (resolveActive < RESOLVE_MAX && resolveQueue.length) {
      (function (job) {
        resolveActive++;
        fetchStream(job.iframe, job.token).then(function (stream) {
          resolveActive--;
          if (!stream) delete streamCache[job.iframe];
          job.resolve(stream);
          pumpResolve();
        }, function () {
          resolveActive--;
          delete streamCache[job.iframe];
          job.resolve(null);
          pumpResolve();
        });
      })(resolveQueue.shift());
    }
  }

  // iframe -> Promise<stream>. Дублирующиеся запросы дедуплицируются кэшем,
  // параллелизм ограничен RESOLVE_MAX, чтобы не завалить /bnsi пачкой.
  function resolveStream(iframe, token) {
    if (!iframe) return Promise.resolve(null);
    if (streamCache[iframe]) return streamCache[iframe];

    var p = new Promise(function (resolve) {
      resolveQueue.push({ iframe: iframe, token: token, resolve: resolve });
      pumpResolve();
    });

    streamCache[iframe] = p;
    return p;
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

  function cleanLabel(label) {
    return String(label == null ? '' : label).replace(/^\([^)]*\)\s*/, '').trim();
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

    var subs = subsOf(stream.tracks);
    if (subs.length) {
      var labels = subs.map(function (s) { return cleanLabel(s.label); }).filter(Boolean);
      parts.push('субтитры: ' + (labels.length ? labels.join(', ') : subs.length));
    }

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
              (fields.time ? '<div class="alloha-card__time">' + escapeHtml(fields.time) + '</div>' : '') +
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
          html.find('.alloha-card__timeline').append(Lampa.Timeline.render(tl));
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
    function toElement(stream, entry, item, hash) {
      var dict = qualityDict(entry);
      var url = proxStream(bestUrl(dict) || entry.url || null, stream.origin);
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
        nums.forEach(function (n) { qdict[n] = proxStream(dict[n], stream.origin); });
        element.quality = qdict;
      }

      var subs = subsOf(stream.tracks);
      if (subs.length) {
        element.subtitles = subs.map(function (sub) {
          return { label: sub.label, url: proxStream(sub.url, stream.origin), index: sub.index };
        });
      }

      return element;
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
        if (DIAG) diag('play host=' + hostOf(element.url) + ' q=' + Object.keys(element.quality || {}).length);
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

    // Фильм: озвучка выбирает физический файл (translation=), POST отдаёт его
    // дорожки. Поток обычно уже прогрет decorateCard; дорожку подбираем молча
    // (pickTrack), без лишнего диалога выбора.
    function playMovieCard(item, hash) {
      withLoader(function (stopLoad) {
        resolveStream(item.iframe, token).then(function (stream) {
          stopLoad();

          if (!stream) {
            Lampa.Noty.show('Нет ссылки на поток');
            return;
          }

          var chosen = pickTrack(stream, item.title);
          var element = toElement(stream, chosen, item, hash);
          if (!element) {
            Lampa.Noty.show('Нет ссылки на поток');
            return;
          }

          play(element, item);
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
      var playlist = episodeList.map(function (episode) {
        return {
          iframe: episodeIframe(episode, serialVoice),
          voice: serialVoice,
          hash: timelineHash(season.number, episode.number),
          sub: 'S' + season.number + ' E' + episode.number,
          season: season.number,
          episode: episode.number,
          poster: posterUrl(movieArtwork())
        };
      });

      episodeList.forEach(function (episode) {
        var hash = timelineHash(season.number, episode.number);
        var quality = (episode.translation[serialVoice] || {}).quality || '';

        var card = makeCard({
          title: 'Серия ' + episode.number,
          sub: 'S' + season.number + ' E' + episode.number,
          poster: posterUrl(movieArtwork()),
          time: '',
          timeline: hash,
          info: quality
        });

        card.on('hover:focus', function () {
          decorateCard(card, episodeIframe(episode, serialVoice), serialVoice, false);
        });

        card.on('hover:enter', function () {
          playEpisode({
            iframe: episodeIframe(episode, serialVoice),
            voice: serialVoice,
            season: season.number,
            episode: episode.number
          }, hash, playlist);
        });

        scroll.append(card);
      });

      focusFirst();
    }

    // Серия: соседние серии текущего сезона уходят в нативный плейлист
    // (ленивый резолв при переключении).
    function playEpisode(item, hash, playlist) {
      withLoader(function (stopLoad) {
        resolveStream(item.iframe, token).then(function (stream) {
          stopLoad();
          if (!stream) {
            Lampa.Noty.show('Нет ссылки на поток');
            return;
          }

          var chosen = pickTrack(stream, item.voice);
          var element = toElement(stream, chosen, item, hash);
          if (!element) {
            Lampa.Noty.show('Нет ссылки на поток');
            return;
          }

          if (playlist && playlist.length > 1) {
            element.playlist = buildPlaylist(playlist, item, element);
          }

          play(element, item);
        });
      });
    }

    function buildPlaylist(entries, currentItem, currentElement) {
      return entries.map(function (entry) {
        var cell = {
          title: entry.sub,
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
            fetchStream(entry.iframe, token).then(function (stream) {
              if (!stream) {
                cell.url = '';
                Lampa.Noty.show('Нет ссылки на поток');
                call();
                return;
              }

              // Тихий выбор: в ленивом резолве диалог показывать нельзя.
              var chosen = pickTrack(stream, entry.voice);
              var el = toElement(stream, chosen, entry, entry.hash);
              if (el) {
                cell.url = el.url;
                cell.headers = el.headers;
                if (el.quality) cell.quality = el.quality;
                if (el.subtitles) cell.subtitles = el.subtitles;
              } else {
                cell.url = '';
                Lampa.Noty.show('Нет ссылки на поток');
              }
              call();
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

      if (DIAG) {
        var plat = (Lampa.Platform && Lampa.Platform.is)
          ? ['tizen', 'webos', 'android', 'orsay', 'netcast'].filter(function (p) { return Lampa.Platform.is(p); }).join(',')
          : '?';
        diag('loc=' + locInfo() + ' plat=' + plat);
      }

      getKinopoiskId().then(function (id) {
        if (!id) {
          fail('Не удалось определить kinopoisk ID');
          return;
        }

        load('Ищу источник…');

        return discoverToken(id).then(function (tok) {
          token = tok || DEFAULT_TOKEN;

          load('Загружаю данные…');

          return loadMeta(token, id).then(function (meta) {
            if (!meta) {
              fail('Alloha недоступен для этого фильма');
              return;
            }

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

            var duration = timeToSeconds(meta.time);
            voices.forEach(function (item) {
              item.duration = duration;
              item.poster = meta.poster || null;
            });

            loadDone();
            renderItems(voices);
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
      timeToSeconds: timeToSeconds
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
