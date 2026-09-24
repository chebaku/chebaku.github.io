// Turbo (obrut.show) — отдельный плагин для Lampa.
// Цепочка: kinopoisk id -> p.linkpp.ink/api/players -> Turbo iframeUrl ->
// embed html -> new Player("<token>") -> zkSSaiBn-декодер -> cfg.file (дорожки) ->
// прямые HLS-ссылки (302 -> superdupercdn). Полное описание: TURBO.md
(function () {
  'use strict';

  if (window.turbo_plugin) return;

  var API_PLAYERS = 'https://p.linkpp.ink/api/players?kinopoisk=';
  var EXTERNALIDS_URL = 'https://akter-black.com/externalids';
  var PROXIES = [
    'https://proxy4.rte.net.ru/',
    'https://proxy5.rte.net.ru/',
    'https://proxy6.rte.net.ru/',
    'https://proxy7.rte.net.ru/'
  ];
  var TIMEOUT = 15000;

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
    try { console.log('TURBO-DIAG', msg); } catch (e) {}
    try { Lampa.Noty.show('TURBO: ' + msg); } catch (e) {}
  }

  function isProxy(url) {
    return PROXIES.some(function (base) { return url.indexOf(base) === 0; });
  }

  function fetchOne(url, dataType, headers) {
    return new Promise(function (resolve) {
      var network = new Lampa.Reguest();
      network.timeout(TIMEOUT);
      network.silent(url, function (data) {
        resolve(data);
      }, function () {
        resolve(null);
      }, false, {
        dataType: dataType || 'text',
        headers: headers || {}
      });
    });
  }

  // Прямой запрос, при неудаче — через CORS-прокси (как в balumba.js).
  function req(url, dataType, headers) {
    var order = [url];

    if (!Lampa.Platform.is('android')) {
      var proxied = PROXIES.map(function (base) { return base + url; });
      order = preferProxy ? proxied.concat([url]) : [url].concat(proxied);
    }

    return order.reduce(function (chain, candidate) {
      return chain.then(function (result) {
        if (result) return result;
        return fetchOne(candidate, dataType, headers).then(function (data) {
          if (data && isProxy(candidate)) preferProxy = true;
          return data;
        });
      });
    }, Promise.resolve(null));
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
    try { return new URL(url).origin + '/'; } catch (e) { return ''; }
  }

  // --- Декодер токена Turbo (порт tools/turbo_pure.js) --------------------

  var FILE3_SEPARATOR = '//';
  var SALTS = ['t/t/t', 'u/u/u', 'r/r/r', 'b/b/b', 'o/o/o']; // bk0..bk4

  function b1(str) { // utf8 -> base64
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (m, p1) {
      return String.fromCharCode('0x' + p1);
    }));
  }

  function b2(str) { // base64 -> utf8
    return decodeURIComponent(atob(str).split('').map(function (c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
  }

  function zkSSaiBn(x) {
    var a = x.substr(2);
    for (var i = SALTS.length - 1; i >= 0; i--) {
      a = a.replace(FILE3_SEPARATOR + b1(SALTS[i]), '');
    }
    return b2(a);
  }

  function tokenOf(html) {
    var match = String(html || '').match(/new Player\("([^"]+)"/);
    return match ? match[1] : null;
  }

  function decodeToken(token) {
    return JSON.parse(zkSSaiBn('#2' + token.substring(73)));
  }

  // "[240p]url,[360p]url,..." -> [{q, url}]
  function parseFile(file) {
    return String(file).split(/,(?=\[)/).map(function (part) {
      var end = part.indexOf(']');
      if (end < 0) return null;
      return { q: part.slice(1, end), url: part.slice(end + 1) };
    }).filter(Boolean);
  }

  // Субтитры дорожки в том же формате: "[Russian (1)]url,[English (2)]url".
  function parseSubs(subtitle) {
    return String(subtitle || '').split(/,(?=\[)/).map(function (part) {
      var end = part.indexOf(']');
      if (end < 0) return null;
      return { label: part.slice(1, end).trim(), url: part.slice(end + 1).trim() };
    }).filter(function (sub) { return sub && sub.url; }).map(function (sub, index) {
      sub.index = index;
      return sub;
    });
  }

  // Turbo отдаёт метку авто и как "Auto", и как "Авто" (кириллица).
  function isAutoLabel(label) {
    return /^(auto|авто)$/i.test(String(label || '').trim());
  }

  // Метки качества в конфиге — "240p"/"1080p"/"Auto", а не числа, поэтому
  // числовой ключ для меню Lampa достаём из метки, а Auto помечаем отдельно.
  function playableQualities(list) {
    return (list || []).map(function (entry) {
      var label = String(entry.q || '').trim();
      return {
        label: label,
        num: /^\d/.test(label) ? parseInt(label, 10) : 0,
        auto: isAutoLabel(label),
        url: entry.url || ''
      };
    }).filter(function (entry) { return !!entry.url; });
  }

  // Поток может прийти и «ортовым» HTML-ом без Playerjs-токена.
  function fallbackHls(html) {
    var match = String(html || '').match(/["']?hls["']?\s*:\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  }

  // obrut отдаёт 302 только при наличии заголовка Referer, а медиа-запрос
  // браузера (<video>/hls.js) его не шлёт и задать его медиа-элементу нельзя
  // — отсюда 404 при живом токене (см. TURBO.md §5). Поэтому резолвим редирект
  // сами: fetch с явным referrer проходит гейт и отдаёт конечный адрес
  // superdupercdn, который открыт (CORS *) и заголовков не требует. Если
  // редиректа не было (гейт не пройден) или fetch недоступен — null: тогда
  // играем исходный адрес, а на Android заголовки из element.headers доедут.
  // Резолв через XHR: на части TV-движков fetch урезан/недоступен, но XHR есть
  // и умеет отдать конечный URL после 302 через responseURL. Дополнительно
  // пробуем выставить Referer/User-Agent — на Tizen WebKit они иногда не
  // считаются запрещёнными и доходят до сервера (в обычном браузере молча
  // игнорируются), что и позволяет обойти Referer-гейт obrut с file://.
  function resolveViaXhr(url) {
    return new Promise(function (resolve) {
      if (typeof XMLHttpRequest !== 'function') { resolve(null); return; }

      var xhr;
      try { xhr = new XMLHttpRequest(); } catch (e) { resolve(null); return; }

      try {
        xhr.open('GET', url, true);
        try { xhr.setRequestHeader('Referer', 'https://linkpp.ink/'); } catch (e) {}
        try { xhr.setRequestHeader('User-Agent', UA); } catch (e) {}

        xhr.onload = function () {
          if (DIAG) diag('xhr ' + xhr.status + ' -> ' + hostOf(xhr.responseURL || url));
          resolve(xhr.responseURL && xhr.responseURL !== url ? xhr.responseURL : null);
        };
        xhr.onerror = function () {
          if (DIAG) diag('xhr error');
          resolve(null);
        };
        xhr.ontimeout = function () { resolve(null); };
        xhr.send();
      } catch (e) { resolve(null); }
    });
  }

  function resolveDirect(url) {
    if (!url) return Promise.resolve(null);

    var options = { redirect: 'follow', referrerPolicy: 'strict-origin-when-cross-origin' };
    try { options.referrer = location.href; } catch (e) {}

    function once() {
      if (typeof fetch !== 'function') return resolveViaXhr(url);

      return fetch(url, options).then(function (response) {
        if (response && response.body && typeof response.body.cancel === 'function') {
          try { response.body.cancel(); } catch (e) {}
        }
        if (!response || !response.url) return resolveViaXhr(url);
        // redirect: 'follow' выставляет redirected; если движок его не отдаёт —
        // считаем редиректом смену самого адреса.
        var shifted = response.redirected === true ||
          (response.redirected === undefined && response.url !== url);
        return shifted ? response.url : resolveViaXhr(url);
      })['catch'](function () {
        return resolveViaXhr(url);
      });
    }

    // Сетевой сбой fetch случается (замер: 1 провал из 4 на живом URL) и даёт
    // ровно исходный симптом — сырой obrut-адрес с 404 в вебе. Повторяем только
    // брошенную ошибку: «не было редиректа» — детерминированный отказ гейта.
    var left = 3;
    function attempt() {
      return once()['catch'](function () {
        if (left <= 1) return null;
        left--;
        return attempt();
      });
    }

    return attempt();
  }

  // --- Резолв через скрытый iframe на https-домене плагина ---------------
  // На Tizen приложение живёт на file://, поэтому fetch/XHR не шлют Referer и
  // obrut отвечает 404. Страница r.html на нашем GitHub Pages имеет настоящий
  // https-origin: её fetch уходит с валидным Referer, проходит гейт и отдаёт
  // конечный superdupercdn-адрес обратно через postMessage.
  var RESOLVER_URL = 'https://chebaku.github.io/r.html';
  var IFRAME_TIMEOUT = 15000;
  var iframeSeq = 0;

  function resolveViaIframe(urls) {
    return new Promise(function (resolve) {
      var list = urls || [];
      if (!list.length) { resolve([]); return; }
      if (typeof document === 'undefined' || !window || typeof window.addEventListener !== 'function') {
        resolve(list.map(function () { return null; }));
        return;
      }

      // Уникальный id: параллельные iframe-запросы не должны принимать чужие
      // ответы postMessage (иначе поток и субтитры перепутываются).
      var id = 'tu' + (++iframeSeq) + '_' + Date.now();

      var iframe = document.createElement('iframe');
      iframe.setAttribute('style', 'position:absolute;left:-9999px;width:1px;height:1px;border:0');
      var done = false;

      function finish(result) {
        if (done) return;
        done = true;
        try { window.removeEventListener('message', onMessage, false); } catch (e) {}
        try { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch (e) {}
        resolve(result || list.map(function () { return null; }));
      }

      function onMessage(e) {
        var d = e && e.data;
        if (!d || !d.tuResolve || d.id !== id) return;
        if (DIAG) diag('iframe ' + (d.urls ? d.urls.filter(Boolean).length : 0) + '/' + list.length);
        finish(d.urls || null);
      }

      try { window.addEventListener('message', onMessage, false); } catch (e) {}
      setTimeout(function () { if (DIAG) diag('iframe timeout'); finish(null); }, IFRAME_TIMEOUT);

      try {
        iframe.src = RESOLVER_URL + '#' + encodeURIComponent(JSON.stringify({ id: id, urls: list }));
        (document.body || document.documentElement).appendChild(iframe);
      } catch (e) { finish(null); }
    });
  }

  // Прямой резолв (быстрый, работает в вебе), а что не открылось — добираем
  // одним iframe-батчем (нужно на Tizen с его file://). С file:// прямой путь
  // заведомо не проходит (нет Referer), поэтому сразу идём через iframe.
  function resolveBatch(urls) {
    var list = urls || [];
    if (!list.length) return Promise.resolve([]);

    var isFile = false;
    try { isFile = location.protocol === 'file:'; } catch (e) {}

    var direct = isFile
      ? list.map(function () { return Promise.resolve(null); })
      : list.map(resolveDirect);

    return Promise.all(direct).then(function (results) {
      var missing = [];
      results.forEach(function (r, i) { if (!r) missing.push(i); });
      if (!missing.length) return results;

      return resolveViaIframe(missing.map(function (i) { return list[i]; })).then(function (extra) {
        var k = 0;
        missing.forEach(function (i) { results[i] = extra ? (extra[k++] || null) : null; });
        return results;
      });
    });
  }

  function resolveStream(url) {
    return resolveDirect(url);
  }

  // Меню качества Lampa переключает уже готовые адреса, поэтому резолвим все
  // числовые качества разом — нерезолвленных ссылок в карте быть не должно.
  function resolveQualities(entries) {
    return resolveBatch(entries.map(function (entry) { return entry.url; })).then(function (urls) {
      return entries.map(function (entry, i) {
        return { entry: entry, url: urls ? urls[i] : null };
      });
    });
  }

  // Auto плееру не нужен: цель — лучшее числовое качество, а выбор остального
  // отдаём меню качества Lampa. Auto берём только если числовых меток нет.
  function playbackTarget(list) {
    var entries = (list || []).filter(function (entry) { return !!entry.url; });
    if (!entries.length) return null;

    var numeric = entries.filter(function (entry) { return entry.num; })
      .sort(function (a, b) { return a.num - b.num; });

    return numeric.length ? numeric[numeric.length - 1] :
      (entries.filter(function (entry) { return entry.auto; })[0] || entries[0]);
  }

  function turboUrlFrom(json) {
    var list = (json && json.data) || [];
    var turbo = list.filter(function (p) { return p.type === 'Turbo'; })[0];
    if (!turbo) return null;
    return turbo.iframeUrl || (turbo.translations && turbo.translations[0] && turbo.translations[0].iframeUrl) || null;
  }

  function trackOf(track) {
    return {
      title: track.title || 'Дорожка',
      t1: track.t1 || '',
      poster: track.poster || null,
      duration: track.duration || 0,
      qualities: playableQualities(parseFile(track.file || '')),
      subtitles: parseSubs(track.subtitle),
      url: track.file || null
    };
  }

  // Фильм: cfg.file — плоский список дорожек озвучки.
  function tracksOf(cfg) {
    var list = cfg && cfg.file;
    if (!Array.isArray(list)) return [];

    return list.filter(function (track) {
      return track && !Array.isArray(track.folder);
    }).map(trackOf).filter(function (track) {
      return track.qualities.length;
    });
  }

  // Сериал: cfg.file — сезоны (folder) -> серии (folder) -> дорожки озвучки.
  function isSerial(cfg) {
    var list = cfg && cfg.file;
    return Array.isArray(list) && list.some(function (entry) {
      return entry && Array.isArray(entry.folder);
    });
  }

  function numberOf(text, fallback) {
    var match = String(text || '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : fallback;
  }

  // t1 дорожки: "S01E01 - The Name of the Game" -> метка серии + название.
  function parseEpisodeLabel(t1) {
    var match = String(t1 || '').match(/^\s*(S\d+E\d+)\s*[-–—:]\s*(.+?)\s*$/i);
    return match ? { label: match[1].toUpperCase(), name: match[2] } : null;
  }

  // Сериал: cfg.file — сезоны (folder) -> серии (folder) -> дорожки озвучки.
  // Собираем дерево и упорядоченную унию озвучек; список сезонов/серий потом
  // фильтруется по выбранной озвучке (см. TURBO.md §4.1).
  function serialModel(cfg) {
    var voices = [];
    var seasons = [];

    (cfg.file || []).forEach(function (season, seasonIndex) {
      if (!season || !Array.isArray(season.folder)) return;

      var seasonNumber = numberOf(season.title, seasonIndex + 1);
      var episodes = [];

      season.folder.forEach(function (episode, episodeIndex) {
        if (!episode || !Array.isArray(episode.folder)) return;

        var tracks = episode.folder.map(trackOf).filter(function (track) {
          return track.qualities.length;
        });

        if (!tracks.length) return;

        var number = numberOf(episode.title, episodeIndex + 1);
        var label = parseEpisodeLabel(tracks[0].t1);

        tracks.forEach(function (track) {
          track.season = seasonNumber;
          track.episode = number;
          if (voices.indexOf(track.title) === -1) voices.push(track.title);
        });

        episodes.push({
          season: seasonNumber,
          number: number,
          name: label ? label.name : ('Серия ' + number),
          sub: label ? label.label : ('S' + seasonNumber + ' E' + number),
          duration: tracks[0].duration,
          poster: tracks[0].poster,
          tracks: tracks
        });
      });

      if (episodes.length) {
        seasons.push({
          number: seasonNumber,
          title: 'Сезон ' + seasonNumber,
          episodes: episodes
        });
      }
    });

    return { voices: voices, seasons: seasons };
  }

  // --- Компонент ----------------------------------------------------------

  function Turbo(object) {
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var files = new Lampa.Explorer(object);
    var filter = new Lampa.Filter(object);
    var referer = '';
    var last = false;
    var initialized = false;
    var serial = null;
    var serialVoice = null;
    var serialSeason = null;

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
      scroll.body().empty().append('<div class="turbo-status">' + escapeHtml(html) + '</div>');
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
      return object.movie.title || object.movie.name || 'Turbo';
    }

    function posterUrl(path) {
      if (!path) return null;
      try { return Lampa.TMDB.image('t/p/w300' + path); } catch (e) { return null; }
    }

    function tmdbId() {
      var movie = object.movie || {};
      if (['cub', 'tmdb'].indexOf(movie.source || 'tmdb') === -1 && movie.tmdb_id) return movie.tmdb_id;
      return movie.id;
    }

    function movieArtwork() {
      var movie = object.movie || {};
      return movie.backdrop_path || movie.poster_path || null;
    }

    // obrut-снапшоты (track.poster) отдают 404 в вебе из-за Referer-гейта, а
    // медиа-элементу заголовок не задать, поэтому превью берём из TMDB — still
    // эпизода для серии и backdrop фильма (как в akter_ref). obrut-poster
    // остаётся fallback'ом, когда TMDB ничего не отдал.
    function seasonStills(season, stills) {
      return new Promise(function (resolve) {
        var id = tmdbId();
        if (!id || !Lampa.Api || !Lampa.Api.sources || !Lampa.Api.sources.tmdb) {
          resolve();
          return;
        }

        try {
          Lampa.Api.sources.tmdb.get('tv/' + id + '/season/' + season, {}, function (data) {
            var list = (data && data.episodes) || [];
            list.forEach(function (episode) {
              if (episode.still_path) stills[episode.episode_number] = episode.still_path;
            });
            resolve();
          }, function () { resolve(); });
        } catch (e) { resolve(); }
      });
    }

    function setArtwork(item, art) {
      if (!art) return;
      item.poster = art;
      (item.tracks || []).forEach(function (track) { track.poster = art; });
    }

    function applyPreviews(result) {
      var artwork = movieArtwork();

      if (!result.serial) {
        (result.items || []).forEach(function (item) { setArtwork(item, posterUrl(artwork)); });
        return Promise.resolve();
      }

      var model = result.model;
      var stills = {};

      var pending = model.seasons.map(function (season) {
        stills[season.number] = {};
        return seasonStills(season.number, stills[season.number]);
      });

      return Promise.all(pending).then(function () {
        model.seasons.forEach(function (season) {
          var seasonStillsMap = stills[season.number] || {};
          season.episodes.forEach(function (episode) {
            setArtwork(episode, posterUrl(seasonStillsMap[episode.number]) || posterUrl(artwork));
          });
        });
      });
    }

    function timeText(seconds) {
      if (!seconds) return '';
      try { return Lampa.Utils.secondsToTime(seconds, true); } catch (e) { return ''; }
    }

    function watchHash(suffix) {
      return Lampa.Utils.hash(movieTitle() + (suffix || ''));
    }

    function isViewed(hash) {
      return Lampa.Storage.cache('turbo_view', 5000, []).indexOf(hash) !== -1;
    }

    function markViewed(hash) {
      var viewed = Lampa.Storage.cache('turbo_view', 5000, []);
      if (viewed.indexOf(hash) === -1) {
        viewed.push(hash);
        Lampa.Storage.set('turbo_view', viewed);
      }
    }

    function makeCard(fields) {
      var html = $(
        '<div class="turbo-card selector">' +
          '<div class="turbo-card__img">' +
            (fields.poster ? '<img>' : '') +
            '<div class="turbo-card__loader"></div>' +
            (fields.sub ? '<div class="turbo-card__sub">' + escapeHtml(fields.sub) + '</div>' : '') +
            (fields.viewed ? '<div class="turbo-card__viewed">&#10003;</div>' : '') +
          '</div>' +
          '<div class="turbo-card__body">' +
            '<div class="turbo-card__head">' +
              '<div class="turbo-card__title">' + escapeHtml(fields.title) + '</div>' +
              (fields.time ? '<div class="turbo-card__time">' + escapeHtml(fields.time) + '</div>' : '') +
            '</div>' +
            (fields.timeline ? '<div class="turbo-card__timeline"></div>' : '') +
            (fields.info ? '<div class="turbo-card__info">' + escapeHtml(fields.info) + '</div>' : '') +
          '</div>' +
        '</div>'
      );

      var loader = html.find('.turbo-card__loader');

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
          html.find('.turbo-card__timeline').append(Lampa.Timeline.render(Lampa.Timeline.view(fields.timeline)));
        } catch (e) {}
      }

      html.on('hover:focus', function (e) {
        last = e.target;
        scroll.update($(e.target), true);
      });

      return html;
    }

    function focusFirst() {
      Lampa.Controller.collectionSet(scroll.render(), files.render());
      Lampa.Controller.collectionFocus(last || false, scroll.render());
      Lampa.Controller.toggle('content');
    }

    // Качества без Auto/Авто + отметка субтитров, если они есть у дорожки.
    function qualityList(track) {
      var labels = (track.qualities || []).filter(function (q) {
        return !q.auto && !isAutoLabel(q.label);
      }).map(function (q) { return q.label; });

      if (track.subtitles && track.subtitles.length) labels.push('Субтитры');

      return labels.join(' · ');
    }

    // Фильм: плоский список дорожек озвучки.
    function renderItems(list) {
      scroll.body().empty();
      last = false;

      list.forEach(function (item, index) {
        var hash = watchHash(':' + index);

        var card = makeCard({
          title: item.title,
          sub: item.sub || '',
          poster: item.poster || posterUrl(movieArtwork()),
          time: timeText(item.duration),
          timeline: hash,
          info: qualityList(item),
          viewed: isViewed(hash)
        });

        card.on('hover:enter', function () {
          markViewed(hash);
          playStream(item, hash);
        });

        scroll.append(card);
      });

      focusFirst();
    }

    // --- Сериал: дерево фильтруется выбранной озвучкой ----------------------

    function episodeTrack(episode, voice) {
      return episode.tracks.filter(function (track) { return track.title === voice; })[0] || null;
    }

    function seasonsForVoice(model, voice) {
      return model.seasons.filter(function (season) {
        return season.episodes.some(function (episode) { return episodeTrack(episode, voice); });
      });
    }

    function episodesForVoice(season, voice) {
      return season.episodes.filter(function (episode) { return episodeTrack(episode, voice); });
    }

    function getSerialChoice() {
      var all = Lampa.Storage.cache('turbo_serial_choice', 5000, {});
      return all[object.movie.id] || null;
    }

    function saveSerialChoice() {
      var all = Lampa.Storage.cache('turbo_serial_choice', 5000, {});
      all[object.movie.id] = { voice: serialVoice, season: serialSeason };
      Lampa.Storage.set('turbo_serial_choice', all);
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
            return { title: season.title, selected: season.number === serialSeason, index: index };
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
          track: episodeTrack(episode, serialVoice),
          hash: watchHash(':' + episode.season + ':' + episode.number),
          sub: episode.sub,
          name: episode.name,
          season: episode.season,
          episode: episode.number,
          poster: episode.poster,
          duration: episode.duration
        };
      });

      episodeList.forEach(function (episode) {
        var track = episodeTrack(episode, serialVoice);
        var hash = watchHash(':' + episode.season + ':' + episode.number);

        var card = makeCard({
          title: episode.name,
          sub: episode.sub,
          poster: episode.poster || posterUrl(movieArtwork()),
          time: timeText(episode.duration),
          timeline: hash,
          info: qualityList(track),
          viewed: isViewed(hash)
        });

        card.on('hover:enter', function () {
          markViewed(hash);
          playStream(track, hash, { playlist: playlist });
        });

        scroll.append(card);
      });

      focusFirst();
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

      // Lampa.Select.close() сам контроллер не возвращает — зовёт onBack.
      // Без этого после закрытия фильтра контроллер остаётся 'select' и пульт
      // залипает; akter_ref по той же причине задаёт filter.onBack.
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

        // Lampa.Filter сразу после onSelect синхронно переоткрывает групповой
        // селект и держит контроллер 'select'. Поэтому закрываем селект и
        // перерисовываем список ПОСЛЕ него — иначе пульт/стрелки залипают на
        // фильтре (мышь работает мимо контроллера).
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

    // Резолв субтитров дорожки: обрубовские .srt за тем же Referer-гейтом,
    // поэтому отдаём конечный superdupercdn-адрес (открыт, CORS *).
    function resolveSubs(item) {
      var subs = (item.subtitles || []).filter(function (sub) { return sub.url; });
      if (!subs.length) return Promise.resolve([]);

      return resolveBatch(subs.map(function (sub) { return sub.url; })).then(function (urls) {
        return subs.map(function (sub, i) {
          return { label: sub.label, url: (urls && urls[i]) || sub.url, index: sub.index };
        });
      });
    }

    function applyStream(target, stream) {
      target.url = stream.url;
      target.headers = stream.headers;
      if (Object.keys(stream.quality).length) target.quality = stream.quality;
      if (stream.subtitles.length) target.subtitles = stream.subtitles;
    }

    // Резолв потока дорожки -> { url, quality, headers, subtitles } либо null.
    // Качества и субтитры резолвим ОДНИМ батчем (один iframe на Tizen).
    function buildStream(item, callback) {
      var all = (item.qualities || []).filter(function (entry) { return !!entry.url; });
      var target = playbackTarget(all);

      if (!target) { callback(null); return; }

      var numeric = all.filter(function (entry) { return entry.num; });
      var qualityEntries = numeric.length ? numeric : [target];
      var subs = (item.subtitles || []).filter(function (sub) { return sub.url; });

      var urls = qualityEntries.map(function (entry) { return entry.url; })
        .concat(subs.map(function (sub) { return sub.url; }));

      resolveBatch(urls).then(function (resolved) {
        resolved = resolved || [];

        var pairs = qualityEntries.map(function (entry, i) {
          return { entry: entry, url: resolved[i] || null };
        });

        // Меню качества строит числовые ключи (метки приходят как "240p").
        var qualities = {};
        var playUrl = null;

        pairs.forEach(function (pair) {
          if (!pair.url) return;
          if (pair.entry.num) qualities[pair.entry.num] = pair.url;
          if (pair.entry === target) playUrl = pair.url;
        });

        // Целевое качество не резолвнулось: лучше играть то, что реально
        // открылось (любое числовое), чем сырой obrut-адрес — в вебе он 404.
        // Сырой адрес остаётся последним рубежом для нативного плеера.
        if (!playUrl) {
          var opened = pairs.filter(function (pair) {
            return !!pair.url && pair.entry.num;
          }).sort(function (a, b) { return b.entry.num - a.entry.num; })[0];
          if (opened) playUrl = opened.url;
        }
        if (!playUrl) playUrl = target.url;
        if (!playUrl) { callback(null); return; }

        var subtitles = subs.map(function (sub, i) {
          var url = resolved[qualityEntries.length + i];
          return { label: sub.label, url: url || sub.url, index: sub.index };
        });

        if (DIAG) {
          var okN = resolved.filter(Boolean).length;
          diag('resolve ' + okN + '/' + qualityEntries.length +
            ' | host=' + hostOf(playUrl) +
            (playUrl.indexOf('obrut.show') !== -1 ? ' [RAW OBRUT -> 404]' : ' [ok]'));
        }

        callback({
          url: playUrl,
          quality: qualities,
          // Нативный плеер (Android) умеет заголовки; браузер их игнорирует,
          // поэтому в вебе опираемся на уже разрешённый адрес без гейта.
          headers: { Referer: referer || originOf(target.url), 'User-Agent': UA },
          subtitles: subtitles
        });
      });
    }

    // Нативный плейлист плеера: серии текущего сезона в выбранной озвучке.
    // URL соседних серий резолвятся лениво — когда плеер на них переключается.
    function buildPlaylist(entries, currentItem, currentStream) {
      return entries.map(function (entry) {
        var cell = {
          title: entry.sub + (entry.name ? ' · ' + entry.name : ''),
          season: entry.season,
          episode: entry.episode,
          timeline: Lampa.Timeline.view(entry.hash),
          thumbnail: entry.poster || null
        };

        if (entry.track === currentItem) {
          applyStream(cell, currentStream);
        } else {
          cell.url = function (call) {
            buildStream(entry.track, function (stream) {
              if (stream && stream.url) {
                applyStream(cell, stream);
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

    function playStream(item, hash, options) {
      options = options || {};

      buildStream(item, function (stream) {
        if (!stream) {
          Lampa.Noty.show('Нет ссылки на поток');
          return;
        }

        var element = {
          title: movieTitle() +
            (item.season ? ' S' + item.season + 'E' + item.episode : '') +
            (item.title ? ' · ' + item.title : ''),
          url: stream.url,
          headers: stream.headers,
          timeline: Lampa.Timeline.view(hash),
          duration: item.duration,
          thumbnail: item.poster || null,
          isonline: true
        };

        if (item.season) element.season = item.season;
        if (item.episode) element.episode = item.episode;
        if (Object.keys(stream.quality).length) element.quality = stream.quality;
        if (stream.subtitles.length) element.subtitles = stream.subtitles;

        if (options.playlist && options.playlist.length > 1) {
          element.playlist = buildPlaylist(options.playlist, item, stream);
        }

        try {
          if (DIAG) diag('play host=' + hostOf(element.url) + ' q=' + Object.keys(stream.quality).length);
          Lampa.Player.play(element);
          if (element.playlist) Lampa.Player.playlist(element.playlist);
          // Как во встроенном rezka.js: element.subtitles достаточно только на
          // событии ready, поэтому дублируем явным вызовом — так кнопка субтитров
          // появляется надёжно (в т.ч. когда ready уже проскочил).
          if (element.subtitles && typeof Lampa.Player.subtitles === 'function') {
            Lampa.Player.subtitles(element.subtitles);
          }
        } catch (e) {
          Lampa.Noty.show('Ошибка плеера: ' + (e && e.message ? e.message : 'unknown'));
        }
      });
    }

    function loadTracks(embedUrl) {
      referer = originOf(embedUrl);
      var headers = { 'User-Agent': UA, Referer: 'https://linkpp.ink/' };

      return req(embedUrl, 'text', headers).then(function (html) {
        if (!html) return null;

        var token = tokenOf(html);
        if (token) {
          var cfg = null;
          try { cfg = decodeToken(token); } catch (e) {}

          if (cfg) {
            if (isSerial(cfg)) {
              var model = serialModel(cfg);
              if (model.seasons.length) return { serial: true, model: model };
            } else {
              var tracks = tracksOf(cfg);
              if (tracks.length) return { serial: false, items: tracks };
            }
          }
        }

        var hls = fallbackHls(html);
        if (hls) {
          return {
            serial: false,
            items: [{
              title: 'Основной поток',
              poster: null,
              duration: object.movie.runtime ? object.movie.runtime * 60 : 0,
              qualities: playableQualities([{ q: 'Auto', url: hls }])
            }]
          };
        }

        return null;
      });
    }

    this.initialize = function () {
      this.loading(true);

      scroll.body().addClass('turbo-list');
      files.appendFiles(scroll.render());
      // Высоту скролла задаём всегда: без этого список растягивается по
      // контенту и не прокручивается (фильмы с большим числом дорожек).
      scroll.minus(files.render().find('.explorer__files-head'));

      Lampa.Controller.enable('content');
      this.loading(false);

      if (!object.movie) {
        status('Откройте карточку фильма и нажмите Turbo');
        return;
      }

      status('Поиск источника…');

      if (DIAG) {
        var plat = (Lampa.Platform && Lampa.Platform.is)
          ? ['tizen', 'webos', 'android', 'orsay', 'netcast'].filter(function (p) { return Lampa.Platform.is(p); }).join(',')
          : '?';
        diag('loc=' + locInfo() + ' fetch=' + (typeof fetch) + ' xhr=' + (typeof XMLHttpRequest) + ' plat=' + plat);
      }

      getKinopoiskId().then(function (id) {
        if (!id) {
          status('Не удалось определить kinopoisk ID');
          return;
        }

        return req(API_PLAYERS + id, 'text').then(function (data) {
          var embedUrl = turboUrlFrom(asObject(data));

          if (!embedUrl) {
            status('Turbo недоступен для этого фильма');
            return;
          }

          return loadTracks(embedUrl).then(function (result) {
            var empty = !result || (result.serial ? !result.model.seasons.length : !result.items.length);

            if (empty) {
              status(result && result.serial ? 'Серии не найдены' : 'Дорожки не найдены');
              return;
            }

            return applyPreviews(result).then(function () {
              if (result.serial) startSerial(result.model);
              else renderItems(result.items);
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
      if (files && typeof files.destroy === 'function') files.destroy();
      if (scroll && typeof scroll.destroy === 'function') scroll.destroy();
    };
  }

  function injectStyles() {
    if (document.getElementById('turbo-style')) return;
    var style = document.createElement('style');
    style.id = 'turbo-style';
    style.textContent = [
      '.turbo-status{padding:1.5em;color:rgba(255,255,255,.6)}',
      '.turbo-card{display:flex;align-items:center;gap:1em;padding:1em 1.2em;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.turbo-card.focus{background:rgba(255,255,255,.08)}',
      '.turbo-card__img{position:relative;flex:0 0 auto;width:8em;height:4.5em;border-radius:.4em;overflow:hidden;background:rgba(255,255,255,.06)}',
      '.turbo-card__img img{display:block;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .25s}',
      '.turbo-card__img img.loaded{opacity:1}',
      '.turbo-card__loader{position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.13),rgba(255,255,255,.05));background-size:200% 100%;animation:turbo-shimmer 1.2s infinite}',
      '@keyframes turbo-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '.turbo-card__sub{position:absolute;left:.3em;bottom:.3em;padding:.1em .45em;border-radius:.25em;background:rgba(0,0,0,.65);font-size:.8em;font-weight:600}',
      '.turbo-card__viewed{position:absolute;right:.3em;bottom:.3em;padding:.1em .45em;border-radius:.25em;background:rgba(20,200,212,.85);font-size:.8em;font-weight:600}',
      '.turbo-card__body{flex:1 1 auto;min-width:0}',
      '.turbo-card__head{display:flex;justify-content:space-between;gap:1em}',
      '.turbo-card__title{font-size:1.1em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.turbo-card__time{flex:0 0 auto;font-size:.9em;color:rgba(255,255,255,.5)}',
      '.turbo-card__timeline{margin-top:.6em}',
      '.turbo-card__info{margin-top:.5em;font-size:.9em;color:rgba(255,255,255,.5)}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function addButton(render, movie) {
    if (!render || !render.length) return;
    if (render.find('.turbo--button').length) return;

    var button = $(
      '<div class="full-start__button selector view--turbo turbo--button">' +
        '<svg viewBox="0 0 24 24" width="1.2em" height="1.2em" fill="currentColor">' +
          '<path d="M8 5v14l11-7z"></path>' +
        '</svg>' +
        '<span>Turbo</span>' +
      '</div>'
    );

    button.on('hover:enter', function () {
      Lampa.Activity.push({
        url: '',
        title: 'Turbo',
        component: 'turbo',
        movie: movie
      });
    });

    render.after(button);
  }

  function startPlugin() {
    if (window.lampa_settings && window.lampa_settings.read_only) return;

    window.turbo_plugin = true;

    injectStyles();
    Lampa.Component.add('turbo', Turbo);

    var manifest = {
      type: 'video',
      version: '1.0.0',
      name: 'Turbo',
      description: 'Онлайн-источник Turbo (obrut) по Kinopoisk ID',
      component: 'turbo',
      onContextMenu: function () {
        return { name: 'Смотреть (Turbo)', description: '' };
      },
      onContextLauch: function (movie) {
        Lampa.Activity.push({
          url: '',
          title: 'Turbo',
          component: 'turbo',
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

  if (window.turbo_test) {
    window.turbo_debug = {
      b1: b1,
      b2: b2,
      zkSSaiBn: zkSSaiBn,
      tokenOf: tokenOf,
      decodeToken: decodeToken,
      parseFile: parseFile,
      parseSubs: parseSubs,
      playableQualities: playableQualities,
      fallbackHls: fallbackHls,
      tracksOf: tracksOf,
      isSerial: isSerial,
      parseEpisodeLabel: parseEpisodeLabel,
      serialModel: serialModel,
      turboUrlFrom: turboUrlFrom,
      resolveStream: resolveStream,
      resolveQualities: resolveQualities,
      playbackTarget: playbackTarget
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
