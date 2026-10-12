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
                    // Токен устарел - сбрасываем и повторяем запрос
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
            .replace(/[.,:;!?&%$#@*()\[\]{}"'\\/`~^_+=]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function formatTime(sec) {
        if (!sec) return '';
        var m = Math.floor(sec / 60);
        var h = Math.floor(m / 60);
        m = m % 60;
        if (h > 0) return h + ' ч ' + (m < 10 ? '0' : '') + m + ' мин';
        return m + ' мин';
    }

    function formatTimecode(sec) {
        if (!sec && sec !== 0) return '00:00';
        var s = Math.floor(sec % 60);
        var m = Math.floor((sec / 60) % 60);
        var h = Math.floor(sec / 3600);
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        if (h > 0) {
            return h + ':' + pad(m) + ':' + pad(s);
        }
        return pad(m) + ':' + pad(s);
    }

    function parseTimecodeToSeconds(time_str) {
        if (!time_str) return 0;
        var parts = time_str.trim().split(':').map(function (p) { return parseInt(p, 10) || 0; });
        if (parts.length === 3) {
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else if (parts.length === 2) {
            return parts[0] * 60 + parts[1];
        }
        return 0;
    }

    function extractSegmentsFromVideo(v) {
        if (!v) return null;

        // 1. Из массива episodes от VK API
        if (Array.isArray(v.episodes) && v.episodes.length > 1) {
            var segs = [];
            for (var i = 0; i < v.episodes.length; i++) {
                var ep_item = v.episodes[i];
                if (typeof ep_item.time === 'number') {
                    var next_time = (i + 1 < v.episodes.length && typeof v.episodes[i + 1].time === 'number')
                        ? v.episodes[i + 1].time
                        : (v.duration || (ep_item.time + 3600));
                    segs.push({
                        text: ep_item.text || ('Серия ' + (i + 1)),
                        time: ep_item.time,
                        duration: Math.max(0, next_time - ep_item.time)
                    });
                }
            }
            if (segs.length > 1) return segs;
        }

        // 2. Из описания видео по таймкодам
        if (v.description && typeof v.description === 'string') {
            var lines = v.description.split('\n');
            var segs_desc = [];

            for (var j = 0; j < lines.length; j++) {
                var line = lines[j].trim();
                if (!line) continue;

                // Вариант 1: Время в начале строки: [00:54:38] 2 Серия или 00:54:38 - 2 Серия
                var m = line.match(/^\[?(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\]?\s*[-—–:.]?\s*(.+)$/);
                if (m) {
                    var t1 = parseTimecodeToSeconds(m[1] ? m[1] + ':' + m[2] + ':' + m[3] : m[2] + ':' + m[3]);
                    segs_desc.push({
                        text: m[4].trim(),
                        time: t1
                    });
                    continue;
                }

                // Вариант 2: Время в конце строки: 2 Серия - 00:54:38 или 2 Серия (00:54:38)
                m = line.match(/^(.+?)\s*[-—–:(]\s*\[?(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\]?\)?$/);
                if (m) {
                    var t2 = parseTimecodeToSeconds(m[2] ? m[2] + ':' + m[3] + ':' + m[4] : m[3] + ':' + m[4]);
                    segs_desc.push({
                        text: m[1].trim(),
                        time: t2
                    });
                }
            }

            if (segs_desc.length > 1) {
                segs_desc.sort(function (a, b) { return a.time - b.time; });
                for (var k = 0; k < segs_desc.length; k++) {
                    var next_t = (k + 1 < segs_desc.length) ? segs_desc[k + 1].time : (v.duration || (segs_desc[k].time + 3600));
                    segs_desc[k].duration = Math.max(0, next_t - segs_desc[k].time);
                }
                return segs_desc;
            }
        }

        return null;
    }

    function qualityScore(q) {
        if (!q) return 0;
        if (q.indexOf('4K') !== -1 || q.indexOf('2160') !== -1) return 5;
        if (q.indexOf('2K') !== -1 || q.indexOf('1440') !== -1) return 4;
        if (q.indexOf('1080') !== -1) return 3;
        if (q.indexOf('720') !== -1) return 2;
        if (q.indexOf('480') !== -1) return 1;
        return 0;
    }

    function seekToStartTime(target_sec) {
        if (!target_sec || target_sec <= 0) return;

        var sought = false;
        var attempts = 0;
        var max_attempts = 50;

        function doSeek() {
            if (sought) return;
            var video = (Lampa.PlayerVideo && Lampa.PlayerVideo.video && Lampa.PlayerVideo.video()) ||
                        document.querySelector('video.player-video__video, video');

            if (video && video.duration && !isNaN(video.duration) && video.duration > 0) {
                sought = true;
                try {
                    video.currentTime = target_sec;
                } catch (e) {}
                if (Lampa.PlayerVideo && Lampa.PlayerVideo.to) {
                    try {
                        Lampa.PlayerVideo.to(target_sec);
                    } catch (e) {}
                }
                return;
            }

            attempts++;
            if (attempts < max_attempts) {
                setTimeout(doSeek, 200);
            }
        }

        var interval = setInterval(function () {
            var video = (Lampa.PlayerVideo && Lampa.PlayerVideo.video && Lampa.PlayerVideo.video()) ||
                        document.querySelector('video.player-video__video, video');
            if (video) {
                clearInterval(interval);
                var onMetadata = function () {
                    video.removeEventListener('loadedmetadata', onMetadata);
                    video.removeEventListener('canplay', onMetadata);
                    setTimeout(doSeek, 100);
                };
                if (video.duration && !isNaN(video.duration) && video.duration > 0) {
                    doSeek();
                } else {
                    video.addEventListener('loadedmetadata', onMetadata);
                    video.addEventListener('canplay', onMetadata);
                    setTimeout(doSeek, 300);
                }
            } else if (attempts >= max_attempts) {
                clearInterval(interval);
            }
        }, 100);
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
        if (!files) return { map: {}, max: 'SD', default_url: '' };

        var map = {};
        var order = [
            { key: 'mp4_2160', name: '4K 2160p' },
            { key: 'mp4_1440', name: '2K 1440p' },
            { key: 'mp4_1080', name: '1080p' },
            { key: 'mp4_720',  name: '720p' },
            { key: 'mp4_480',  name: '480p' },
            { key: 'mp4_360',  name: '360p' },
            { key: 'mp4_240',  name: '240p' },
            { key: 'mp4_144',  name: '144p' }
        ];

        var max = '';
        var default_url = '';

        order.forEach(function (q) {
            if (files[q.key]) {
                map[q.name] = files[q.key];
                if (!max) {
                    max = q.name;
                    default_url = files[q.key];
                }
            }
        });

        return {
            map: map,
            max: max || 'SD',
            default_url: default_url
        };
    }

    // ==========================================
    // Шаблоны карточек Lampa
    // ==========================================
    var templates_inited = false;
    function initTemplates() {
        if (templates_inited) return;
        templates_inited = true;

        Lampa.Template.add('vk_item', `
            <div class="online selector">
                <div class="online__body">
                    <div style="position: absolute; left: 0.6em; top: 0.6em; width: 2em; height: 2em; display: flex; align-items: center; justify-content: center;">
                        <svg style="height: 1.8em; width: 1.8em;" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect width="24" height="24" rx="5" fill="#0077FF"/>
                            <path d="M12.67 17C7.63 17 4.75 13.54 4.63 7.8H7.16C7.24 11.99 9.1 13.77 10.57 14.13V7.8H12.96V11.41C14.42 11.25 15.93 9.61 16.45 7.8H18.84C18.44 10.04 16.78 11.68 15.6 12.37C16.78 12.92 18.68 14.33 19.38 17H16.75C16.2 15.29 14.83 13.97 12.96 13.78V17H12.67Z" fill="white"/>
                        </svg>
                    </div>
                    <div class="online__title" style="padding-left: 2.5em; font-size: 1.15em; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{title}</div>
                    <div class="online__quality" style="padding-left: 3.2em; font-size: 0.9em; opacity: 0.8; margin-top: 0.25em;">{quality}{info}</div>
                </div>
            </div>
        `);

        Lampa.Template.add('vk_folder', `
            <div class="online selector">
                <div class="online__body">
                    <div style="position: absolute; left: 0.6em; top: 0.6em; width: 2em; height: 2em; display: flex; align-items: center; justify-content: center;">
                        <svg style="height: 1.8em; width: 1.8em; fill: #0077FF;" viewBox="0 0 24 24">
                            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                        </svg>
                    </div>
                    <div class="online__title" style="padding-left: 2.5em; font-size: 1.2em; font-weight: 600;">{title}</div>
                    <div class="online__quality" style="padding-left: 3.2em; font-size: 0.9em; opacity: 0.7;">{info}</div>
                </div>
            </div>
        `);
    }

    // ==========================================
    // Компонент VK Video
    // ==========================================
    function VkComponent(object) {
        var _this = this;
        var movie = object.movie || {};
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var last_focused = null;

        var is_serial = Boolean(movie.number_of_seasons || movie.seasons || movie.first_air_date || movie.name);
        var total_seasons = movie.number_of_seasons || (movie.seasons ? movie.seasons.length : 1);
        if (total_seasons < 1) total_seasons = 1;

        var current_view = 'init';
        var current_season = 1;
        var episodes_all = [];
        var active_voice_filter = 'all';
        var voices_found = [];

        var container = $('<div class="vk-view" style="height: 100%; position: relative;"></div>');
        container.append(scroll.render());

        this.create = function () {
            initTemplates();
            _this.loading(true);

            if (is_serial) {
                if (total_seasons > 1) {
                    _this.renderSeasonsList();
                } else {
                    current_season = 1;
                    _this.loadSeasonEpisodes(1);
                }
            } else {
                _this.loadMovie();
            }

            return _this.render();
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
            _this.start();
        };

        // ------------------------------------------
        // Режим Сериала: Список сезонов
        // ------------------------------------------
        this.renderSeasonsList = function () {
            current_view = 'seasons';
            scroll.clear();
            _this.loading(false);

            for (var s = 1; s <= total_seasons; s++) {
                (function (season_num) {
                    var item = Lampa.Template.get('vk_folder', {
                        title: season_num + ' сезон',
                        info: (movie.name || movie.title) + ' • VK Видео'
                    });

                    item.on('hover:focus', function (e) {
                        last_focused = e.target;
                        scroll.update($(e.target), true);
                    });

                    item.on('hover:enter', function () {
                        current_season = season_num;
                        _this.loadSeasonEpisodes(season_num);
                    });

                    scroll.append(item);
                })(s);
            }

            _this.start();
        };

        // ------------------------------------------
        // Режим Сериала: Загрузка серий сезона
        // ------------------------------------------
        this.loadSeasonEpisodes = function (season_num) {
            current_view = 'episodes';
            current_season = season_num;
            _this.loading(true);
            scroll.clear();

            var search_title = cleanTitle(movie.name || movie.title);
            var queries = [
                search_title + ' ' + season_num + ' сезон',
                season_num === 1 ? (search_title + ' все серии') : (search_title + ' ' + season_num + ' сезон все серии')
            ];
            if (season_num === 1) {
                queries.push(search_title + ' 1 сезон все серии');
            }

            var pending = queries.length;
            var combined_videos = [];
            var seen_video_ids = {};
            var any_success = false;
            var last_err = null;

            function onQueriesFinished() {
                if (!any_success && combined_videos.length === 0) {
                    _this.empty('Не удалось загрузить видео из VK' + (last_err ? ' (' + last_err.message + ')' : ''));
                    return;
                }

                var episodes_map = {};
                var detected_voices = {};

                function processVideo(item) {
                    var v = item && item.video;
                    if (!v || !v.files) return;
                    if (NOISE_REG.test(v.title)) return;
                    if (v.duration < 300) return; // меньше 5 минут

                    var q_info = extractQualities(v.files);
                    if (!q_info.default_url) return;

                    var subs = [];
                    if (v.subtitles && v.subtitles.length > 0) {
                        v.subtitles.forEach(function (s) {
                            if (s && s.url) {
                                subs.push({
                                    label: s.title || s.manifest_name || s.lang || 'Субтитры',
                                    url: s.url
                                });
                            }
                        });
                    }

                    var segments = extractSegmentsFromVideo(v);

                    if (segments && segments.length > 1) {
                        // Проверяем, не для другого ли сезона этот сборник
                        var title_season = null;
                        var sm = v.title.match(/(?:(\d+)\s*(?:сезон|season|s))/i);
                        if (sm) title_season = parseInt(sm[1], 10);
                        if (title_season && title_season !== season_num) return;

                        var comp_voice = detectVoice(v.title) || detectVoice(v.description) || 'Оригинал / Залив';
                        if (comp_voice) detected_voices[comp_voice] = true;

                        segments.forEach(function (seg, seg_idx) {
                            var ep_num = parseEpisodeNum(seg.text, season_num) || (seg_idx + 1);
                            var seg_voice = detectVoice(seg.text) || comp_voice;
                            if (seg_voice) detected_voices[seg_voice] = true;

                            var seg_obj = {
                                episode: ep_num,
                                season: season_num,
                                title: v.title,
                                video_id: v.id,
                                duration: seg.duration,
                                voice: seg_voice,
                                qualities: q_info.map,
                                max_quality: q_info.max,
                                default_url: q_info.default_url,
                                subtitles: subs,
                                hash: Lampa.Utils.hash('vk_seg_' + (movie.id || search_title) + '_s' + season_num + 'e' + ep_num + '_' + v.id),
                                is_segmented: true,
                                start_time: seg.time,
                                segment_label: seg.text
                            };

                            if (!episodes_map[ep_num]) {
                                episodes_map[ep_num] = [];
                            }
                            episodes_map[ep_num].push(seg_obj);
                        });
                        return;
                    }

                    var ep_num = parseEpisodeNum(v.title, season_num);
                    if (!ep_num) return;

                    var voice = detectVoice(v.title) || detectVoice(v.description) || 'Оригинал / Залив';
                    if (voice) detected_voices[voice] = true;

                    var ep_obj = {
                        episode: ep_num,
                        season: season_num,
                        title: v.title,
                        video_id: v.id,
                        duration: v.duration,
                        voice: voice,
                        qualities: q_info.map,
                        max_quality: q_info.max,
                        default_url: q_info.default_url,
                        subtitles: subs,
                        hash: Lampa.Utils.hash('vk_' + (movie.id || search_title) + '_s' + season_num + 'e' + ep_num),
                        is_segmented: false,
                        start_time: 0,
                        segment_label: ''
                    };

                    if (!episodes_map[ep_num]) {
                        episodes_map[ep_num] = [];
                    }
                    episodes_map[ep_num].push(ep_obj);
                }

                combined_videos.forEach(processVideo);

                for (var ep_key in episodes_map) {
                    episodes_map[ep_key].sort(function (a, b) {
                        var qDiff = qualityScore(b.max_quality) - qualityScore(a.max_quality);
                        if (qDiff !== 0) return qDiff;
                        return (!a.is_segmented ? 1 : 0) - (!b.is_segmented ? 1 : 0);
                    });
                }

                episodes_all = [];
                for (var k in episodes_map) {
                    episodes_all.push(episodes_map[k]);
                }
                episodes_all.sort(function (a, b) {
                    return a[0].episode - b[0].episode;
                });

                voices_found = Object.keys(detected_voices);
                active_voice_filter = 'all';

                if (episodes_all.length === 0) {
                    _this.loadTargetedEpisode(search_title, season_num, 1);
                } else {
                    _this.renderEpisodesGrid();
                }
            }

            queries.forEach(function (q) {
                searchVk(q, function (videos) {
                    any_success = true;
                    if (Array.isArray(videos)) {
                        videos.forEach(function (item) {
                            var vid = item && item.video;
                            if (vid && vid.id && !seen_video_ids[vid.id]) {
                                seen_video_ids[vid.id] = true;
                                combined_videos.push(item);
                            }
                        });
                    }
                    pending--;
                    if (pending === 0) onQueriesFinished();
                }, function (err) {
                    last_err = err;
                    pending--;
                    if (pending === 0) onQueriesFinished();
                });
            });
        };

        // Точечный поиск
        this.loadTargetedEpisode = function (title, s, e) {
            var targeted_query = title + ' ' + s + ' сезон ' + e + ' серия';

            searchVk(targeted_query, function (videos) {
                var found = [];
                videos.forEach(function (item) {
                    var v = item && item.video;
                    if (v && v.files && !NOISE_REG.test(v.title) && v.duration >= 300) {
                        var q_info = extractQualities(v.files);
                        if (!q_info.default_url) return;

                        var segments = extractSegmentsFromVideo(v);
                        if (segments && segments.length > 1) {
                            segments.forEach(function (seg, seg_idx) {
                                var s_ep = parseEpisodeNum(seg.text, s) || (seg_idx + 1);
                                if (s_ep === e) {
                                    found.push([{
                                        episode: e,
                                        season: s,
                                        title: v.title,
                                        video_id: v.id,
                                        duration: seg.duration,
                                        voice: detectVoice(seg.text) || detectVoice(v.title) || 'По умолчанию',
                                        qualities: q_info.map,
                                        max_quality: q_info.max,
                                        default_url: q_info.default_url,
                                        subtitles: [],
                                        hash: Lampa.Utils.hash('vk_seg_' + (movie.id || title) + '_s' + s + 'e' + e + '_' + v.id),
                                        is_segmented: true,
                                        start_time: seg.time,
                                        segment_label: seg.text
                                    }]);
                                }
                            });
                            return;
                        }

                        var ep_num = parseEpisodeNum(v.title, s) || e;
                        found.push([{
                            episode: ep_num,
                            season: s,
                            title: v.title,
                            video_id: v.id,
                            duration: v.duration,
                            voice: detectVoice(v.title) || 'По умолчанию',
                            qualities: q_info.map,
                            max_quality: q_info.max,
                            default_url: q_info.default_url,
                            subtitles: [],
                            hash: Lampa.Utils.hash('vk_' + (movie.id || title) + '_s' + s + 'e' + ep_num),
                            is_segmented: false,
                            start_time: 0,
                            segment_label: ''
                        }]);
                    }
                });

                if (found.length > 0) {
                    episodes_all = found;
                    _this.renderEpisodesGrid();
                } else {
                    _this.empty('Серии для ' + s + ' сезона не найдены в VK Видео');
                }
            }, function () {
                _this.empty('Серии не найдены');
            });
        };

        // ------------------------------------------
        // Отрисовка списка серий + Фильтр озвучек
        // ------------------------------------------
        this.renderEpisodesGrid = function () {
            scroll.clear();
            _this.loading(false);

            if (total_seasons > 1) {
                var back_btn = Lampa.Template.get('vk_folder', {
                    title: '⬅ К списку сезонов',
                    info: 'Выбран ' + current_season + ' сезон'
                });
                back_btn.on('hover:focus', function (e) {
                    last_focused = e.target;
                    scroll.update($(e.target), true);
                });
                back_btn.on('hover:enter', function () {
                    _this.renderSeasonsList();
                });
                scroll.append(back_btn);
            }

            if (voices_found.length > 1) {
                var voice_label = active_voice_filter === 'all' ? 'Все / По умолчанию' : active_voice_filter;
                var voice_btn = $(`
                    <div class="online selector ruvk-voice-selector" style="background: rgba(0, 119, 255, 0.15); border: 1px solid rgba(0, 119, 255, 0.4); border-radius: 0.5em; margin: 0.5em 0.8em;">
                        <div class="online__body" style="padding: 0.8em 1em;">
                            <div class="online__title" style="font-weight: 600; font-size: 1.1em; color: #4da3ff;">🎙️ Озвучка: ${voice_label}</div>
                            <div class="online__quality" style="opacity: 0.8; font-size: 0.85em;">Нажмите для выбора другой студии перевода</div>
                        </div>
                    </div>
                `);

                voice_btn.on('hover:focus', function (e) {
                    last_focused = e.target;
                    scroll.update($(e.target), true);
                });

                voice_btn.on('hover:enter', function () {
                    var items = [{ title: 'Все / По умолчанию', voice: 'all', selected: active_voice_filter === 'all' }];
                    voices_found.forEach(function (v) {
                        items.push({ title: v, voice: v, selected: active_voice_filter === v });
                    });

                    Lampa.Select.show({
                        title: 'Выберите озвучку',
                        items: items,
                        onSelect: function (sel) {
                            active_voice_filter = sel.voice;
                            _this.renderEpisodesGrid();
                        },
                        onBack: function () {
                            _this.start();
                        }
                    });
                });

                scroll.append(voice_btn);
            }

            var display_episodes = [];
            episodes_all.forEach(function (variants) {
                var chosen = variants[0];
                if (active_voice_filter !== 'all') {
                    for (var i = 0; i < variants.length; i++) {
                        if (variants[i].voice === active_voice_filter) {
                            chosen = variants[i];
                            break;
                        }
                    }
                }
                display_episodes.push(chosen);
            });

            display_episodes.forEach(function (ep, index) {
                var ep_title = 'Серия ' + ep.episode;
                var badges = '<span style="background: #0077FF; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em;">' + ep.max_quality + '</span>';

                if (ep.is_segmented) {
                    badges += '<span style="background: #FF9800; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">⏱️ Таймкод</span>';
                }

                var clean_seg_text = (ep.segment_label || '').replace(/^(?:серия|эпизод|ep|e)?\s*\d+\s*[-—:.]?\s*/i, '').trim();
                var ep_sub = clean_seg_text ? ' (' + clean_seg_text + ')' : '';

                var ep_info_parts = [];
                if (ep.voice) ep_info_parts.push('[' + ep.voice + ']');
                if (ep.duration) ep_info_parts.push(formatTime(ep.duration));
                if (ep.is_segmented && ep.start_time > 0) {
                    ep_info_parts.push('(старт с ' + formatTimecode(ep.start_time) + ')');
                }

                var item = Lampa.Template.get('vk_item', {
                    title: ep_title + ep_sub + (ep.title ? ' — ' + ep.title : ''),
                    quality: badges,
                    info: ep_info_parts.join(' • ')
                });

                var timeline = Lampa.Timeline.view(ep.hash);
                if (timeline) {
                    item.find('.online__body').append(timeline);
                }

                item.on('hover:focus', function (e) {
                    last_focused = e.target;
                    scroll.update($(e.target), true);
                });

                item.on('hover:enter', function () {
                    _this.playVideo(ep, display_episodes, index);
                });

                scroll.append(item);
            });

            _this.start();
        };

        // ------------------------------------------
        // Режим Фильма: Поиск фильма в VK
        // ------------------------------------------
        this.loadMovie = function () {
            current_view = 'movies';
            _this.loading(true);
            scroll.clear();

            var search_title = cleanTitle(movie.title || movie.name);
            var year = (movie.release_date || movie.first_air_date || '').substring(0, 4);
            var query = search_title + (year ? ' ' + year : '');

            searchVk(query, function (videos) {
                var filtered = [];

                videos.forEach(function (item) {
                    var v = item && item.video;
                    if (!v || !v.files) return;
                    if (NOISE_REG.test(v.title)) return;
                    if (v.duration < 2400) return; // фильмы длиннее 40 минут

                    var q_info = extractQualities(v.files);
                    if (!q_info.default_url) return;

                    var subs = [];
                    if (v.subtitles) {
                        v.subtitles.forEach(function (s) {
                            if (s && s.url) subs.push({ label: s.title || s.lang || 'Субтитры', url: s.url });
                        });
                    }

                    var segments = extractSegmentsFromVideo(v);
                    var has_segments = segments && segments.length > 1;

                    filtered.push({
                        title: v.title,
                        video_id: v.id,
                        duration: v.duration,
                        qualities: q_info.map,
                        max_quality: q_info.max,
                        default_url: q_info.default_url,
                        subtitles: subs,
                        hash: Lampa.Utils.hash('vk_movie_' + (movie.id || search_title) + '_' + v.id),
                        has_segments: has_segments
                    });
                });

                if (filtered.length === 0) {
                    _this.empty('Фильм не найден в VK Видео');
                    return;
                }

                scroll.clear();
                _this.loading(false);

                filtered.forEach(function (m_item) {
                    var m_badges = '<span style="background: #0077FF; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em;">' + m_item.max_quality + '</span>';
                    if (m_item.has_segments) {
                        m_badges += '<span style="background: #FF9800; color: #fff; padding: 0.1em 0.4em; border-radius: 0.3em; margin-right: 0.4em; font-size: 0.85em; font-weight: 600;">⏱️ Таймкоды</span>';
                    }

                    var item = Lampa.Template.get('vk_item', {
                        title: m_item.title,
                        quality: m_badges,
                        info: formatTime(m_item.duration)
                    });

                    var timeline = Lampa.Timeline.view(m_item.hash);
                    if (timeline) item.find('.online__body').append(timeline);

                    item.on('hover:focus', function (e) {
                        last_focused = e.target;
                        scroll.update($(e.target), true);
                    });

                    item.on('hover:enter', function () {
                        _this.playVideo(m_item, null, 0);
                    });

                    scroll.append(item);
                });

                _this.start();
            }, function (err) {
                _this.empty('Ошибка поиска в VK Видео (' + err.message + ')');
            });
        };

        // ------------------------------------------
        // Воспроизведение через Lampa.Player
        // ------------------------------------------
        function prepareStreamUrl(url) {
            if (!url) return '';
            if (!Lampa.Platform.is('android') && url.indexOf('rte.net.ru') === -1) {
                return getProxy() + url;
            }
            return url;
        }

        var is_playing = false;
        this.playVideo = function (item, playlist_items, start_index) {
            if (is_playing) return;
            is_playing = true;
            setTimeout(function () { is_playing = false; }, 1500);

            fixPlayerCrossOrigin();

            var proxied_qualities = {};
            if (item.qualities) {
                for (var q in item.qualities) {
                    proxied_qualities[q] = prepareStreamUrl(item.qualities[q]);
                }
            }

            var player_item = {
                title: item.title,
                url: prepareStreamUrl(item.default_url),
                quality: proxied_qualities,
                timeline: {
                    hash: item.hash
                },
                start_time: item.start_time || 0
            };

            Lampa.Player.play(player_item);

            if (item.start_time && item.start_time > 0) {
                var tl = item.hash && Lampa.Timeline.view(item.hash);
                var target_sec = (tl && tl.percent && tl.time) ? tl.time : item.start_time;
                seekToStartTime(target_sec);
            }

            if (playlist_items && playlist_items.length > 1) {
                var playlist = playlist_items.map(function (elem) {
                    var elem_q = {};
                    if (elem.qualities) {
                        for (var eq in elem.qualities) {
                            elem_q[eq] = prepareStreamUrl(elem.qualities[eq]);
                        }
                    }
                    var p_title = 'Серия ' + elem.episode + (elem.is_segmented ? ' [Таймкод]' : '');
                    if (elem.segment_label && elem.segment_label !== 'Серия ' + elem.episode) {
                        p_title += ' (' + elem.segment_label + ')';
                    }
                    return {
                        title: p_title + (elem.title ? ' — ' + elem.title : ''),
                        url: prepareStreamUrl(elem.default_url),
                        quality: elem_q,
                        timeline: { hash: elem.hash },
                        start_time: elem.start_time || 0,
                        episode: elem.episode,
                        season: elem.season
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
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(last_focused || false, scroll.render());
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    Navigator.move('down');
                },
                right: function () {
                    if (Navigator.canmove('right')) Navigator.move('right');
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                back: function () {
                    if (current_view === 'episodes' && is_serial && total_seasons > 1) {
                        _this.renderSeasonsList();
                    } else {
                        Lampa.Activity.backward();
                    }
                }
            });

            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.render = function () { return container; };
        this.destroy = function () {
            scroll.destroy();
            container.remove();
        };
    }

    // ==========================================
    // Устранение CORS-блокировки видеоплеера
    // ==========================================
    function fixPlayerCrossOrigin() {
        if (!window.__ruvk_crossorigin_hooked) {
            window.__ruvk_crossorigin_hooked = true;

            var orig_setAttribute = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function (name, value) {
                if (name && typeof name === 'string' && name.toLowerCase() === 'crossorigin') {
                    if (this.tagName === 'VIDEO' || this.tagName === 'AUDIO') {
                        return;
                    }
                }
                return orig_setAttribute.apply(this, arguments);
            };

            try {
                if (window.HTMLMediaElement && HTMLMediaElement.prototype) {
                    Object.defineProperty(HTMLMediaElement.prototype, 'crossOrigin', {
                        get: function () { return null; },
                        set: function () { this.removeAttribute('crossorigin'); },
                        configurable: true
                    });

                    var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
                    if (desc && desc.set) {
                        var orig_src_set = desc.set;
                        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
                            get: desc.get,
                            set: function (val) {
                                this.removeAttribute('crossorigin');
                                this.crossOrigin = null;
                                orig_src_set.call(this, val);
                            },
                            configurable: true
                        });
                    }

                    var orig_load = HTMLMediaElement.prototype.load;
                    if (orig_load) {
                        HTMLMediaElement.prototype.load = function () {
                            this.removeAttribute('crossorigin');
                            this.crossOrigin = null;
                            return orig_load.apply(this, arguments);
                        };
                    }

                    var orig_play = HTMLMediaElement.prototype.play;
                    if (orig_play) {
                        HTMLMediaElement.prototype.play = function () {
                            this.removeAttribute('crossorigin');
                            this.crossOrigin = null;
                            return orig_play.apply(this, arguments);
                        };
                    }
                }
            } catch (e) {}

            if (window.Lampa && Lampa.PlayerVideo && Lampa.PlayerVideo.url) {
                var orig_pv_url = Lampa.PlayerVideo.url;
                Lampa.PlayerVideo.url = function (src, change_quality) {
                    var res = orig_pv_url.apply(this, arguments);
                    var v = (Lampa.PlayerVideo.video && Lampa.PlayerVideo.video()) || document.querySelector('video.player-video__video');
                    if (v) {
                        v.removeAttribute('crossorigin');
                        v.crossOrigin = null;
                    }
                    return res;
                };
            }
        }

        $('video.player-video__video, video').each(function () {
            this.removeAttribute('crossorigin');
            this.crossOrigin = null;
        });
    }

    // ==========================================
    // Регистрация плагина и кнопки в карточке Lampa
    // ==========================================
    function startPlugin() {
        initTemplates();
        fixPlayerCrossOrigin();

        Lampa.Listener.follow('player', function () {
            fixPlayerCrossOrigin();
        });

        if (Lampa.Player && Lampa.Player.listener && Lampa.Player.listener.follow) {
            Lampa.Player.listener.follow('start', function (data) {
                fixPlayerCrossOrigin();
                if (data && data.start_time && data.start_time > 0) {
                    var tl = data.timeline && data.timeline.hash && Lampa.Timeline.view(data.timeline.hash);
                    var target_sec = (tl && tl.percent && tl.time) ? tl.time : data.start_time;
                    seekToStartTime(target_sec);
                }
            });
        }

        Lampa.Component.add('vk_view', VkComponent);

        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') {
                var card = e.object;
                var movie = card.movie || (e.data && e.data.movie);
                if (!movie) return;

                var render = card.activity.render();
                if (render.find('.view--vk').length > 0) return;

                var btn = $(`
                    <div class="full-start__button selector view--vk" data-subtitle="Онлайн" style="cursor: pointer;">
                        <svg style="width: 1.5em; height: 1.5em; margin-right: 0.4em;" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect width="24" height="24" rx="5" fill="#0077FF"/>
                            <path d="M12.67 17C7.63 17 4.75 13.54 4.63 7.8H7.16C7.24 11.99 9.1 13.77 10.57 14.13V7.8H12.96V11.41C14.42 11.25 15.93 9.61 16.45 7.8H18.84C18.44 10.04 16.78 11.68 15.6 12.37C16.78 12.92 18.68 14.33 19.38 17H16.75C16.2 15.29 14.83 13.97 12.96 13.78V17H12.67Z" fill="white"/>
                        </svg>
                        <span>VK Видео</span>
                    </div>
                `);

                btn.on('hover:enter click', function () {
                    Lampa.Activity.push({
                        url: '',
                        title: 'VK: ' + (movie.title || movie.name),
                        component: 'vk_view',
                        movie: movie,
                        page: 1
                    });
                });

                var buttons_bar = render.find('.full-start-new__buttons, .full-start__buttons');
                var after_target = buttons_bar.find('.view--rutube, .view--torrent, .view--online').last();

                if (after_target.length > 0) {
                    after_target.after(btn);
                } else if (buttons_bar.length > 0) {
                    buttons_bar.append(btn);
                } else {
                    render.find('.full-start__details, .full-start-new__details').after(btn);
                }
            }
        });

        if (Lampa.Manifest && Lampa.Manifest.add) {
            Lampa.Manifest.add({
                type: 'video',
                version: '1.0.0',
                name: 'VK Видео',
                description: 'Онлайн просмотр фильмов и сериалов из VK Видео',
                component: 'vk_view'
            });
        }
    }

    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') startPlugin();
        });
    }
})();
