(function () {
    'use strict';

    if (window.plugin_vk_ready) return;
    window.plugin_vk_ready = true;

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

    var VK_CLIENT_ID = 52461373;
    var VK_CLIENT_SECRET = 'o557NLIkAErNhakXrQ7A';

    function getProxy() {
        return PROXIES[current_proxy_index];
    }

    function rotateProxy() {
        current_proxy_index = (current_proxy_index + 1) % PROXIES.length;
    }

    // ==========================================
    // Глобальный перехват запросов к VK CDN (XHR / fetch)
    // ==========================================
    (function hookNetworkForVk() {
        if (window.__vk_net_hooked) return;
        window.__vk_net_hooked = true;

        function shouldProxyVk(url) {
            if (typeof url !== 'string') return false;
            var is_vk = (
                url.indexOf('okcdn.ru') !== -1 ||
                url.indexOf('vkuser.net') !== -1 ||
                url.indexOf('vkvideo.ru') !== -1
            );
            var is_already_proxied = (
                url.indexOf('rte.net.ru') !== -1 ||
                url.indexOf('/http') !== -1
            );
            return is_vk && !is_already_proxied;
        }

        var origXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
            if (shouldProxyVk(url)) {
                url = getProxy() + url;
            }
            return origXhrOpen.call(this, method, url, async !== false, user, password);
        };

        if (window.fetch) {
            var origFetch = window.fetch;
            window.fetch = function (input, init) {
                if (typeof input === 'string') {
                    if (shouldProxyVk(input)) {
                        input = getProxy() + input;
                    }
                } else if (input && input.url && typeof input.url === 'string') {
                    if (shouldProxyVk(input.url)) {
                        try {
                            input = new Request(getProxy() + input.url, input);
                        } catch (e) {}
                    }
                }
                return origFetch.apply(this, arguments);
            };
        }
    })();

    // ==========================================
    // Сетевой клиент (GET / POST с обходом CORS)
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
    // Авторизация VK (Анонимный токен)
    // ==========================================
    function getAnonymToken(callback, error_callback) {
        var token = Lampa.Storage.get('vk_anonym_token', '');
        var expires = Lampa.Storage.get('vk_token_expires', 0);

        if (token && expires && Date.now() < (expires - 60000)) {
            return callback(token);
        }

        var auth_url = 'https://login.vk.com/?act=get_anonym_token';
        var body = 'client_secret=' + encodeURIComponent(VK_CLIENT_SECRET) +
            '&client_id=' + VK_CLIENT_ID +
            '&scopes=audio_anonymous,video_anonymous,photos_anonymous,profile_anonymous' +
            '&isApiOauthAnonymEnabled=false' +
            '&version=1' +
            '&app_id=6287487';

        apiRequest(auth_url, {
            method: 'POST',
            body: body
        }, function (res) {
            var access_token = res && res.data && res.data.access_token;
            if (access_token) {
                var exp_seconds = (res.data.expires || res.data.expired_at || 0);
                var exp_ms = exp_seconds ? exp_seconds * 1000 : (Date.now() + 10 * 3600 * 1000);
                Lampa.Storage.set('vk_anonym_token', access_token);
                Lampa.Storage.set('vk_token_expires', exp_ms);
                callback(access_token);
            } else {
                if (error_callback) error_callback(new Error('Failed to get VK token'));
            }
        }, function (err) {
            if (error_callback) error_callback(err);
        });
    }

    // ==========================================
    // Поиск видео через VK Video API
    // ==========================================
    function searchVk(query, callback, error_callback) {
        getAnonymToken(function (token) {
            var search_url = 'https://api.vkvideo.ru/method/catalog.getVideoSearchWeb2?v=5.264&client_id=' + VK_CLIENT_ID;
            var body = 'screen_ref=search_video_service&input_method=keyboard_search_button&q=' + encodeURIComponent(query) + '&access_token=' + encodeURIComponent(token);

            apiRequest(search_url, {
                method: 'POST',
                body: body
            }, function (res) {
                if (res && res.error && res.error.error_code === 5) {
                    Lampa.Storage.set('vk_anonym_token', '');
                    Lampa.Storage.set('vk_token_expires', 0);
                    getAnonymToken(function (new_token) {
                        var retry_body = 'screen_ref=search_video_service&input_method=keyboard_search_button&q=' + encodeURIComponent(query) + '&access_token=' + encodeURIComponent(new_token);
                        apiRequest(search_url, { method: 'POST', body: retry_body }, function (res2) {
                            var vids = res2 && res2.response && res2.response.catalog_videos;
                            callback(vids || []);
                        }, error_callback);
                    }, error_callback);
                    return;
                }

                var vids = res && res.response && res.response.catalog_videos;
                callback(vids || []);
            }, error_callback);
        }, error_callback);
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

    function extractQualities(files) {
        var qualities = {};
        var max_q = '1080p';
        var def_url = '';

        var order = ['mp4_2160', 'mp4_1440', 'mp4_1080', 'mp4_720', 'mp4_480', 'mp4_360', 'mp4_240', 'mp4_144'];
        var names = {
            'mp4_2160': '4K',
            'mp4_1440': '2K',
            'mp4_1080': '1080p',
            'mp4_720': '720p',
            'mp4_480': '480p',
            'mp4_360': '360p',
            'mp4_240': '240p',
            'mp4_144': '144p'
        };

        for (var i = 0; i < order.length; i++) {
            var k = order[i];
            if (files[k]) {
                var q_label = names[k];
                qualities[q_label] = files[k];
                if (!def_url) {
                    def_url = files[k];
                    max_q = q_label;
                }
            }
        }

        if (!def_url && files.hls) {
            qualities['HLS'] = files.hls;
            def_url = files.hls;
            max_q = '1080p';
        }

        return {
            map: qualities,
            max: max_q,
            default_url: def_url
        };
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
        function removeAttr() {
            var video = (Lampa.PlayerVideo && Lampa.PlayerVideo.video && Lampa.PlayerVideo.video()) ||
                        document.querySelector('video.player-video__video, video');
            if (video) {
                try {
                    video.removeAttribute('crossorigin');
                } catch (e) {}
            }
        }
        removeAttr();
        setTimeout(removeAttr, 100);
        setTimeout(removeAttr, 300);
        setTimeout(removeAttr, 600);
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
                .vk-view {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    position: relative;
                    overflow: hidden;
                }
                .vk-header {
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
                .vk-body {
                    flex: 1 1 auto;
                    height: 100%;
                    position: relative;
                    overflow: hidden;
                }
                .vk-body .scroll {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    height: 100%;
                }
                .vk-tab {
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
                .vk-tab.focus, .vk-tab:hover {
                    background: #ffc107;
                    color: #000;
                    box-shadow: 0 0 0.8em rgba(255, 193, 7, 0.5);
                }
            </style>
        `);
        $('head').append(style);

        Lampa.Template.add('vk_item', `
            <div class="online selector">
                <div class="online__body">
                    <div style="position: absolute; left: 0.6em; top: 0.6em; width: 2em; height: 2em; display: flex; align-items: center; justify-content: center;">
                        <svg style="height: 1.8em; width: 1.8em;" viewBox="0 0 24 24" fill="none">
                            <rect width="24" height="24" rx="5" fill="#0077FF"/>
                            <path d="M12.7 16.5h-1.2c-2.4 0-3.8-1.7-5-3.6-.9-1.4-1.7-3-2.5-4.6h2.2c.6 1.7 1.3 2.9 2 3.6.5.6.8.8 1.1.8.2 0 .3-.1.3-.8V9.8c0-.7-.2-.8-.7-.9-.2 0-.3-.2-.3-.3.4-.6 1.3-.7 2.2-.7h.9c.7 0 .9.3.9 1v2.7c0 .4.2.6.4.6.2 0 .4-.2.8-.6 1-1.2 1.8-2.8 2.2-4.1h2.2c-.4 2-1.8 3.8-2.6 4.8-.4.5-.4.7 0 1.1.9.9 2 2.1 2.5 3.1h-2.3c-.6-.8-1.4-1.8-2-2.3-.3-.3-.6-.4-.9-.4-.5 0-.7.3-.7.9v1.2c0 .5-.2.7-.9.7z" fill="#fff"/>
                        </svg>
                    </div>
                    <div class="online__title" style="padding-left: 2.5em; font-size: 1.15em; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{title}</div>
                    <div class="online__quality" style="padding-left: 3.2em; font-size: 0.9em; opacity: 0.8; margin-top: 0.25em;">{quality}{info}</div>
                </div>
            </div>
        `);
    }

    // ==========================================
    // Компонент VK Видео
    // ==========================================
    function VkComponent(object) {
        var _this = this;
        var movie = object.movie || {};
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

        var container = $('<div class="vk-view"></div>');
        var header = $('<div class="vk-header"></div>');
        var body_wrap = $('<div class="vk-body"></div>');
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
                var season_btn = $(`<div class="selector vk-tab">📁 ${current_season} сезон ▾</div>`);
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
                var voice_btn = $(`<div class="selector vk-tab">🎙️ ${v_label} ▾</div>`);
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

            var search_title = cleanTitle(movie.name || movie.title);
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
                    _this.empty('Серии для ' + season_num + ' сезона не найдены в VK Видео');
                } else {
                    _this.renderEpisodesGrid();
                }
            }

            queries.forEach(function (q) {
                searchVk(q, function (videos) {
                    if (Array.isArray(videos)) {
                        videos.forEach(function (item) {
                            var v = item && item.video;
                            if (!v || !v.files || seen_video_ids[v.id]) return;
                            if (NOISE_REG.test(v.title)) return;
                            if (v.duration < 300) return;
                            if (!isSerialRelevant(v.title, movie.name || movie.title, movie.original_name || movie.original_title)) return;

                            var q_info = extractQualities(v.files);
                            if (!q_info.default_url) return;

                            seen_video_ids[v.id] = true;

                            var voice = detectVoice(v.title) || detectVoice(v.description) || 'Оригинал / Залив';
                            if (voice) detected_voices[voice] = true;

                            var subs = [];
                            if (v.subtitles) {
                                v.subtitles.forEach(function (s) {
                                    if (s && s.url) subs.push({ label: s.title || s.lang || 'Субтитры', url: s.url });
                                });
                            }

                            if (isCompilationVideo(v.title)) {
                                var sm = v.title.match(/(?:(\d+)\s*(?:сезон|season|s))/i);
                                if (!sm || parseInt(sm[1], 10) === season_num) {
                                    compilations_raw.push({
                                        title: v.title,
                                        video_id: v.id,
                                        duration: v.duration,
                                        voice: voice,
                                        quality: q_info.max,
                                        url: q_info.default_url,
                                        qualities: q_info.map,
                                        subtitles: subs,
                                        hash: Lampa.Utils.hash('vk_comp_' + (movie.id || search_title) + '_s' + season_num + '_' + v.id)
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
                                quality: q_info.max,
                                url: q_info.default_url,
                                qualities: q_info.map,
                                subtitles: subs,
                                hash: Lampa.Utils.hash('vk_' + (movie.id || search_title) + '_s' + season_num + 'e' + ep_num + '_' + v.id)
                            };

                            if (!episodes_map[ep_num]) episodes_map[ep_num] = [];
                            episodes_map[ep_num].push(ep_obj);
                        });
                    }
                    checkFinish();
                }, function () {
                    checkFinish();
                });
            });
        };

        // ------------------------------------------
        // Отрисовка серий VK + длинных сборников
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
                var quality_badge = `<span style="background: #0077FF; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">${comp.quality}</span>`;
                var comp_badge = `<span style="background: #9C27B0; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">🎬 Полный сезон</span>`;

                var info_parts = [];
                if (comp.voice) info_parts.push('[' + comp.voice + ']');
                if (comp.duration) info_parts.push(formatTime(comp.duration));

                var item = Lampa.Template.get('vk_item', {
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
                var badges = `<span style="background: #0077FF; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">${ep.quality}</span>`;

                var ep_info_parts = [];
                if (ep.voice) ep_info_parts.push('[' + ep.voice + ']');
                if (ep.duration) ep_info_parts.push(formatTime(ep.duration));

                var item = Lampa.Template.get('vk_item', {
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
        // Режим Фильма: Поиск фильма в VK
        // ------------------------------------------
        this.loadMovie = function () {
            _this.loading(true);
            scroll.clear();

            var search_title = cleanTitle(movie.title || movie.name);
            var year = (movie.release_date || movie.first_air_date || '').substring(0, 4);
            var query = search_title + (year ? ' ' + year : '');

            searchVk(query, function (videos) {
                movies_raw = [];

                if (Array.isArray(videos)) {
                    videos.forEach(function (item) {
                        var v = item && item.video;
                        if (!v || !v.files) return;
                        if (NOISE_REG.test(v.title)) return;
                        if (v.duration < 2400) return;
                        if (!isMovieRelevant(v.title, movie.title || movie.name, movie.original_title || movie.original_name)) return;

                        var q_info = extractQualities(v.files);
                        if (!q_info.default_url) return;

                        var subs = [];
                        if (v.subtitles) {
                            v.subtitles.forEach(function (s) {
                                if (s && s.url) subs.push({ label: s.title || s.lang || 'Субтитры', url: s.url });
                            });
                        }

                        movies_raw.push({
                            title: v.title,
                            video_id: v.id,
                            duration: v.duration,
                            qualities: q_info.map,
                            quality: q_info.max,
                            url: q_info.default_url,
                            subtitles: subs,
                            hash: Lampa.Utils.hash('vk_movie_' + (movie.id || search_title) + '_' + v.id)
                        });
                    });
                }

                if (movies_raw.length === 0) {
                    _this.empty('Фильм не найден в VK Видео');
                    return;
                }

                scroll.clear();
                _this.loading(false);
                _this.buildHeader();

                movies_raw.forEach(function (m_item) {
                    var m_badges = `<span style="background: #0077FF; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">${m_item.quality}</span>`;

                    var item = Lampa.Template.get('vk_item', {
                        title: m_item.title,
                        quality: m_badges,
                        info: formatTime(m_item.duration)
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
                _this.empty('Ошибка поиска в VK (' + err.message + ')');
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

            _this.loading(false);
            fixPlayerCrossOrigin();

            var final_url = item.url;
            if (!Lampa.Platform.is('android')) {
                final_url = getProxy() + item.url;
            }

            var subs = (item.subtitles || []).map(function (s) {
                return {
                    label: s.label,
                    url: !Lampa.Platform.is('android') ? getProxy() + s.url : s.url
                };
            });

            var player_item = {
                title: item.title,
                url: final_url,
                timeline: { hash: item.hash },
                subtitles: subs
            };

            Lampa.Player.play(player_item);

            if (playlist_items && playlist_items.length > 1) {
                var playlist = playlist_items.map(function (elem) {
                    return {
                        title: 'Серия ' + elem.episode + (elem.title ? ' — ' + elem.title : ''),
                        episode: elem.episode,
                        season: elem.season,
                        url: function (call) {
                            var f_url = elem.url;
                            if (!Lampa.Platform.is('android')) {
                                f_url = getProxy() + elem.url;
                            }
                            call({
                                title: 'Серия ' + elem.episode,
                                url: f_url,
                                timeline: { hash: elem.hash },
                                episode: elem.episode,
                                season: elem.season
                            });
                        }
                    };
                });

                Lampa.Player.playlist(playlist);
            }

            Lampa.Player.callback(function () {
                Lampa.Controller.toggle('content');
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
    Lampa.Component.add('vk', VkComponent);

    Lampa.Listener.follow('full', function (e) {
        if (e.type === 'complite') {
            var btn = $(`
                <div class="full-start__button selector vk-open-btn" style="background: rgba(0, 119, 255, 0.2); border: 1px solid rgba(0, 119, 255, 0.4);">
                    <svg style="height: 1.5em; width: 1.5em; margin-right: 0.5em; vertical-align: middle;" viewBox="0 0 24 24" fill="none">
                        <rect width="24" height="24" rx="5" fill="#0077FF"/>
                        <path d="M12.7 16.5h-1.2c-2.4 0-3.8-1.7-5-3.6-.9-1.4-1.7-3-2.5-4.6h2.2c.6 1.7 1.3 2.9 2 3.6.5.6.8.8 1.1.8.2 0 .3-.1.3-.8V9.8c0-.7-.2-.8-.7-.9-.2 0-.3-.2-.3-.3.4-.6 1.3-.7 2.2-.7h.9c.7 0 .9.3.9 1v2.7c0 .4.2.6.4.6.2 0 .4-.2.8-.6 1-1.2 1.8-2.8 2.2-4.1h2.2c-.4 2-1.8 3.8-2.6 4.8-.4.5-.4.7 0 1.1.9.9 2 2.1 2.5 3.1h-2.3c-.6-.8-1.4-1.8-2-2.3-.3-.3-.6-.4-.9-.4-.5 0-.7.3-.7.9v1.2c0 .5-.2.7-.9.7z" fill="#fff"/>
                    </svg>
                    <span>VK Видео</span>
                </div>
            `);

            btn.on('hover:focus', function () {
                if (Lampa.Controller.collectionFocus) {
                    Lampa.Controller.collectionFocus(this, e.object.activity.render());
                }
            });

            btn.on('hover:enter', function () {
                Lampa.Activity.push({
                    url: '',
                    title: 'VK Видео',
                    component: 'vk',
                    movie: e.object.movie,
                    page: 1
                });
            });

            e.object.activity.render().find('.full-start-new__buttons, .full-start__buttons').append(btn);
        }
    });

})();
