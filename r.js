(function () {
    'use strict';

    if (window.plugin_rutube_ready) return;
    window.plugin_rutube_ready = true;

    // ==========================================
    // Конфигурация и Прокси-кластер
    // ==========================================
    var PROXIES = [
        'https://proxy5.rte.net.ru/',
        'https://proxy7.rte.net.ru/',
        'https://proxy4.rte.net.ru/',
        'https://proxy6.rte.net.ru/'
    ];
    var current_proxy_index = 0;

    function getProxy() {
        return PROXIES[current_proxy_index];
    }

    function rotateProxy() {
        current_proxy_index = (current_proxy_index + 1) % PROXIES.length;
    }

    // ==========================================
    // Глобальный перехват запросов к Rutube CDN
    // ==========================================
    (function hookNetworkForRutube() {
        if (window.__rutube_net_hooked) return;
        window.__rutube_net_hooked = true;

        function shouldProxy(url) {
            if (typeof url !== 'string') return false;
            var is_rutube = (
                url.indexOf('rtbcdn.ru') !== -1 ||
                url.indexOf('rutube.ru') !== -1 ||
                url.indexOf('bl.rutube.ru') !== -1
            );
            var is_already_proxied = (
                url.indexOf('rte.net.ru') !== -1 ||
                url.indexOf('/http') !== -1
            );
            return is_rutube && !is_already_proxied;
        }

        var origXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
            if (shouldProxy(url)) {
                url = getProxy() + url;
            }
            return origXhrOpen.call(this, method, url, async !== false, user, password);
        };

        if (window.fetch) {
            var origFetch = window.fetch;
            window.fetch = function (input, init) {
                if (typeof input === 'string') {
                    if (shouldProxy(input)) {
                        input = getProxy() + input;
                    }
                } else if (input && input.url && typeof input.url === 'string') {
                    if (shouldProxy(input.url)) {
                        try {
                            input = new Request(getProxy() + input.url, input);
                        } catch (e) {}
                    }
                }
                return origFetch.apply(this, arguments);
            };
        }

        function hookHls() {
            if (window.Hls && Hls.DefaultConfig && !Hls.__rutube_loader_hooked) {
                Hls.__rutube_loader_hooked = true;
                var OrigLoader = Hls.DefaultConfig.loader;
                if (OrigLoader) {
                    function CustomHlsLoader(config) {
                        var loader = new OrigLoader(config);
                        var orig_load = loader.load.bind(loader);
                        loader.load = function (context, cfg, callbacks) {
                            if (context && context.url && shouldProxy(context.url)) {
                                context.url = getProxy() + context.url;
                            }
                            return orig_load(context, cfg, callbacks);
                        };
                        return loader;
                    }
                    CustomHlsLoader.prototype = OrigLoader.prototype;
                    Hls.DefaultConfig.loader = CustomHlsLoader;
                }
            }
        }
        hookHls();
        if (window.Lampa && Lampa.Listener) {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') hookHls();
            });
        }
    })();

    // ==========================================
    // Сетевой клиент (обход CORS)
    // ==========================================
    function apiRequest(url, options, callback, error_callback) {
        options = options || {};
        var attempts = 0;
        var max_attempts = PROXIES.length;

        function tryRequest() {
            var proxy_url = getProxy() + url;
            var is_post = options.method === 'POST';
            var headers = {
                'Accept': 'application/json, text/plain, */*'
            };

            if (is_post) {
                headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';
            }

            if (window.fetch) {
                var fetch_opts = {
                    method: options.method || 'GET',
                    headers: headers
                };
                if (is_post && options.body) {
                    fetch_opts.body = options.body;
                }

                var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                if (controller) {
                    fetch_opts.signal = controller.signal;
                    setTimeout(function () { controller.abort(); }, 12000);
                }

                fetch(proxy_url, fetch_opts)
                    .then(function (res) {
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        return res.json();
                    })
                    .then(function (data) {
                        callback(data);
                    })
                    .catch(function (err) {
                        attempts++;
                        rotateProxy();
                        if (attempts < max_attempts) {
                            tryRequest();
                        } else if (error_callback) {
                            error_callback(err);
                        }
                    });
            } else {
                var xhr = new XMLHttpRequest();
                xhr.open(options.method || 'GET', proxy_url, true);
                xhr.timeout = 12000;
                for (var h in headers) xhr.setRequestHeader(h, headers[h]);

                xhr.onload = function () {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            var json = JSON.parse(xhr.responseText);
                            callback(json);
                        } catch (e) {
                            attempts++;
                            rotateProxy();
                            if (attempts < max_attempts) tryRequest();
                            else if (error_callback) error_callback(e);
                        }
                    } else {
                        attempts++;
                        rotateProxy();
                        if (attempts < max_attempts) tryRequest();
                        else if (error_callback) error_callback(new Error('Status ' + xhr.status));
                    }
                };

                xhr.onerror = xhr.ontimeout = function () {
                    attempts++;
                    rotateProxy();
                    if (attempts < max_attempts) tryRequest();
                    else if (error_callback) error_callback(new Error('Network error'));
                };

                xhr.send(options.body || null);
            }
        }

        tryRequest();
    }

    // ==========================================
    // Утилиты и Анализаторы (Regex & Voices)
    // ==========================================
    var KNOWN_VOICES = [
        { name: 'HDRezka', reg: /hdrezka|резка/i },
        { name: 'LostFilm', reg: /lostfilm|лостфильм/i },
        { name: 'Red Head Sound', reg: /red\s*head\s*sound|rhs|ред\s*хед\s*саунд/i },
        { name: 'Кубик в Кубе', reg: /кубик\s*в\s*кубе|kubik/i },
        { name: 'Amedia', reg: /amedia|амедиа/i },
        { name: 'NewStudio', reg: /newstudio|ньюстудио/i },
        { name: 'AlexFilm', reg: /alexfilm|алексфильм/i },
        { name: 'TVShows', reg: /tvshows/i },
        { name: 'Пифагор', reg: /пифагор|pythagor/i },
        { name: 'Jaskier', reg: /jaskier|яскьер/i },
        { name: 'AniLibria', reg: /anilibria|анилибрия/i },
        { name: 'Дубляж', reg: /дубляж|дублирован/i },
        { name: 'Субтитры', reg: /субтитр|subtitles/i }
    ];

    var NOISE_REG = /трейлер|trailer|тизер|teaser|клип|обзор|прохождение|telltale|стрим|клим жуков|саундтрек|ost/i;
    var IRRELEVANT_CATEGORIES = /^(?:спорт|видеоигры|игры|новости и сми|новости|религия|авто-мото|авто|еда|кулинария|строительство|обучение)$/i;

    function isIrrelevantCategory(v) {
        if (v && v.category && v.category.name) {
            return IRRELEVANT_CATEGORIES.test(v.category.name.trim());
        }
        return false;
    }

    function cleanTitle(str) {
        if (!str) return '';
        return str
            .replace(/[.,:;!?&%$#@*()\[\]{}"'\\/`~^_+=|—–-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getWordStem(word) {
        if (!word) return '';
        if (word.length <= 3) return word;
        return word.replace(/(?:ами|ями|ого|его|ому|ему|ыми|ими|ую|юю|ое|ее|ие|ые|ов|ев|ей|ам|ям|ом|ем|ах|ях|ть|ти|ла|ло|ли|ет|ут|ют|ит|ат|ят|ся|сь|ки|ок|ка|ке|ку|ой|ей|ия|ии|ию|ий|ый|а|я|у|ю|о|е|ы|и|s|es|ed|ing)$/i, '');
    }

    function matchTitleText(videoTitle, targetTitle, targetOrigTitle) {
        if (!videoTitle) return false;
        var vClean = cleanTitle(videoTitle).toLowerCase();
        var vWords = vClean.split(' ').filter(Boolean);
        var vStems = vWords.map(getWordStem);

        function matchTarget(t) {
            if (!t) return false;
            var tClean = cleanTitle(t).toLowerCase();
            var tWords = tClean.split(' ').filter(Boolean);
            if (tWords.length === 0) return false;

            var textWords = tWords.filter(function (w) {
                return !/^\d+$/.test(w) && !/^(?:в|на|с|и|к|о|по|из|за|the|a|an|of|in|on|at|to|for)$/i.test(w);
            });
            var numWords = tWords.filter(function (w) { return /^\d+$/.test(w); });

            if (textWords.length === 0) {
                return numWords.every(function (n) { return vWords.indexOf(n) !== -1; });
            }

            var matchedTextCount = textWords.filter(function (w) {
                var stem = getWordStem(w);
                if (stem.length <= 2) return vWords.indexOf(w) !== -1;
                return vStems.some(function (vs) { return vs.indexOf(stem) !== -1 || stem.indexOf(vs) !== -1; }) ||
                       vWords.some(function (vw) { return vw.indexOf(stem) !== -1 || stem.indexOf(vw) !== -1; });
            }).length;

            if (textWords.length === 1) {
                if (matchedTextCount !== 1) return false;
                if (numWords.length > 0 && !numWords.some(function (n) { return vWords.indexOf(n) !== -1; })) return false;
                return true;
            }

            var ratio = matchedTextCount / textWords.length;
            if (ratio < 0.6) return false;

            if (numWords.length > 0) {
                var targetNum = numWords[0];
                var videoNums = vWords.filter(function (w) { return /^\d+$/.test(w) && w.length <= 2; });
                if (videoNums.length > 0 && videoNums.indexOf(targetNum) === -1) {
                    return false;
                }
            }

            return true;
        }

        return matchTarget(targetTitle) || matchTarget(targetOrigTitle);
    }

    function isMovieRelevant(videoTitle, targetTitle, targetOrigTitle) {
        if (!videoTitle) return false;
        if (NOISE_REG.test(videoTitle)) return false;
        if (/(?:сезон|серия|серий|эпизод|season|episode|s\d+e\d+)/i.test(videoTitle)) return false;
        return matchTitleText(videoTitle, targetTitle, targetOrigTitle);
    }

    function isSerialRelevant(videoTitle, targetTitle, targetOrigTitle) {
        if (!videoTitle) return false;
        if (NOISE_REG.test(videoTitle)) return false;
        return matchTitleText(videoTitle, targetTitle, targetOrigTitle);
    }

    function isCompilationVideo(title) {
        if (!title) return false;
        return /(?:все\s*сери[ий]|весь\s*сезон|полный\s*сезон|сери[ии]\s*\d+\s*[-—–]\s*\d+|1\s*[-—–]\s*\d+\s*сери[ий])/i.test(title);
    }

    function parseEpisodeNum(title, season_target) {
        if (!title) return null;

        var m = title.match(/s0?(\d+)[ex]0?(\d+)/i);
        if (m) {
            var s = parseInt(m[1], 10);
            var e = parseInt(m[2], 10);
            if (!season_target || s === season_target) return e;
        }

        m = title.match(/(?:(\d+)\s*(?:сезон|season|s)).+?(?:(\d+)\s*(?:серия|эпизод|ep|e))/i);
        if (m) {
            var s = parseInt(m[1], 10);
            var e = parseInt(m[2], 10);
            if (!season_target || s === season_target) return e;
        }

        m = title.match(/(?:(\d+)\s*(?:серия|эпизод|ep|e)).+?(?:(\d+)\s*(?:сезон|season|s))/i);
        if (m) {
            var e = parseInt(m[1], 10);
            var s = parseInt(m[2], 10);
            if (!season_target || s === season_target) return e;
        }

        m = title.match(/(?:^|[^\d])(\d+)\s*(?:серия|эпизод|ep|e)(?:[^\d]|$)/i);
        if (m) return parseInt(m[1], 10);

        m = title.match(/(?:^|[^\d])(?:серия|эпизод|ep|e)\s*(\d+)/i);
        if (m) return parseInt(m[1], 10);

        return null;
    }

    function detectVoice(text) {
        if (!text) return null;
        for (var i = 0; i < KNOWN_VOICES.length; i++) {
            if (KNOWN_VOICES[i].reg.test(text)) return KNOWN_VOICES[i].name;
        }
        return null;
    }

    function detectRutubeQuality(v) {
        if (!v) return '1080p';
        var text = (v.title || '') + ' ' + (v.description || '');
        var is_hdr = /\b(?:hdr10\+|hdr10|hdr|hlg|dolby\s*vision|dovi|dv)\b/i.test(text);

        if (/\b(?:8k|4320p|4320)\b/i.test(text)) return is_hdr ? '8K HDR' : '8K';
        if (/\b(?:4k|uhd|2160p|2160)\b/i.test(text)) return is_hdr ? '4K HDR' : '4K';
        if (/\b(?:2k|qhd|1440p|1440)\b/i.test(text)) return is_hdr ? '2K HDR' : '2K';
        if (/\b(?:1080p|1080|fhd|full\s*hd)\b/i.test(text)) return is_hdr ? '1080p HDR' : '1080p';
        if (/\b(?:720p|hd\s*720|720)\b/i.test(text) && !/\b(?:1080|fhd|full\s*hd|4k|2k|uhd|8k)\b/i.test(text)) return is_hdr ? '720p HDR' : '720p';
        if (/\b(?:480p|sd|480)\b/i.test(text) && !/\b(?:720|1080|fhd|full\s*hd|4k|2k|uhd|8k)\b/i.test(text)) return '480p';
        if (/\b(?:360p|360)\b/i.test(text) && !/\b(?:480|720|1080|fhd|full\s*hd|4k|2k|uhd|8k)\b/i.test(text)) return '360p';
        return is_hdr ? '1080p HDR' : '1080p';
    }

    function formatTime(sec) {
        if (!sec) return '';
        var m = Math.floor(sec / 60);
        var h = Math.floor(m / 60);
        m = m % 60;
        if (h > 0) return h + ' ч ' + (m < 10 ? '0' : '') + m + ' мин';
        return m + ' мин';
    }

    function fixPlayerCrossOrigin() {
        var video = (Lampa.PlayerVideo && Lampa.PlayerVideo.video && Lampa.PlayerVideo.video()) ||
                    document.querySelector('video.player-video__video, video');
        if (video) {
            try {
                video.removeAttribute('crossorigin');
            } catch (e) {}
        }
    }

    // ==========================================
    // Шаблоны карточек Lampa
    // ==========================================
    var templates_inited = false;
    function initTemplates() {
        if (templates_inited) return;
        templates_inited = true;

        var style = $(`
            <style>
                .rutube-view {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    position: relative;
                    overflow: hidden;
                }
                .rutube-header {
                    flex-shrink: 0;
                    padding: 0.6em 1em;
                    background: rgba(18, 18, 18, 0.96);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    z-index: 10;
                    display: flex;
                    align-items: center;
                    gap: 0.6em;
                    flex-wrap: wrap;
                }
                .rutube-body {
                    flex: 1 1 auto;
                    height: 100%;
                    position: relative;
                    overflow: hidden;
                }
                .rutube-body .scroll {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    height: 100%;
                }
                .rutube-tab {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4em;
                    padding: 0.35em 0.85em;
                    border-radius: 0.4em;
                    background: rgba(255, 255, 255, 0.08);
                    color: #ccc;
                    font-size: 0.95em;
                    font-weight: 500;
                    cursor: pointer;
                    transition: background 0.15s, color 0.15s;
                }
                .rutube-tab.focus, .rutube-tab:hover {
                    background: #ffc107;
                    color: #000;
                    box-shadow: 0 0 0.8em rgba(255, 193, 7, 0.5);
                }
            </style>
        `);
        $('head').append(style);

        Lampa.Template.add('rutube_item', `
            <div class="online selector">
                <div class="online__body">
                    <div style="position: absolute; left: 0.6em; top: 0.6em; width: 2em; height: 2em; display: flex; align-items: center; justify-content: center;">
                        <svg style="height: 1.8em; width: 1.8em;" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect width="24" height="24" rx="5" fill="#E62117"/>
                            <path d="M9.5 8L16.5 12L9.5 16V8Z" fill="white"/>
                        </svg>
                    </div>
                    <div class="online__title" style="padding-left: 2.5em; font-size: 1.15em; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{title}</div>
                    <div class="online__quality" style="padding-left: 3.2em; font-size: 0.9em; opacity: 0.8; margin-top: 0.25em;">{quality}{info}</div>
                </div>
            </div>
        `);
    }

    // ==========================================
    // Компонент Rutube
    // ==========================================
    function RutubeComponent(object) {
        var _this = this;
        var movie = Object.assign(
            {},
            (object && object.card) || {},
            (object && object.data && object.data.movie) || {},
            (object && object.movie) || {}
        );
        var last_focused = null;

        var is_serial = Boolean(movie.number_of_seasons || movie.seasons || movie.first_air_date || movie.name);
        var total_seasons = movie.number_of_seasons || (movie.seasons ? movie.seasons.length : 1);
        if (total_seasons < 1) total_seasons = 1;

        var current_season = 1;
        var active_voice_filter = 'all';
        var voices_found = [];

        var compilations_raw = [];
        var episodes_map = {};
        var movies_raw = [];

        var container = $('<div class="rutube-view"></div>');
        var header = $('<div class="rutube-header"></div>');
        var body_wrap = $('<div class="rutube-body"></div>');
        var scroll = new Lampa.Scroll({ mask: true, over: true });

        body_wrap.append(scroll.render());
        container.append(header);
        container.append(body_wrap);

        this.create = function () {
            initTemplates();
            scroll.minus(header);
            _this.loading(true);

            if (is_serial) {
                _this.loadSeasonEpisodes(1);
            } else {
                _this.loadMovie();
            }

            return _this.render();
        };

        this.render = function () {
            return container;
        };

        this.loading = function (status) {
            if (_this.activity && _this.activity.loader) {
                _this.activity.loader(status);
            }
        };

        this.empty = function (msg) {
            scroll.clear();
            var empty = Lampa.Template.get('list_empty');
            if (msg) empty.find('.empty__descr').text(msg);
            scroll.append(empty);
            _this.loading(false);
            _this.buildHeader();
            _this.start();
        };

        this.buildHeader = function () {
            header.empty();

            if (is_serial && total_seasons > 1) {
                var season_btn = $(`<div class="selector rutube-tab">📁 ${current_season} сезон ▾</div>`);
                season_btn.on('hover:focus', function () { last_focused = this; });
                season_btn.on('hover:enter', function () {
                    var s_items = [];
                    for (var s = 1; s <= total_seasons; s++) {
                        s_items.push({ title: s + ' сезон', season: s, selected: s === current_season });
                    }
                    Lampa.Select.show({
                        title: 'Выберите сезон',
                        items: s_items,
                        onSelect: function (sel) {
                            current_season = sel.season;
                            _this.loadSeasonEpisodes(sel.season);
                        },
                        onBack: function () { _this.start(); }
                    });
                });
                header.append(season_btn);
            }

            if (voices_found.length > 1) {
                var v_label = active_voice_filter === 'all' ? 'Все озвучки' : active_voice_filter;
                var voice_btn = $(`<div class="selector rutube-tab">🎙️ ${v_label} ▾</div>`);
                voice_btn.on('hover:focus', function () { last_focused = this; });
                voice_btn.on('hover:enter', function () {
                    var v_items = [{ title: 'Все озвучки / По умолчанию', voice: 'all', selected: active_voice_filter === 'all' }];
                    voices_found.forEach(function (v) {
                        v_items.push({ title: v, voice: v, selected: active_voice_filter === v });
                    });
                    Lampa.Select.show({
                        title: 'Выберите студию перевода',
                        items: v_items,
                        onSelect: function (sel) {
                            active_voice_filter = sel.voice;
                            _this.buildHeader();
                            _this.renderEpisodesGrid();
                        },
                        onBack: function () { _this.start(); }
                    });
                });
                header.append(voice_btn);
            }
        };

        // ------------------------------------------
        // Режим Сериала: Загрузка серий сезона
        // ------------------------------------------
        this.loadSeasonEpisodes = function (season_num) {
            current_season = season_num;
            _this.loading(true);
            scroll.clear();

            var search_title = cleanTitle(movie.name || movie.title || movie.original_name || movie.original_title);
            if (!search_title) {
                _this.empty('Не удалось определить название сериала');
                return;
            }
            var queries = [
                search_title + ' ' + season_num + ' сезон',
                search_title + ' ' + season_num + ' сезон все серии'
            ];
            if (season_num === 1) {
                queries.push(search_title + ' все серии');
                queries.push(search_title + ' 1 сезон все серии');
            }

            compilations_raw = [];
            episodes_map = {};
            var detected_voices = {};
            var seen_video_ids = {};
            var pending = queries.length;

            function checkFinish() {
                pending--;
                if (pending > 0) return;

                voices_found = Object.keys(detected_voices);
                active_voice_filter = 'all';

                _this.buildHeader();

                var has_any = compilations_raw.length > 0 || Object.keys(episodes_map).length > 0;
                if (!has_any) {
                    _this.empty('Серии для ' + season_num + ' сезона не найдены на Rutube');
                } else {
                    _this.renderEpisodesGrid();
                }
            }

            queries.forEach(function (q) {
                var url = 'https://rutube.ru/api/search/video/?query=' + encodeURIComponent(q);
                apiRequest(url, {}, function (data) {
                    var results = (data && data.results) || [];
                    results.forEach(function (v) {
                        if (!v || v.is_deleted || v.is_hidden || v.is_locked || v.is_audio || v.is_paid || v.is_livestream) return;
                        if (seen_video_ids[v.id]) return;
                        if (isIrrelevantCategory(v)) return;
                        if (NOISE_REG.test(v.title)) return;
                        if (v.duration < 300) return;
                        if (!isSerialRelevant(v.title, movie.name || movie.title, movie.original_name || movie.original_title)) return;

                        seen_video_ids[v.id] = true;

                        var voice = detectVoice(v.title) || detectVoice(v.description) || 'Оригинал / Залив';
                        if (voice) detected_voices[voice] = true;

                        var quality = detectRutubeQuality(v);

                        if (isCompilationVideo(v.title)) {
                            var sm = v.title.match(/(?:(\d+)\s*(?:сезон|season|s))/i);
                            if (!sm || parseInt(sm[1], 10) === season_num) {
                                compilations_raw.push({
                                    title: v.title,
                                    video_id: v.id,
                                    duration: v.duration,
                                    voice: voice,
                                    quality: quality,
                                    author: v.author ? v.author.name : '',
                                    hash: Lampa.Utils.hash('rutube_comp_' + (movie.id || search_title) + '_s' + season_num + '_' + v.id)
                                });
                                return;
                            }
                        }

                        var ep_num = parseEpisodeNum(v.title, season_num);
                        if (!ep_num) return;

                        var ep_obj = {
                            episode: ep_num,
                            season: season_num,
                            title: v.title,
                            video_id: v.id,
                            duration: v.duration,
                            voice: voice,
                            quality: quality,
                            author: v.author ? v.author.name : '',
                            hash: Lampa.Utils.hash('rutube_' + (movie.id || search_title) + '_s' + season_num + 'e' + ep_num + '_' + v.id)
                        };

                        if (!episodes_map[ep_num]) episodes_map[ep_num] = [];
                        episodes_map[ep_num].push(ep_obj);
                    });
                    checkFinish();
                }, function () {
                    checkFinish();
                });
            });
        };

        // ------------------------------------------
        // Отрисовка серий Rutube + длинных сборников
        // ------------------------------------------
        this.renderEpisodesGrid = function () {
            scroll.clear();
            _this.loading(false);

            // 1. Длинные сборники (Все серии)
            var comps = compilations_raw.filter(function (c) {
                if (active_voice_filter !== 'all' && c.voice !== active_voice_filter) return false;
                return true;
            });

            comps.forEach(function (comp) {
                var quality_badge = `<span style="background: #E62117; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">${comp.quality}</span>`;
                var comp_badge = `<span style="background: #9C27B0; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">🎬 Полный сезон</span>`;

                var info_parts = [];
                if (comp.voice) info_parts.push('[' + comp.voice + ']');
                if (comp.duration) info_parts.push(formatTime(comp.duration));
                if (comp.author) info_parts.push(comp.author);

                var item = Lampa.Template.get('rutube_item', {
                    title: comp.title,
                    quality: comp_badge + quality_badge,
                    info: info_parts.join(' • ')
                });

                var timeline = Lampa.Timeline.view(comp.hash);
                if (timeline) item.find('.online__body').append(timeline);

                item.on('hover:focus', function () {
                    last_focused = this;
                    scroll.update($(this), true);
                });

                item.on('hover:enter', function () {
                    _this.playVideo(comp, null, 0);
                });

                scroll.append(item);
            });

            // 2. Обычные серии
            var ep_numbers = Object.keys(episodes_map).map(function (k) { return parseInt(k, 10); });
            ep_numbers.sort(function (a, b) { return a - b; });

            var flat_episodes = [];
            ep_numbers.forEach(function (ep_num) {
                var variants = episodes_map[ep_num] || [];
                var filtered = variants.filter(function (v) {
                    if (active_voice_filter !== 'all' && v.voice !== active_voice_filter) return false;
                    return true;
                });
                if (filtered.length > 0) {
                    flat_episodes.push(filtered[0]);
                }
            });

            flat_episodes.forEach(function (ep, index) {
                var ep_title = 'Серия ' + ep.episode + (ep.title ? ' — ' + ep.title : '');
                var badges = `<span style="background: #E62117; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">${ep.quality}</span>`;

                var ep_info_parts = [];
                if (ep.voice) ep_info_parts.push('[' + ep.voice + ']');
                if (ep.duration) ep_info_parts.push(formatTime(ep.duration));
                if (ep.author) ep_info_parts.push(ep.author);

                var item = Lampa.Template.get('rutube_item', {
                    title: ep_title,
                    quality: badges,
                    info: ep_info_parts.join(' • ')
                });

                var timeline = Lampa.Timeline.view(ep.hash);
                if (timeline) item.find('.online__body').append(timeline);

                item.on('hover:focus', function () {
                    last_focused = this;
                    scroll.update($(this), true);
                });

                item.on('hover:enter', function () {
                    _this.playVideo(ep, flat_episodes, index);
                });

                scroll.append(item);
            });

            _this.start();
        };

        // ------------------------------------------
        // Режим Фильма: Поиск фильма
        // ------------------------------------------
        this.loadMovie = function () {
            _this.loading(true);
            scroll.clear();

            var search_title = cleanTitle(movie.title || movie.name || movie.original_title || movie.original_name);
            var year = (movie.release_date || movie.first_air_date || '').substring(0, 4);

            if (!search_title) {
                _this.empty('Не удалось определить название фильма');
                return;
            }

            var query = encodeURIComponent(search_title + (year ? ' ' + year : ''));
            var url = 'https://rutube.ru/api/search/video/?query=' + query;

            apiRequest(url, {}, function (data) {
                var results = (data && data.results) || [];
                movies_raw = [];

                results.forEach(function (v) {
                    if (!v || v.is_deleted || v.is_hidden || v.is_locked || v.is_audio || v.is_paid || v.is_livestream) return;
                    if (isIrrelevantCategory(v)) return;
                    if (NOISE_REG.test(v.title)) return;
                    if (v.duration < 2400) return;
                    if (!isMovieRelevant(v.title, movie.title || movie.name, movie.original_title || movie.original_name)) return;

                    movies_raw.push({
                        title: v.title,
                        description: v.description,
                        video_id: v.id,
                        duration: v.duration,
                        quality: detectRutubeQuality(v),
                        author: v.author ? v.author.name : '',
                        hash: Lampa.Utils.hash('rutube_movie_' + (movie.id || search_title) + '_' + v.id)
                    });
                });

                if (movies_raw.length === 0) {
                    _this.empty('Фильм не найден на Rutube');
                    return;
                }

                scroll.clear();
                _this.loading(false);
                _this.buildHeader();

                movies_raw.forEach(function (m_item) {
                    var m_badges = `<span style="background: #E62117; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">${m_item.quality}</span>`;

                    var item = Lampa.Template.get('rutube_item', {
                        title: m_item.title,
                        quality: m_badges,
                        info: formatTime(m_item.duration) + (m_item.author ? ' • ' + m_item.author : '')
                    });

                    var timeline = Lampa.Timeline.view(m_item.hash);
                    if (timeline) item.find('.online__body').append(timeline);

                    item.on('hover:focus', function () {
                        last_focused = this;
                        scroll.update($(this), true);
                    });

                    item.on('hover:enter', function () {
                        _this.playVideo(m_item, null, 0);
                    });

                    scroll.append(item);
                });

                _this.start();
            }, function (err) {
                _this.empty('Ошибка поиска на Rutube (' + err.message + ')');
            });
        };

        // ------------------------------------------
        // Воспроизведение через Lampa.Player
        // ------------------------------------------
        var is_playing = false;
        this.playVideo = function (item, playlist_items, start_index) {
            if (is_playing) return;
            is_playing = true;
            setTimeout(function () { is_playing = false; }, 1500);

            _this.loading(true);

            var play_url = 'https://rutube.ru/api/play/options/' + item.video_id + '/?no_404=true&referer=&pver=v2&client=wdp&mq=all&av1=1';

            apiRequest(play_url, {}, function (data) {
                _this.loading(false);
                var stream_url = data && data.video_balancer && (data.video_balancer.m3u8 || data.video_balancer.m3u8_m4s);

                if (!stream_url) {
                    Lampa.Noty.show('Не удалось извлечь поток видео Rutube');
                    return;
                }

                var final_url = stream_url;
                if (!Lampa.Platform.is('android')) {
                    final_url = getProxy() + stream_url;
                }

                fixPlayerCrossOrigin();

                var player_item = {
                    title: item.title,
                    url: final_url,
                    timeline: { hash: item.hash }
                };

                Lampa.Player.play(player_item);

                if (playlist_items && playlist_items.length > 1) {
                    var playlist = playlist_items.map(function (elem) {
                        return {
                            title: 'Серия ' + elem.episode + (elem.title ? ' — ' + elem.title : ''),
                            episode: elem.episode,
                            season: elem.season,
                            url: function (call) {
                                var next_url = 'https://rutube.ru/api/play/options/' + elem.video_id + '/?no_404=true&referer=&pver=v2&client=wdp&mq=all&av1=1';
                                apiRequest(next_url, {}, function (res) {
                                    var next_m3u8 = res && res.video_balancer && (res.video_balancer.m3u8 || res.video_balancer.m3u8_m4s);
                                    var next_final = next_m3u8;
                                    if (next_m3u8 && !Lampa.Platform.is('android')) {
                                        next_final = getProxy() + next_m3u8;
                                    }
                                    call({
                                        title: 'Серия ' + elem.episode,
                                        url: next_final || '',
                                        timeline: { hash: elem.hash },
                                        episode: elem.episode,
                                        season: elem.season
                                    });
                                }, function () {
                                    call({ url: '' });
                                });
                            }
                        };
                    });

                    Lampa.Player.playlist(playlist);
                }

                Lampa.Player.callback(function () {
                    Lampa.Controller.toggle('content');
                });
            }, function (err) {
                _this.loading(false);
                Lampa.Noty.show('Ошибка загрузки потока: ' + err.message);
            });
        };

        // ------------------------------------------
        // Управление пультом ДУ (Lampa.Controller)
        // ------------------------------------------
        this.start = function () {
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(container);
                    Lampa.Controller.collectionFocus(last_focused || false, container);
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    if (Navigator.canmove('down')) Navigator.move('down');
                },
                right: function () {
                    if (Navigator.canmove('right')) Navigator.move('right');
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                back: function () {
                    Lampa.Activity.backward();
                }
            });

            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            scroll.destroy();
        };
    }

    // ==========================================
    // Регистрация плагина в Lampa
    // ==========================================
    Lampa.Component.add('rutube', RutubeComponent);

    Lampa.Listener.follow('full', function (e) {
        if (e.type === 'complite') {
            var btn = $(`
                <div class="full-start__button selector rutube-open-btn" style="background: rgba(230, 33, 23, 0.2); border: 1px solid rgba(230, 33, 23, 0.4);">
                    <svg style="height: 1.5em; width: 1.5em; margin-right: 0.5em; vertical-align: middle;" viewBox="0 0 24 24" fill="none">
                        <rect width="24" height="24" rx="5" fill="#E62117"/>
                        <path d="M9.5 8L16.5 12L9.5 16V8Z" fill="white"/>
                    </svg>
                    <span>Rutube</span>
                </div>
            `);

            btn.on('hover:focus', function () {
                if (Lampa.Controller.collectionFocus) {
                    Lampa.Controller.collectionFocus(this, e.object.activity.render());
                }
            });

            btn.on('hover:enter', function () {
                var full_movie = Object.assign(
                    {},
                    (e.data && e.data.movie) || {},
                    (e.object && e.object.card) || {},
                    (e.object && e.object.movie) || {}
                );
                Lampa.Activity.push({
                    url: '',
                    title: 'Rutube',
                    component: 'rutube',
                    movie: full_movie,
                    page: 1
                });
            });

            e.object.activity.render().find('.full-start-new__buttons, .full-start__buttons').append(btn);
        }
    });

})();
