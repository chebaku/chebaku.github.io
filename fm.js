// Filmix — плагин для Lampa (по образцу al.js).
// Цепочка: kinopoisk/tmdb карточка -> поиск в app-API Filmix (filmixapp.cyou) ->
// /api/v2/post/<id> -> player_links.movie (фильм) / player_links.playlist
// (сериал) -> прямая ссылка на CDN. Качества зашиты в ссылке: у фильма в скобке
// "..._[,,1080,720,480,].mp4", у серии — поле qualities + "%s.mp4". Референс
// (online_mod.js) капит их на 480 без pro-токена; здесь берём ВСЕ доступные.
// Ссылка подписана и живёт недолго, поэтому на воспроизведение пост
// перезапрашивается заново (свежая подпись).
(function () {
  'use strict';

  if (window.filmix_plugin) return;

  var API = 'http://filmixapp.cyou/api/v2/';
  var PROXIES = [
    'https://proxy4.rte.net.ru/',
    'https://proxy5.rte.net.ru/',
    'https://proxy6.rte.net.ru/',
    'https://proxy7.rte.net.ru/'
  ];
  var TIMEOUT = 15000;

  var API_UA = 'okhttp/3.10.0';
  var DEV_TOKEN = 'aaaabbbbccccddddeeeeffffaaaabbbb';

  var currentProxyIndex = 0;

  function randomHex(n) {
    var s = '';
    while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, n);
  }

  function storedToken() {
    try { return (Lampa.Storage.get('filmix_token', '') + '') || ''; } catch (e) { return ''; }
  }

  function apiToken() {
    var t = storedToken() || DEV_TOKEN;
    return '?user_dev_id=' + randomHex(16) +
      '&user_dev_name=Xiaomi' +
      '&user_dev_token=' + t +
      '&user_dev_vendor=Xiaomi' +
      '&user_dev_os=14' +
      '&user_dev_apk=2.2.0' +
      '&app_lang=ru-rRU';
  }

  // --- Прокси --------------------------------------------------------------

  function proxyUrl(base, url, params) {
    var pre = '';
    (params || []).forEach(function (p) {
      pre += 'param/' + p[0] + '=' + encodeURIComponent(p[1]) + '/';
    });
    return base + pre + url;
  }

  function isProxy(url) {
    return PROXIES.some(function (b) { return url.indexOf(b) === 0; });
  }

  function apiParams() {
    return [['User-Agent', API_UA]];
  }

  var API_HEADERS = { 'User-Agent': API_UA };

  function orderFor(url, params) {
    var p = params || apiParams();
    var list = [];
    for (var i = 0; i < PROXIES.length; i++) {
      list.push(PROXIES[(currentProxyIndex + i) % PROXIES.length]);
    }
    var proxied = list.map(function (base) { return proxyUrl(base, url, p); });
    // Браузеры (Tizen, WebOS, ПК) блокируют заголовок User-Agent в XHR и HTTP (Mixed Content).
    // Без okhttp/3.10.0 Filmix возвращает 200 OK с пустыми player_links.movie/playlist ([]).
    // Поэтому запросы к API Filmix на браузерных платформах ВСЕГДА идут через HTTPS-прокси.
    if (Lampa.Platform.is('android')) {
      return proxied.concat([url]);
    }
    return proxied;
  }

  function netOne(url, headers, post, dataType) {
    return new Promise(function (resolve) {
      var network = new Lampa.Reguest();
      network.timeout(TIMEOUT);
      network.silent(url, function (data) {
        resolve(data);
      }, function () {
        resolve(null);
      }, post ? post : false, {
        dataType: dataType || 'text',
        headers: headers || {}
      });
    });
  }

  function walk(order, headers, post) {
    return order.reduce(function (chain, candidate) {
      return chain.then(function (result) {
        if (result) return result;
        return netOne(candidate, headers, post).then(function (data) {
          if (!data) return null;
          var obj = asObject(data);
          if (obj) {
            // Троттлинг API Filmix или ошибка
            if (obj.message === null && !obj.id) return null;
            if (obj.error) return null;
            for (var p = 0; p < PROXIES.length; p++) {
              if (candidate.indexOf(PROXIES[p]) === 0) {
                currentProxyIndex = p;
                break;
              }
            }
            return obj;
          }
          return data;
        });
      });
    }, Promise.resolve(null));
  }

  function req(url, params, headers) {
    return walk(orderFor(url, params), headers || API_HEADERS, false);
  }

  function apiGet(path, extra) {
    var url = API + path + apiToken();
    if (extra) url += '&' + extra;
    return req(url, apiParams()).then(asObject);
  }

  function fixProto(url) {
    if (!url) return '';
    return String(url).replace(/^http:\/\//i, 'https://');
  }

  function proxMedia(url) {
    if (!url) return url;
    return fixProto(url);
  }

  // --- Утилиты -------------------------------------------------------------

  function asObject(data) {
    if (!data) return null;
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch (e) { return null; }
  }

  function log() {
    try { console.log.apply(console, ['FILMIX'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(text, fallback) {
    var m = String(text == null ? '' : text).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : fallback;
  }

  // "..._[,,1080,720,480,].mp4" -> [1080,720,480]
  function bracketQualities(link) {
    var m = String(link || '').match(/\[([\d,]*)\]\.mp4/i);
    if (!m) return [];
    return m[1].split(',')
      .map(function (x) { return parseInt(x, 10); })
      .filter(function (n) { return n > 0; })
      .sort(function (a, b) { return b - a; });
  }

  // "...[1080,720,480].mp4" -> "...%s.mp4"
  function fileTmpl(link) {
    var s = String(link || '');
    if (s.indexOf('%s') !== -1) return s;
    return s.replace(/\[[\d,]*\]\.mp4/i, '%s.mp4');
  }

  // Filmix CDN отдаёт реальные 2K (1440p) и 4K (2160p) без кэпа и 10-секундных промо-заглушек
  // через HLS: https://<host>/hls/<path>/index.m3u8?hash=<hash>
  function buildHlsUrl(link, q) {
    var m = String(link || '').match(/^(https?:\/\/[^\/]+)\/s\/([^\/]+)\/(.*)/);
    if (!m) return null;
    var host = fixProto(m[1]);
    var hash = m[2];
    var rest = m[3].replace(/\?.*$/, '');
    var path = rest.replace(/\[[\d,]*\]\.mp4/i, q + '.mp4').replace(/%s\.mp4/i, q + '.mp4');
    return host + '/hls/' + path + '/index.m3u8?hash=' + hash;
  }

  function buildQualityUrl(link, q) {
    var hls = buildHlsUrl(link, q);
    if (hls) return hls;
    return fixProto(fileTmpl(link).replace('%s', q));
  }

  function qualitiesOf(file) {
    var q = (file && file.qualities ? file.qualities : []).map(function (x) { return parseInt(x, 10); })
      .filter(function (n) { return n > 0; });
    if (!q.length) q = bracketQualities(file && file.link);
    return q.sort(function (a, b) { return b - a; });
  }

  function qualityText(list) {
    return (list || []).map(function (n) { return n + 'p'; }).join(' / ');
  }

  function defaultQuality(list) {
    if (!list || !list.length) return null;
    var pref = 1080;
    try { pref = parseInt(Lampa.Storage.get('video_quality_default', '1080'), 10) || 1080; } catch (e) {}
    var matched = list.filter(function (n) { return n <= pref; }).sort(function (a, b) { return a - b; });
    if (matched.length) return matched[matched.length - 1];
    return list[0];
  }

  // player_links -> модель { movies: [...] } либо { seasons: [...] }.
  function buildModel(post) {
    var pl = (post && post.player_links) || {};

    var movieObj = pl.movie || {};
    var movieKeys = Object.keys(movieObj);
    if (movieKeys.length) {
      var movies = [];
      movieKeys.forEach(function (k) {
        var f = movieObj[k] || {};
        var q = qualitiesOf(f);
        if (!q.length) return;
        movies.push({
          key: k,
          translation: f.translation || ('Озвучка ' + (movies.length + 1)),
          qualities: q,
          blocked: /Заблокировано правообладателем/i.test(f.translation || '')
        });
      });
      if (movies.length) {
        // Заблокированные правообладателем — в конец списка.
        movies.sort(function (a, b) { return (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0); });
        return { movies: movies };
      }
    }

    var playlist = pl.playlist || {};
    var seasonKeys = Object.keys(playlist);
    if (seasonKeys.length) {
      var seasons = [];
      seasonKeys.forEach(function (sid, si) {
        var seasonObj = playlist[sid] || {};
        var sNum = num(sid, si + 1);
        var voiceKeys = Object.keys(seasonObj);
        var voices = [];

        voiceKeys.forEach(function (vname) {
          var epsObj = seasonObj[vname] || {};
          var eps = [];
          Object.keys(epsObj).forEach(function (eid, ei) {
            var file = epsObj[eid] || {};
            var q = qualitiesOf(file);
            if (!q.length) return;
            eps.push({ id: eid, number: num(eid, ei + 1), qualities: q });
          });
          if (eps.length) voices.push({ id: vname, name: vname, episodes: eps });
        });

        if (voices.length) seasons.push({ id: sid, number: sNum, voices: voices });
      });
      if (seasons.length) return { seasons: seasons };
    }

    return null;
  }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
  }

  function cleanTitle(s) {
    return String(s || '').replace(/[\s.,:;’'`!?+\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function timeText(seconds) {
    if (!seconds) return '';
    try { return Lampa.Utils.secondsToTime(seconds, true); } catch (e) { return ''; }
  }

  // "01:30" (H:MM) -> секунды
  function durationSeconds(text) {
    var parts = String(text || '').split(':').map(function (p) { return parseInt(p, 10) || 0; });
    if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  // --- Компонент -----------------------------------------------------------

  function Filmix(object) {
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var files = new Lampa.Explorer(object);
    var filter = new Lampa.Filter(object);
    var last = false;
    var initialized = false;

    var postId = null;
    var movieVoices = null;
    var serial = null;
    var serialVoice = null;
    var serialSeason = null;

    this.create = function () { return this.render(); };
    this.render = function () { return files.render(); };
    this.back = function () { Lampa.Activity.backward(); };

    this.loading = function (status) {
      if (status) this.activity.loader(true);
      else { this.activity.loader(false); this.activity.toggle(); }
    };

    function status(html) {
      scroll.body().empty().append('<div class="filmix-status">' + escapeHtml(html) + '</div>');
    }

    function movieTitle() {
      return object.movie.title || object.movie.name || 'Filmix';
    }

    function posterUrl() {
      var movie = object.movie || {};
      var path = movie.backdrop_path || movie.poster_path;
      if (!path) return null;
      try { return Lampa.TMDB.image('t/p/w300' + path); } catch (e) { return null; }
    }

    // --- Таймлайн (как в tu.js/al.js) ---

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
      primary.handler = function (percent, time, dur) {
        base(percent, time, dur);
        alt.handler(percent, time, dur);
      };
      return primary;
    }

    function markWatch(item) {
      var movie = object.movie || {};
      if (movie.id) {
        try { if (Lampa.Favorite && Lampa.Favorite.add) Lampa.Favorite.add('history', movie, 100); } catch (e) {}
      }
    }

    // --- Карточки ---

    function makeCard(fields) {
      var html = $(
        '<div class="filmix-card selector">' +
          '<div class="filmix-card__img">' +
            (fields.poster ? '<img>' : '') +
            '<div class="filmix-card__loader"></div>' +
            '<div class="filmix-card__sub' + (fields.sub ? '' : ' hide') + '">' + escapeHtml(fields.sub || '') + '</div>' +
          '</div>' +
          '<div class="filmix-card__body">' +
            '<div class="filmix-card__head">' +
              '<div class="filmix-card__title">' + escapeHtml(fields.title) + '</div>' +
              '<div class="filmix-card__time' + (fields.time ? '' : ' hide') + '">' + escapeHtml(fields.time || '') + '</div>' +
            '</div>' +
            (fields.timeline ? '<div class="filmix-card__timeline"></div>' : '') +
            '<div class="filmix-card__info">' + escapeHtml(fields.info || '') + '</div>' +
          '</div>' +
        '</div>'
      );

      var loader = html.find('.filmix-card__loader');

      if (fields.poster) {
        var img = html.find('img')[0];
        img.onload = function () { $(img).addClass('loaded'); loader.remove(); };
        img.onerror = function () { img.src = './img/img_broken.svg'; };
        img.src = fields.poster;
      } else {
        loader.remove();
      }

      if (fields.timeline) {
        try {
          var tl = typeof fields.timeline === 'object' ? fields.timeline : Lampa.Timeline.view(fields.timeline);
          html.find('.filmix-card__timeline').append(Lampa.Timeline.render(tl).removeClass('hide'));
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

    // --- Воспроизведение ---

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

    function buildElement(file, opts) {
      var qualities = qualitiesOf(file);
      if (!qualities.length) return null;

      var best = defaultQuality(qualities);
      var qmap = {};
      qualities.forEach(function (q) { qmap[q + 'p'] = proxMedia(buildQualityUrl(file.link, q)); });

      var element = {
        title: opts.title,
        url: proxMedia(buildQualityUrl(file.link, best)),
        quality: qmap,
        headers: { 'User-Agent': API_UA },
        timeline: opts.timeline,
        duration: opts.duration || 0,
        thumbnail: posterUrl(),
        isonline: true
      };

      if (opts.season) element.season = opts.season;
      if (opts.episode) element.episode = opts.episode;

      return element;
    }

    function play(element, item) {
      try {
        markWatch(item);
        Lampa.Player.play(element);
      } catch (e) {
        Lampa.Noty.show('Ошибка плеера: ' + (e && e.message ? e.message : 'unknown'));
      }
    }

    // --- Фильм ---

    function playMovie(item) {
      withLoader(function (stopLoad) {
        apiGet('post/' + postId).then(function (post) {
          stopLoad();
          var pl = (post && post.player_links && post.player_links.movie) || {};
          var file = pl[item.key];
          if (!file) { Lampa.Noty.show('Ссылка недоступна'); return; }

          var element = buildElement(file, { title: movieTitle() + ' · ' + item.translation, duration: durationSeconds(post.duration) });
          if (!element) { Lampa.Noty.show('Нет ссылки на поток'); return; }
          play(element, {});
        });
      });
    }

    function renderMovies(list) {
      scroll.body().empty();
      last = false;
      var hash = timelineHash();

      list.forEach(function (item) {
        var card = makeCard({
          title: item.translation,
          sub: item.qualities[0] ? item.qualities[0] + 'p' : '',
          poster: posterUrl(),
          time: '',
          timeline: hash,
          info: qualityText(item.qualities)
        });

        card.on('hover:enter', function () { playMovie(item); });
        scroll.append(card);
      });

      focusFirst();
    }

    // --- Сериал ---

    function seasonList() {
      return (serial && serial.seasons) || [];
    }
    function voicesOf(season) {
      return (season && season.voices) || [];
    }
    function voiceByIndex(season, idx) {
      return voicesOf(season)[idx] || null;
    }
    function episodesOf(voice) {
      return (voice && voice.episodes) || [];
    }

    function buildSerialFilter() {
      if (!serial) return;
      var seasons = seasonList();

      filter.set('filter', [
        {
          title: 'Сезон',
          subtitle: 'Сезон ' + serialSeason,
          stype: 'season',
          items: seasons.map(function (s, i) {
            return { title: 'Сезон ' + s.number, selected: s.number === serialSeason, index: i };
          })
        },
        {
          title: 'Озвучка',
          subtitle: serialVoice,
          stype: 'voice',
          items: voicesOf(currentSeason()).map(function (v, i) {
            return { title: v.name, selected: v.name === serialVoice, index: i };
          })
        }
      ]);

      filter.chosen('filter', ['Сезон: ' + serialSeason, 'Озвучка: ' + serialVoice]);
    }

    function currentSeason() {
      return seasonList().filter(function (s) { return s.number === serialSeason; })[0] || null;
    }
    function currentVoice() {
      var season = currentSeason();
      if (!season) return null;
      return voicesOf(season).filter(function (v) { return v.name === serialVoice; })[0]
        || voicesOf(season)[0] || null;
    }

    function renderSeason() {
      if (!serial) return;

      var season = currentSeason();
      var voice = currentVoice();
      if (!season || !voice) { status('Серии не найдены'); return; }

      scroll.body().empty();
      last = false;

      var episodes = episodesOf(voice);

      episodes.forEach(function (ep) {
        var hash = timelineHash(season.number, ep.number);
        var card = makeCard({
          title: 'Серия ' + ep.number,
          sub: 'S' + season.number + ' E' + ep.number,
          poster: posterUrl(),
          time: '',
          timeline: hash,
          info: ep.qualities[0] ? ep.qualities[0] + 'p' : ''
        });

        card.on('hover:enter', function () { playEpisode(season, voice, ep, hash); });
        scroll.append(card);
      });

      focusFirst();
    }

    function playEpisode(season, voice, ep, hash) {
      withLoader(function (stopLoad) {
        apiGet('post/' + postId).then(function (post) {
          stopLoad();
          var pl = (post && post.player_links && post.player_links.playlist) || {};
          var s = pl[season.id];
          var v = s && s[voice.id];
          var file = v && v[ep.id];
          if (!file) { Lampa.Noty.show('Ссылка недоступна'); return; }

          var element = buildElement(file, {
            title: movieTitle() + ' S' + season.number + 'E' + ep.number,
            timeline: timelineFor(season.number, ep.number),
            duration: durationSeconds(post.duration),
            season: season.number,
            episode: ep.number
          });
          if (!element) { Lampa.Noty.show('Нет ссылки на поток'); return; }
          play(element, { season: season.number, episode: ep.number });
        });
      });
    }

    function startSerial(model) {
      serial = model;

      var seasons = seasonList();
      serialSeason = seasons[0] ? seasons[0].number : null;

      var voice0 = serialSeason ? voicesOf(currentSeason())[0] : null;
      serialVoice = voice0 ? voice0.name : null;

      files.appendHead(filter.render());
      scroll.minus(files.render().find('.explorer__files-head'));
      filter.render().find('.filter--search').addClass('hide');
      filter.render().find('.filter--sort').addClass('hide');

      filter.onBack = function () { try { Lampa.Controller.toggle('content'); } catch (e) {} };

      filter.onSelect = function (type, a, b) {
        if (type !== 'filter' || !serial) return;

        if (a.stype === 'season') {
          serialSeason = seasonList()[b.index].number;
          var voices = voicesOf(currentSeason());
          if (!voices.some(function (v) { return v.name === serialVoice; })) {
            serialVoice = voices[0] ? voices[0].name : null;
          }
        } else if (a.stype === 'voice') {
          serialVoice = voicesOf(currentSeason())[b.index].name;
        }

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

    // Разбор post — buildModel на уровне модуля (см. ниже).

    function openPost(id, post) {
      postId = id;
      var pl = (post && post.player_links) || {};
      log('post', id, 'movie=', pl.movie ? Object.keys(pl.movie).length : 0,
        'playlist=', pl.playlist ? Object.keys(pl.playlist).length : 0);

      var model = buildModel(post);
      if (!model) return false;
      if (model.movies) { renderMovies(model.movies); return true; }
      startSerial(model);
      return true;
    }

    // Перебираем кандидатов, пока у кого-то не окажется дорожек.
    function loadPost(cards) {
      var i = 0;
      var gotAny = false;

      function next() {
        if (i >= cards.length) {
          status(gotAny ? 'Нет доступных дорожек' : 'Filmix API недоступен');
          return;
        }

        var id = cards[i++].id;
        withLoader(function (stopLoad) {
          apiGet('post/' + id).then(function (post) {
            stopLoad();
            if (post && post.id) gotAny = true;
            if (post && openPost(id, post)) return;
            next();
          });
        });
      }

      next();
    }

    // --- Поиск ---

    function scoreCard(card, titles, year) {
      var ct = [norm(card.title), norm(card.original_title)].filter(Boolean);
      var score = 0;

      titles.forEach(function (t) {
        var nt = norm(t);
        if (!nt) return;
        ct.forEach(function (c) {
          if (c === nt) score = Math.max(score, 3);
          else if (c.indexOf(nt) !== -1 || nt.indexOf(c) !== -1) score = Math.max(score, 2);
        });
      });

      var cy = parseInt(card.year, 10);
      if (year && cy) {
        var d = Math.abs(cy - year);
        if (d === 0) score += 1;
        else if (d <= 1) score += 0.5;
      }

      return score;
    }

    function pickAndLoad(list) {
      var movie = object.movie || {};
      var titles = [];
      if (movie.title) titles.push(movie.title);
      if (movie.name) titles.push(movie.name);
      if (movie.original_title) titles.push(movie.original_title);
      if (movie.original_name) titles.push(movie.original_name);
      if (object.search) titles.push(object.search);

      var date = movie.release_date || movie.first_air_date || movie.last_air_date || '';
      var year = parseInt(String(date).slice(0, 4), 10) || 0;

      var scored = list.map(function (c) { return { c: c, s: scoreCard(c, titles, year) }; });
      scored.sort(function (a, b) { return b.s - a.s; });

      log('search', titles.join(' | '), '->', list.length, 'best=', scored[0] && scored[0].c.title, scored[0] && scored[0].s);

      if (scored.length && scored[0].s >= 2 && (!scored[1] || scored[0].s > scored[1].s)) {
        loadPost([scored[0].c]);
        return;
      }

      var ordered = scored.map(function (x) { return x.c; });

      Lampa.Select.show({
        title: 'Filmix: выберите',
        items: ordered.slice(0, 20).map(function (c, i) {
          return { title: c.title + (c.year ? ' (' + c.year + ')' : ''), index: i };
        }),
        onSelect: function (a) { loadPost(ordered.slice(a.index).concat(ordered.slice(0, a.index))); },
        onBack: function () {}
      });
    }

    this.initialize = function () {
      this.loading(true);
      scroll.body().addClass('filmix-list');
      files.appendFiles(scroll.render());
      scroll.minus(files.render().find('.explorer__files-head'));
      Lampa.Controller.enable('content');
      this.loading(false);

      if (!object.movie) {
        status('Откройте карточку фильма и нажмите Filmix');
        return;
      }

      var load_on = true;
      var load_started = false;
      function loadDone() { load_on = false; try { Lampa.Loading.stop(); } catch (e) {} }
      function load(text) {
        if (!load_on) return;
        try {
          if (!load_started) {
            load_started = true;
            Lampa.Loading.start(function () { loadDone(); }, text || 'Поиск…');
          } else {
            Lampa.Loading.setText(text);
          }
        } catch (e) {}
      }

      var movie = object.movie || {};
      var qPrimary = object.search || movie.title || movie.name || '';
      var qClean = cleanTitle(qPrimary);
      var qAlt = movie.original_title || movie.original_name || '';

      var queryList = [];
      if (qPrimary) queryList.push(qPrimary);
      if (qClean && qClean !== qPrimary) queryList.push(qClean);
      if (qAlt && qAlt !== qPrimary && qAlt !== qClean) queryList.push(qAlt);

      load('Поиск…');

      function trySearch(idx) {
        if (idx >= queryList.length) {
          loadDone();
          status('Ничего не найдено');
          return;
        }
        var q = queryList[idx];
        apiGet('search', 'story=' + encodeURIComponent(q)).then(function (list) {
          if (list && list.length && list.forEach) {
            loadDone();
            pickAndLoad(list);
          } else {
            trySearch(idx + 1);
          }
        });
      }

      trySearch(0);
    };

    this.start = function () {
      if (Lampa.Activity.active().activity !== this.activity) return;
      if (!initialized) { initialized = true; this.initialize(); }

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
        down: function () { Navigator.move('down'); },
        back: this.back.bind(this)
      });

      Lampa.Controller.toggle('content');
    };

    this.pause = function () {};
    this.stop = function () {};
    this.destroy = function () {
      if (files && files.destroy) files.destroy();
      if (scroll && scroll.destroy) scroll.destroy();
    };
  }

  // --- Стили ---------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById('filmix-style')) return;
    var style = document.createElement('style');
    style.id = 'filmix-style';
    style.textContent = [
      '.filmix-status{padding:1.5em;color:rgba(255,255,255,.6)}',
      '.filmix-card{display:flex;align-items:center;gap:1em;padding:1em 1.2em;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.filmix-card.focus{background:rgba(255,255,255,.08)}',
      '.filmix-card__img{position:relative;flex:0 0 auto;width:8em;height:4.5em;border-radius:.4em;overflow:hidden;background:rgba(255,255,255,.06)}',
      '.filmix-card__img img{display:block;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .25s}',
      '.filmix-card__img img.loaded{opacity:1}',
      '.filmix-card__loader{position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.13),rgba(255,255,255,.05));background-size:200% 100%;animation:filmix-shimmer 1.2s infinite}',
      '@keyframes filmix-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '.filmix-card__sub{position:absolute;left:.3em;bottom:.3em;padding:.1em .45em;border-radius:.25em;background:rgba(0,0,0,.65);font-size:.8em;font-weight:600}',
      '.filmix-card__sub.hide{display:none}',
      '.filmix-card__time.hide{display:none}',
      '.filmix-card__body{flex:1 1 auto;min-width:0}',
      '.filmix-card__head{display:flex;justify-content:space-between;gap:1em}',
      '.filmix-card__title{font-size:1.1em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.filmix-card__time{flex:0 0 auto;font-size:.9em;color:rgba(255,255,255,.5)}',
      '.filmix-card__timeline{margin-top:.6em}',
      '.filmix-card__info{margin-top:.5em;font-size:.9em;color:rgba(255,255,255,.5)}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  // --- Кнопка и манифест ---------------------------------------------------

  function addButton(render, movie) {
    if (!render || !render.length) return;
    if (render.find('.filmix--button').length) return;

    var button = $(
      '<div class="full-start__button selector view--filmix filmix--button">' +
        '<svg viewBox="0 0 24 24" width="1.2em" height="1.2em" fill="currentColor">' +
          '<path d="M8 5v14l11-7z"></path>' +
        '</svg>' +
        '<span>Filmix</span>' +
      '</div>'
    );

    button.on('hover:enter', function () {
      Lampa.Activity.push({ url: '', title: 'Filmix', component: 'filmix', movie: movie });
    });

    render.after(button);
  }

  function startPlugin() {
    if (window.lampa_settings && window.lampa_settings.read_only) return;

    window.filmix_plugin = true;

    injectStyles();
    Lampa.Component.add('filmix', Filmix);

    Lampa.Manifest.plugins = {
      type: 'video',
      version: '1.0.0',
      name: 'Filmix',
      description: 'Онлайн-источник Filmix',
      component: 'filmix',
      onContextMenu: function () { return { name: 'Смотреть (Filmix)', description: '' }; },
      onContextLauch: function (movie) {
        Lampa.Activity.push({ url: '', title: 'Filmix', component: 'filmix', movie: movie });
      }
    };

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

  if (window.filmix_test) {
    window.filmix_debug = {
      bracketQualities: bracketQualities,
      fileTmpl: fileTmpl,
      buildHlsUrl: buildHlsUrl,
      buildQualityUrl: buildQualityUrl,
      qualitiesOf: qualitiesOf,
      buildModel: buildModel,
      defaultQuality: defaultQuality,
      norm: norm,
      durationSeconds: durationSeconds,
      apiToken: apiToken
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
