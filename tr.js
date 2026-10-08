(function () {
  'use strict';

  if (window.tr_plugin) return;
  window.tr_plugin = true;

  var PLUGIN_NAME = 'Торренты';
  var PLUGIN_VERSION = '1.0.0';
  var COMPONENT_NAME = 'tr';
  var REQUEST_TIMEOUT = 10000;
  var BALANCER_TIMEOUT = 60000;

  var Defined = {
    api: 'lampac',
    localhost: 'https://akter-black.com/',
    apn: ''
  };

  var unic_id = Lampa.Storage.get('lampac_unic_id', '');
  if (!unic_id) {
    unic_id = Lampa.Utils.uid(8).toLowerCase();
    Lampa.Storage.set('lampac_unic_id', unic_id);
  }

  function account(url) {
    url = url + '';
    if (url.indexOf('account_email=') == -1) {
      var email = Lampa.Storage.get('account_email');
      if (email) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));
    }
    if (url.indexOf('uid=') == -1) {
      var uid = Lampa.Storage.get('lampac_unic_id', '');
      if (uid) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid));
    }
    if (url.indexOf('token=') == -1) {
      var token = '';
      if (token != '') url = Lampa.Utils.addUrlComponent(url, 'token=');
    }
    if (url.indexOf('ab_token=') == -1) {
      var ab_token = Lampa.Storage.get('token', '');
      if (ab_token) url = Lampa.Utils.addUrlComponent(url, 'ab_token=' + encodeURIComponent(ab_token));
    }
    if (url.indexOf('nws_id=') == -1) {
      var nws_id = Lampa.Storage.get('lampac_nws_id', '');
      if (nws_id) url = Lampa.Utils.addUrlComponent(url, 'nws_id=' + encodeURIComponent(nws_id));
    }
    return url;
  }

  function addHeaders() {
    var kit_aesgcmkey = Lampa.Storage.get('kit_aesgcmkey', '');
    var headers = {
      'X-Lampac-Version': '1.8.0'
    };
    if (kit_aesgcmkey) headers['X-Kit-AesGcm'] = kit_aesgcmkey;
    return headers;
  }

  function formatEpisodeNumber(episodeNumber) {
    return (episodeNumber < 10 ? '0' : '') + episodeNumber;
  }

  function extractTorrentLinkInfo(url) {
    if (!url) return { hash: '', magnet: '' };
    var m = url.match(/pidtor\/(?:serial\/)?s?([a-fA-F0-9]{40})/);
    var hash = m ? m[1].toLowerCase() : '';
    var trackers = [];
    var trRegex = /tr=([^&]+)/g;
    var trMatch;
    while ((trMatch = trRegex.exec(url)) !== null) {
      trackers.push(trMatch[0]);
    }
    var magnet = '';
    if (hash) {
      magnet = 'magnet:?xt=urn:btih:' + hash;
      if (trackers.length) {
        magnet += '&' + trackers.join('&');
      }
    }
    return { hash: hash, magnet: magnet };
  }

  var Network = Lampa.Reguest;

  function component(object) {
    var network = new Network();
    network.timeout(BALANCER_TIMEOUT);
    var scroll = new Lampa.Scroll({
      mask: true,
      over: true
    });
    var files = new Lampa.Explorer(object);
    var filter = new Lampa.Filter(object);
    var sources = {};
    var last;
    var source;
    var balanser = 'pidtor';
    var initialized;
    var images = [];
    var number_of_requests = 0;
    var number_of_requests_timer;
    var filter_sources = ['pidtor'];
    var filter_translate = {
      season: Lampa.Lang.translate('torrent_serial_season'),
      voice: Lampa.Lang.translate('torrent_parser_voice'),
      source: Lampa.Lang.translate('settings_rest_source')
    };
    var filter_find = {
      season: [],
      voice: []
    };

    function clarificationSearchAdd(value) {
      var id = Lampa.Utils.hash(
        object.movie.number_of_seasons ? object.movie.original_name : object.movie.original_title
      );
      var all = Lampa.Storage.get('clarification_search', '{}');
      all[id] = value;
      Lampa.Storage.set('clarification_search', all);
    }

    function clarificationSearchDelete() {
      var id = Lampa.Utils.hash(
        object.movie.number_of_seasons ? object.movie.original_name : object.movie.original_title
      );
      var all = Lampa.Storage.get('clarification_search', '{}');
      delete all[id];
      Lampa.Storage.set('clarification_search', all);
    }

    this.initialize = function () {
      var _this = this;
      this.loading(true);
      filter.onSearch = function (value) {
        clarificationSearchAdd(value);
        Lampa.Activity.replace({
          search: value,
          clarification: true,
          similar: true
        });
      };
      filter.onBack = function () {
        _this.start();
      };
      filter.render().find('.filter--search').appendTo(filter.render().find('.torrent-filter'));
      filter.onSelect = function (type, a, b) {
        if (type == 'filter') {
          if (a.reset) {
            clarificationSearchDelete();
            _this.replaceChoice({
              season: 0,
              voice: 0,
              voice_url: '',
              voice_name: ''
            });
            setTimeout(function () {
              Lampa.Select.close();
              Lampa.Activity.replace({
                clarification: 0,
                similar: 0
              });
            }, 10);
          } else {
            var url = filter_find[a.stype][b.index].url;
            var choice = _this.getChoice();
            if (a.stype == 'voice') {
              choice.voice_name = filter_find.voice[b.index].title;
              choice.voice_url = url;
            }
            choice[a.stype] = b.index;
            _this.saveChoice(choice);
            _this.reset();
            _this.request(url);
            setTimeout(Lampa.Select.close, 10);
          }
        }
      };
      if (filter.addButtonBack) filter.addButtonBack();
      scroll.body().addClass('torrent-list');
      files.appendFiles(scroll.render());
      files.appendHead(filter.render());
      scroll.minus(files.render().find('.explorer__files-head'));
      scroll.body().append(Lampa.Template.get('tr_content_loading'));
      filter.render().find('.filter--sort').addClass('hide');
      Lampa.Controller.enable('content');
      this.loading(false);

      this.externalids()
        .then(function () {
          source = Defined.localhost + 'lite/pidtor';
          balanser = 'pidtor';
          sources = { pidtor: { name: PLUGIN_NAME, url: source, show: true } };
          filter_sources = ['pidtor'];
          _this.search();
        })
        ['catch'](function (e) {
          _this.noConnectToServer(e);
        });
    };

    this.externalids = function () {
      return new Promise(function (resolve) {
        if (!object.movie.imdb_id || !object.movie.kinopoisk_id) {
          var query = [];
          query.push('id=' + encodeURIComponent(object.movie.id));
          query.push('serial=' + (object.movie.name ? 1 : 0));
          if (object.movie.imdb_id) query.push('imdb_id=' + (object.movie.imdb_id || ''));
          if (object.movie.kinopoisk_id) query.push('kinopoisk_id=' + (object.movie.kinopoisk_id || ''));
          var url = Defined.localhost + 'externalids?' + query.join('&');
          network.timeout(REQUEST_TIMEOUT);
          network.silent(
            account(url),
            function (json) {
              if (json && typeof json === 'object') {
                for (var name in json) {
                  object.movie[name] = json[name];
                }
              }
              resolve();
            },
            function () {
              resolve();
            },
            false,
            {
              headers: addHeaders()
            }
          );
        } else resolve();
      });
    };

    this.requestParams = function (url) {
      var query = [];
      var card_source = object.movie.source || 'tmdb';
      query.push('id=' + encodeURIComponent(object.movie.id));

      if (object.movie.imdb_id) query.push('imdb_id=' + (object.movie.imdb_id || ''));
      if (object.movie.kinopoisk_id) query.push('kinopoisk_id=' + (object.movie.kinopoisk_id || ''));
      if (object.movie.tmdb_id) query.push('tmdb_id=' + (object.movie.tmdb_id || ''));

      if (object.movie.keywords && object.movie.keywords.results) {
        for (var i = 0, a = object.movie.keywords.results; i < a.length; i++) {
          if (a[i].name == 'anime') {
            query.push('anime=1');
            break;
          }
        }
      }

      query.push(
        'title=' + encodeURIComponent(object.clarification ? object.search : object.movie.title || object.movie.name)
      );
      query.push('original_title=' + encodeURIComponent(object.movie.original_title || object.movie.original_name));
      query.push('serial=' + (object.movie.name ? 1 : 0));
      query.push('original_language=' + (object.movie.original_language || ''));
      query.push('year=' + ((object.movie.release_date || object.movie.first_air_date || '0000') + '').slice(0, 4));
      query.push('source=' + card_source);
      query.push('clarification=' + (object.clarification ? 1 : 0));
      query.push('similar=' + (object.similar ? true : false));
      if (Lampa.Storage.get('account_email', ''))
        query.push('cub_id=' + Lampa.Utils.hash(Lampa.Storage.get('account_email', '')));
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + query.join('&');
    };

    this.create = function () {
      return this.render();
    };

    this.search = function () {
      this.filter(
        {
          source: filter_sources
        },
        this.getChoice()
      );
      this.find();
    };

    this.find = function () {
      this.request(this.requestParams(source));
    };

    this.request = function (url) {
      number_of_requests++;
      if (number_of_requests < 10) {
        network['native'](account(url), this.parse.bind(this), this.doesNotAnswer.bind(this), false, {
          dataType: 'text',
          headers: addHeaders()
        });
        clearTimeout(number_of_requests_timer);
        number_of_requests_timer = setTimeout(function () {
          number_of_requests = 0;
        }, 4000);
      } else this.empty();
    };

    this.parseJsonDate = function (str, name) {
      try {
        var html = $('<div>' + str + '</div>');
        var elems = [];
        html.find(name).each(function () {
          var item = $(this);
          var raw = item.attr('data-json');
          if (!raw) return;
          var data;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            return;
          }
          var season = item.attr('s');
          var episode = item.attr('e');
          var text = item.text();
          if (!object.movie.name) {
            if (text.match(/\d+p/i)) {
              if (!data.quality) {
                data.quality = {};
                data.quality[text] = data.url;
              }
              text = object.movie.title;
            }
            if (text == 'По умолчанию') {
              text = object.movie.title;
            }
          }
          if (episode) data.episode = parseInt(episode);
          if (season) data.season = parseInt(season);
          if (text) data.text = text;
          data.active = item.hasClass('active');
          elems.push(data);
        });
        return elems;
      } catch (e) {
        return [];
      }
    };

    this.getFileUrl = function (file, call) {
      if (file.method == 'play') {
        call(file, {});
      } else {
        call(false, {});
      }
    };

    this.toPlayElement = function (file) {
      var play = {
        title: file.title,
        url: file.url,
        quality: file.qualitys,
        timeline: file.timeline,
        subtitles: file.subtitles,
        segments: file.segments,
        callback: file.mark,
        season: file.season,
        episode: file.episode,
        voice_name: file.voice_name,
        thumbnail: file.thumbnail
      };
      return play;
    };

    this.orUrlReserve = function (data) {
      if (data.url && typeof data.url == 'string' && data.url.indexOf(' or ') !== -1) {
        var urls = data.url.split(' or ');
        data.url = urls[0];
        data.url_reserve = urls[1];
      }
    };

    this.setDefaultQuality = function (data) {
      if (Lampa.Arrays.getKeys(data.quality).length) {
        for (var q in data.quality) {
          if (parseInt(q) == Lampa.Storage.field('video_quality_default')) {
            data.url = data.quality[q];
            this.orUrlReserve(data);
          }
          if (data.quality[q].indexOf(' or ') !== -1) data.quality[q] = data.quality[q].split(' or ')[0];
        }
      }
    };

    this.display = function (videos) {
      var _this5 = this;
      this.draw(videos, {
        onEnter: function onEnter(item) {
          _this5.getFileUrl(
            item,
            function (json, json_call) {
              if (json && json.url) {
                var playlist = [];
                var first = _this5.toPlayElement(item);
                first.url = json.url;
                first.headers = json_call.headers || json.headers;
                first.quality = json_call.quality || item.qualitys;
                first.segments = json_call.segments || item.segments;
                first.subtitles = json.subtitles;
                _this5.orUrlReserve(first);
                _this5.setDefaultQuality(first);

                if (item.season) {
                  videos.forEach(function (elem) {
                    var cell = _this5.toPlayElement(elem);
                    cell.url = elem.url;
                    _this5.orUrlReserve(cell);
                    _this5.setDefaultQuality(cell);
                    playlist.push(cell);
                  });
                } else {
                  playlist.push(first);
                }

                if (playlist.length > 1) first.playlist = playlist;
                if (first.url) {
                  var element = first;
                  element.isonline = true;
                  Lampa.Player.play(element);
                  Lampa.Player.playlist(playlist);
                  item.mark();
                } else {
                  Lampa.Noty.show('Ссылка недоступна');
                }
              } else Lampa.Noty.show('Ссылка недоступна');
            }
          );
        },
        onContextMenu: function onContextMenu(item, html, data, call) {
          _this5.getFileUrl(
            item,
            function (stream) {
              call({
                file: stream.url,
                quality: item.qualitys
              });
            }
          );
        }
      });
      this.filter(
        {
          season: filter_find.season.map(function (s) {
            return s.title;
          }),
          voice: filter_find.voice.map(function (b) {
            return b.title;
          })
        },
        this.getChoice()
      );
    };

    this.parse = function (str) {
      try {
        var items = this.parseJsonDate(str, '.videos__item');
        var buttons = this.parseJsonDate(str, '.videos__button');
        if (items.length == 1 && items[0].method == 'link' && !items[0].similar) {
          filter_find.season = items.map(function (s) {
            return {
              title: s.text,
              url: s.url
            };
          });
          this.replaceChoice({
            season: 0
          });
          this.request(items[0].url);
        } else {
          this.loading(false);
          var videos = items.filter(function (v) {
            return v.method == 'play' || v.method == 'call';
          });
          var similar = items.filter(function (v) {
            return v.similar;
          });
          if (videos.length) {
            if (buttons.length) {
              filter_find.voice = buttons.map(function (b) {
                return {
                  title: b.text,
                  url: b.url
                };
              });
              var select_voice_url = this.getChoice(balanser).voice_url;
              var select_voice_name = this.getChoice(balanser).voice_name;
              var find_voice_url = buttons.find(function (v) {
                return v.url == select_voice_url;
              });
              var find_voice_name = buttons.find(function (v) {
                return v.text == select_voice_name;
              });
              var find_voice_active = buttons.find(function (v) {
                return v.active;
              });
              if (find_voice_url && !find_voice_url.active) {
                this.replaceChoice({
                  voice: buttons.indexOf(find_voice_url),
                  voice_name: find_voice_url.text
                });
                this.request(find_voice_url.url);
              } else if (find_voice_name && !find_voice_name.active) {
                this.replaceChoice({
                  voice: buttons.indexOf(find_voice_name),
                  voice_name: find_voice_name.text
                });
                this.request(find_voice_name.url);
              } else {
                if (find_voice_active) {
                  this.replaceChoice({
                    voice: buttons.indexOf(find_voice_active),
                    voice_name: find_voice_active.text
                  });
                }
                this.display(videos);
              }
            } else {
              this.replaceChoice({
                voice: 0,
                voice_url: '',
                voice_name: ''
              });
              this.display(videos);
            }
          } else if (items.length) {
            if (similar.length) {
              this.similars(similar);
              this.loading(false);
            } else {
              filter_find.season = items.map(function (s) {
                return {
                  title: s.text,
                  url: s.url
                };
              });
              var select_season = this.getChoice(balanser).season;
              var season = filter_find.season[select_season];
              if (!season) season = filter_find.season[0];
              this.request(season.url);
            }
          } else {
            this.doesNotAnswer();
          }
        }
      } catch (e) {
        this.doesNotAnswer(e);
      }
    };

    this.similars = function (json) {
      var _this6 = this;
      scroll.clear();
      json.forEach(function (elem) {
        elem.title = elem.text;
        elem.info = '';
        var info = [];
        var year = (
          (elem.start_date || elem.year || object.movie.release_date || object.movie.first_air_date || '') + ''
        ).slice(0, 4);
        if (year) info.push(year);
        if (elem.details) info.push(elem.details);
        var name = elem.title || elem.text;
        elem.title = name;
        elem.time = elem.time || '';
        elem.info = info.join('<span class="online-prestige-split">●</span>');
        var item = Lampa.Template.get('tr_prestige_folder', elem);
        if (elem.img) {
          var image = $('<img style="height: 7em; width: 7em; border-radius: 0.3em;"/>');
          item.find('.online-prestige__folder').empty().append(image);
          if (elem.img !== undefined) {
            if (elem.img.charAt(0) === '/') elem.img = Defined.localhost + elem.img.substring(1);
            if (elem.img.indexOf('/proxyimg') !== -1) elem.img = account(elem.img);
          }
          Lampa.Utils.imgLoad(image, elem.img);
        }
        item
          .on('hover:enter', function () {
            _this6.reset();
            _this6.request(elem.url);
          })
          .on('hover:focus', function (e) {
            last = e.target;
            scroll.update($(e.target), true);
          });
        scroll.append(item);
      });
      this.filter(
        {
          season: filter_find.season.map(function (s) {
            return s.title;
          }),
          voice: filter_find.voice.map(function (b) {
            return b.title;
          })
        },
        this.getChoice()
      );
      Lampa.Controller.enable('content');
    };

    this.getChoice = function (for_balanser) {
      var data = Lampa.Storage.cache('tr_choice_' + (for_balanser || balanser), 3000, {});
      var save = data[object.movie.id] || {};
      Lampa.Arrays.extend(save, {
        season: 0,
        voice: 0,
        voice_name: '',
        voice_id: 0,
        episodes_view: {},
        movie_view: ''
      });
      return save;
    };

    this.saveChoice = function (choice, for_balanser) {
      var data = Lampa.Storage.cache('tr_choice_' + (for_balanser || balanser), 3000, {});
      data[object.movie.id] = choice;
      Lampa.Storage.set('tr_choice_' + (for_balanser || balanser), data);
    };

    this.replaceChoice = function (choice, for_balanser) {
      var to = this.getChoice(for_balanser);
      Lampa.Arrays.extend(to, choice, true);
      this.saveChoice(to, for_balanser);
    };

    this.clearImages = function () {
      images.forEach(function (img) {
        img.onerror = function () {};
        img.onload = function () {};
        img.src = '';
      });
      images = [];
    };

    this.reset = function () {
      last = false;
      network.clear();
      this.clearImages();
      scroll.render().find('.empty').remove();
      scroll.clear();
      scroll.reset();
      scroll.body().append(Lampa.Template.get('tr_content_loading'));
    };

    this.loading = function (status) {
      try {
        if (this.activity && this.activity.loader) this.activity.loader(status);
        else if (status) Lampa.Loading.start(function () {});
        else Lampa.Loading.stop();
      } catch (e) {}
    };

    this.filter = function (filter_items, choice) {
      var _this7 = this;
      var select = [];
      var add = function add(type, title) {
        var need = _this7.getChoice();
        var items = filter_items[type];
        var subitems = [];
        var value = need[type];
        items.forEach(function (name, i) {
          subitems.push({
            title: name,
            selected: value == i,
            index: i
          });
        });
        select.push({
          title: title,
          subtitle: items[value],
          items: subitems,
          stype: type
        });
      };
      filter_items.source = filter_sources;
      select.push({
        title: Lampa.Lang.translate('torrent_parser_reset'),
        reset: true
      });
      this.saveChoice(choice);
      if (filter_items.voice && filter_items.voice.length) add('voice', Lampa.Lang.translate('torrent_parser_voice'));
      if (filter_items.season && filter_items.season.length)
        add('season', Lampa.Lang.translate('torrent_serial_season'));
      filter.set('filter', select);
      this.selected(filter_items);
    };

    this.selected = function (filter_items) {
      var need = this.getChoice(),
        select = [];
      for (var i in need) {
        if (filter_items[i] && filter_items[i].length) {
          if (i == 'voice') {
            select.push(filter_translate[i] + ': ' + filter_items[i][need[i]]);
          } else if (i !== 'source') {
            if (filter_items.season.length >= 1) {
              select.push(filter_translate.season + ': ' + filter_items[i][need[i]]);
            }
          }
        }
      }
      filter.chosen('filter', select);
    };

    this.getEpisodes = function (season, call) {
      var episodes = [];
      var tmdb_id = object.movie.id;
      if (['cub', 'tmdb'].indexOf(object.movie.source || 'tmdb') == -1) tmdb_id = object.movie.tmdb_id;
      if (typeof tmdb_id == 'number' && object.movie.name) {
        Lampa.Api.sources.tmdb.get(
          'tv/' + tmdb_id + '/season/' + season,
          {},
          function (data) {
            episodes = data.episodes || [];
            call(episodes);
          },
          function () {
            call(episodes);
          }
        );
      } else call(episodes);
    };

    this.watched = function (set) {
      var file_id = Lampa.Utils.hash(
        object.movie.number_of_seasons ? object.movie.original_name : object.movie.original_title
      );
      var watched = Lampa.Storage.cache('tr_watched_last', 5000, {});
      if (set) {
        if (!watched[file_id]) watched[file_id] = {};
        Lampa.Arrays.extend(watched[file_id], set, true);
        Lampa.Storage.set('tr_watched_last', watched);
        this.updateWatched();
      } else {
        return watched[file_id];
      }
    };

    this.updateWatched = function () {
      var watched = this.watched();
      var body = scroll.body().find('.online-prestige-watched .online-prestige-watched__body').empty();
      if (watched) {
        var line = [];
        if (watched.voice_name) line.push(watched.voice_name);
        if (watched.season) line.push(Lampa.Lang.translate('torrent_serial_season') + ' ' + watched.season);
        if (watched.episode) line.push(Lampa.Lang.translate('torrent_serial_episode') + ' ' + watched.episode);
        line.forEach(function (n) {
          body.append('<span>' + n + '</span>');
        });
      } else body.append('<span>' + Lampa.Lang.translate('lampac_no_watch_history') + '</span>');
    };

    this.draw = function (items) {
      var _this8 = this;
      var params = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
      if (!items.length) return this.empty();
      scroll.clear();
      scroll.append(Lampa.Template.get('tr_prestige_watched', {}));
      this.updateWatched();
      this.getEpisodes(items[0].season, function (episodes) {
        var viewed = Lampa.Storage.cache('online_view', 5000, []);
        var serial = object.movie.name ? true : false;
        var choice = _this8.getChoice();
        var fully = window.innerWidth > 480;
        var scroll_to_element = false;
        var scroll_to_mark = false;

        items.forEach(function (element, index) {
          var episode =
            serial && episodes.length && !params.similars
              ? episodes.find(function (e) {
                return e.episode_number == element.episode;
              })
              : false;
          var episode_num = element.episode || index + 1;
          var episode_last = choice.episodes_view[element.season];
          var voice_name =
            choice.voice_name ||
            (filter_find.voice[0] ? filter_find.voice[0].title : false) ||
            element.voice_name ||
            (serial ? 'Неизвестно' : element.text) ||
            'Неизвестно';
          if (element.quality) {
            element.qualitys = element.quality;
            element.quality = Lampa.Arrays.getKeys(element.quality)[0];
          }
          Lampa.Arrays.extend(element, {
            voice_name: voice_name,
            info: voice_name.length > 60 ? voice_name.substr(0, 60) + '...' : voice_name,
            quality: element.maxquality ? element.maxquality + 'p' : '',
            time: Lampa.Utils.secondsToTime((episode ? episode.runtime : object.movie.runtime) * 60, true)
          });
          var hash_timeline = Lampa.Utils.hash(
            element.season
              ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title].join('')
              : object.movie.original_title
          );
          var hash_behold = Lampa.Utils.hash(
            element.season
              ? [
                element.season,
                element.season > 10 ? ':' : '',
                element.episode,
                object.movie.original_title,
                element.voice_name
              ].join('')
              : object.movie.original_title + element.voice_name
          );
          var data = {
            hash_timeline: hash_timeline,
            hash_behold: hash_behold
          };
          var info = [];
          if (element.season) {
            element.translate_episode_end = _this8.getLastEpisode(items);
            element.translate_voice = element.voice_name;
          }
          if (element.text && !episode) element.title = element.text;
          element.timeline = Lampa.Timeline.view(hash_timeline);
          if (episode) {
            element.title = episode.name;
            if (element.info.length < 30 && episode.vote_average)
              info.push(
                Lampa.Template.get(
                  'tr_prestige_rate',
                  {
                    rate: parseFloat(episode.vote_average + '').toFixed(1)
                  },
                  true
                )
              );
            if (episode.air_date && fully) info.push(Lampa.Utils.parseTime(episode.air_date).full);
          } else if (object.movie.release_date && fully) {
            info.push(Lampa.Utils.parseTime(object.movie.release_date).full);
          }
          if (!serial && object.movie.tagline && element.info.length < 30) info.push(object.movie.tagline);
          if (element.info) info.push(element.info);
          if (info.length)
            element.info = info
              .map(function (i) {
                return '<span>' + i + '</span>';
              })
              .join('<span class="online-prestige-split">●</span>');
          var html = Lampa.Template.get('tr_prestige_full', element);
          var loader = html.find('.online-prestige__loader');
          var image = html.find('.online-prestige__img');
          if (!serial) {
            if (choice.movie_view == hash_behold) scroll_to_element = html;
          } else if (typeof episode_last !== 'undefined' && episode_last == episode_num) {
            scroll_to_element = html;
          }
          if (serial && !episode) {
            image.append(
              '<div class="online-prestige__episode-number">' +
              formatEpisodeNumber(element.episode || index + 1) +
              '</div>'
            );
            loader.remove();
          } else if (!serial && object.movie.backdrop_path == 'undefined') loader.remove();
          else {
            var img = html.find('img')[0];
            img.onerror = function () {
              img.src = './img/img_broken.svg';
            };
            img.onload = function () {
              image.addClass('online-prestige__img--loaded');
              loader.remove();
              if (serial)
                image.append(
                  '<div class="online-prestige__episode-number">' +
                  formatEpisodeNumber(element.episode || index + 1) +
                  '</div>'
                );
            };
            img.src = Lampa.TMDB.image('t/p/w300' + (episode ? episode.still_path : object.movie.backdrop_path));
            images.push(img);
            element.thumbnail = img.src;
          }
          html.find('.online-prestige__timeline').append(Lampa.Timeline.render(element.timeline));
          if (viewed.indexOf(hash_behold) !== -1) {
            scroll_to_mark = html;
            html
              .find('.online-prestige__img')
              .append('<div class="online-prestige__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
          }
          element.mark = function () {
            viewed = Lampa.Storage.cache('online_view', 5000, []);
            if (viewed.indexOf(hash_behold) == -1) {
              viewed.push(hash_behold);
              Lampa.Storage.set('online_view', viewed);
              if (html.find('.online-prestige__viewed').length == 0) {
                html
                  .find('.online-prestige__img')
                  .append('<div class="online-prestige__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
              }
            }
            var voice_name_text = voice_name;
            if (element.season) voice_name_text = choice.voice_name;
            _this8.watched({
              balanser_name: PLUGIN_NAME,
              voice_id: choice.voice_id,
              voice_name: voice_name_text,
              episode: element.episode,
              season: element.season
            });
          };
          element.unmark = function () {
            viewed = Lampa.Storage.cache('online_view', 5000, []);
            if (viewed.indexOf(hash_behold) !== -1) {
              Lampa.Arrays.remove(viewed, hash_behold);
              Lampa.Storage.set('online_view', viewed);
              Lampa.Storage.remove('online_view', hash_behold);
              html.find('.online-prestige__viewed').remove();
            }
          };
          element.timeclear = function () {
            element.timeline.percent = 0;
            element.timeline.time = 0;
            element.timeline.duration = 0;
            Lampa.Timeline.update(element.timeline);
          };
          html
            .on('hover:enter', function () {
              if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
              if (params.onEnter) params.onEnter(element, html, data);
            })
            .on('hover:focus', function (e) {
              last = e.target;
              if (params.onFocus) params.onFocus(element, html, data);
              scroll.update($(e.target), true);
            });
          if (params.onRender) params.onRender(element, html, data);
          _this8.contextMenu({
            html: html,
            element: element,
            onFile: function onFile(call) {
              if (params.onContextMenu) params.onContextMenu(element, html, data, call);
            },
            onClearAllMark: function onClearAllMark() {
              items.forEach(function (elem) {
                elem.unmark();
              });
            },
            onClearAllTime: function onClearAllTime() {
              items.forEach(function (elem) {
                elem.timeclear();
              });
            }
          });
          scroll.append(html);
        });

        if (scroll_to_element) {
          last = scroll_to_element[0];
        } else if (scroll_to_mark) {
          last = scroll_to_mark[0];
        }
        Lampa.Controller.enable('content');
      });
    };

    this.contextMenu = function (params) {
      params.html.on('hover:long', function () {
        function show(extra) {
          var enabled = Lampa.Controller.enabled().name;
          var linkInfo = extractTorrentLinkInfo(extra && extra.file ? extra.file : params.element.url);
          var menu = [];

          menu.push({
            title: Lampa.Lang.translate('player_lauch') + ' - Lampa',
            player: 'lampa'
          });

          if (linkInfo.hash) {
            var torrserverUrl = Lampa.Storage.get('torrserver_url') || Lampa.Storage.get('torrserver_url_two') || '';
            if (torrserverUrl) {
              menu.push({
                title: 'Воспроизвести через TorrServer',
                torrserver: true
              });
            }

            menu.push({
              title: 'Копировать magnet-ссылку',
              copymagnet: true
            });

            menu.push({
              title: 'Копировать хеш торрента',
              copyhash: true
            });
          }

          if (extra) {
            menu.push({
              title: Lampa.Lang.translate('copy_link'),
              copylink: true
            });
          }

          menu.push({
            title: Lampa.Lang.translate('torrent_parser_label_title'),
            mark: true
          });
          menu.push({
            title: Lampa.Lang.translate('torrent_parser_label_cancel_title'),
            unmark: true
          });
          menu.push({
            title: Lampa.Lang.translate('time_reset'),
            timeclear: true
          });

          Lampa.Select.show({
            title: Lampa.Lang.translate('title_action'),
            items: menu,
            onBack: function onBack() {
              Lampa.Controller.toggle(enabled);
            },
            onSelect: function onSelect(a) {
              if (a.mark) params.element.mark();
              if (a.unmark) params.element.unmark();
              if (a.timeclear) params.element.timeclear();
              if (a.clearallmark) params.onClearAllMark();
              if (a.timeclearall) params.onClearAllTime();
              Lampa.Controller.toggle(enabled);

              if (a.torrserver && linkInfo.hash) {
                var tsUrl = (Lampa.Storage.get('torrserver_url') || Lampa.Storage.get('torrserver_url_two') || '').replace(/\/$/, '');
                var sUrl = tsUrl + '/stream?link=' + linkInfo.hash + '&index=1&play';
                Lampa.Player.play({
                  title: params.element.title,
                  url: sUrl,
                  isonline: true
                });
              }
              if (a.copymagnet && linkInfo.magnet) {
                Lampa.Utils.copyTextToClipboard(linkInfo.magnet, function () {
                  Lampa.Noty.show('Magnet-ссылка скопирована');
                });
              }
              if (a.copyhash && linkInfo.hash) {
                Lampa.Utils.copyTextToClipboard(linkInfo.hash, function () {
                  Lampa.Noty.show('Хеш скопирован');
                });
              }
              if (a.copylink && extra && extra.file) {
                Lampa.Utils.copyTextToClipboard(extra.file, function () {
                  Lampa.Noty.show(Lampa.Lang.translate('copy_secuses'));
                });
              }
              if (a.player) {
                Lampa.Player.runas(a.player);
                params.html.trigger('hover:enter');
              }
            }
          });
        }
        params.onFile(show);
      });
    };

    this.empty = function () {
      var html = Lampa.Template.get('tr_does_not_answer', {});
      html.find('.online-empty__buttons').remove();
      html.find('.online-empty__title').text(Lampa.Lang.translate('empty_title_two'));
      html.find('.online-empty__time').text(Lampa.Lang.translate('empty_text'));
      scroll.clear();
      scroll.append(html);
      this.loading(false);
    };

    this.noConnectToServer = function (er) {
      var html = Lampa.Template.get('tr_does_not_answer', {});
      html.find('.online-empty__buttons').remove();
      html.find('.online-empty__title').text(Lampa.Lang.translate('title_error'));
      html.find('.online-empty__time').text(Lampa.Lang.translate('lampac_does_not_answer_text').replace('{balanser}', PLUGIN_NAME));
      scroll.clear();
      scroll.append(html);
      this.loading(false);
    };

    this.doesNotAnswer = function () {
      this.empty();
    };

    this.getLastEpisode = function (items) {
      var last_episode = 0;
      items.forEach(function (e) {
        if (typeof e.episode !== 'undefined') last_episode = Math.max(last_episode, parseInt(e.episode));
      });
      return last_episode;
    };

    this.background = function () {
      Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));
    };

    this.start = function () {
      if (!initialized) {
        initialized = true;
        this.initialize();
      }
      this.background();
      Lampa.Controller.add('content', {
        toggle: function toggle() {
          Lampa.Controller.collectionSet(scroll.render(), files.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        up: function up() {
          if (Navigator.canmove('up')) {
            Navigator.move('up');
          } else Lampa.Controller.toggle('head');
        },
        down: function down() {
          Navigator.move('down');
        },
        right: function right() {
          if (Navigator.canmove('right')) Navigator.move('right');
          else filter.show(Lampa.Lang.translate('title_filter'), 'filter');
        },
        left: function left() {
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        back: this.back.bind(this)
      });
      Lampa.Controller.toggle('content');
    };

    this.render = function () {
      return files.render();
    };

    this.back = function () {
      Lampa.Activity.backward();
    };

    this.pause = function () {};
    this.stop = function () {};
    this.destroy = function () {
      clearTimeout(number_of_requests_timer);
      network.clear();
      this.clearImages();
      files.destroy();
      scroll.destroy();
      if (filter && typeof filter.destroy === 'function') filter.destroy();
    };
  }

  // --- UI Шаблоны -----------------------------------------------------------

  function trCssHtml() {
    return [
      '<style>',
      '@charset \'UTF-8\';',
      '.online-prestige { position: relative; border-radius: 0.3em; background-color: rgba(0, 0, 0, 0.3); display: flex; }',
      '.online-prestige__body { padding: 1.2em; line-height: 1.3; flex-grow: 1; position: relative; }',
      '@media screen and (max-width: 480px) { .online-prestige__body { padding: 0.8em 1.2em; } }',
      '.online-prestige__img { position: relative; width: 13em; flex-shrink: 0; min-height: 8.2em; }',
      '.online-prestige__img > img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; border-radius: 0.3em; opacity: 0; transition: opacity 0.3s; }',
      '.online-prestige__img--loaded > img { opacity: 1; }',
      '@media screen and (max-width: 480px) { .online-prestige__img { width: 7em; min-height: 6em; } }',
      '.online-prestige__folder { padding: 1em; flex-shrink: 0; }',
      '.online-prestige__folder > svg { width: 4.4em !important; height: 4.4em !important; }',
      '.online-prestige__viewed { position: absolute; top: 1em; left: 1em; background: rgba(0, 0, 0, 0.45); border-radius: 100%; padding: 0.25em; font-size: 0.76em; }',
      '.online-prestige__viewed > svg { width: 1.5em !important; height: 1.5em !important; }',
      '.online-prestige__episode-number { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; font-size: 2em; }',
      '.online-prestige__loader { position: absolute; top: 50%; left: 50%; width: 2em; height: 2em; margin-left: -1em; margin-top: -1em; background: url(./img/loader.svg) no-repeat center center; background-size: contain; }',
      '.online-prestige__head, .online-prestige__footer { display: flex; justify-content: space-between; align-items: center; }',
      '.online-prestige__timeline { margin: 0.8em 0; }',
      '.online-prestige__timeline > .time-line { display: block !important; }',
      '.online-prestige__title { font-size: 1.7em; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; }',
      '@media screen and (max-width: 480px) { .online-prestige__title { font-size: 1.4em; } }',
      '.online-prestige__time { padding-left: 2em; }',
      '.online-prestige__info { display: flex; align-items: center; }',
      '.online-prestige__info > * { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; }',
      '.online-prestige__quality { padding-left: 1em; white-space: nowrap; font-weight: bold; color: #2ecc71; }',
      '.online-prestige .online-prestige-split { font-size: 0.8em; margin: 0 1em; flex-shrink: 0; }',
      '.online-prestige.focus::after { content: \'\'; position: absolute; top: -0.6em; left: -0.6em; right: -0.6em; bottom: -0.6em; border-radius: 0.7em; border: solid 0.3em #fff; z-index: -1; pointer-events: none; }',
      '.online-prestige + .online-prestige { margin-top: 1.5em; }',
      '.online-prestige--folder .online-prestige__footer { margin-top: 0.8em; }',
      '.online-prestige-watched { padding: 1em; }',
      '.online-prestige-watched__icon > svg { width: 1.5em; height: 1.5em; }',
      '.online-prestige-watched__body { padding-left: 1em; padding-top: 0.1em; display: flex; align-items: center; }',
      '.online-prestige-watched__body > * { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; }',
      '.online-prestige-watched__body .online-prestige-split { font-size: 0.8em; margin: 0 1em; flex-shrink: 0; }',
      '.online-prestige-watched.focus::after { content: \'\'; position: absolute; top: -0.6em; left: -0.6em; right: -0.6em; bottom: -0.6em; border-radius: 0.7em; border: solid 0.3em #fff; z-index: -1; pointer-events: none; }',
      '.online-empty { text-align: center; padding: 5em 0; }',
      '.online-empty__title { font-size: 2em; margin-bottom: 0.5em; }',
      '.online-empty__time { font-size: 1.2em; color: rgba(255, 255, 255, 0.6); }',
      '.online-empty__templates { width: 40em; margin: 3em auto 0 auto; }',
      '.online-empty-template { display: flex; align-items: center; background-color: rgba(255, 255, 255, 0.05); border-radius: 0.3em; padding: 1em; }',
      '.online-empty-template__ico { width: 2em; height: 2em; border-radius: 100%; background-color: rgba(255, 255, 255, 0.1); flex-shrink: 0; margin-right: 1em; }',
      '.online-empty-template__body { height: 1.7em; width: 70%; background-color: rgba(255, 255, 255, 0.1); border-radius: 0.2em; }',
      '.online-empty-template + .online-empty-template { margin-top: 1em; }',
      '</style>'
    ].join('\n');
  }

  var TR_TEMPLATE_PRESTIGE_FULL = [
    '<div class="online-prestige online-prestige--full selector">',
    '  <div class="online-prestige__img">',
    '    <img alt="">',
    '    <div class="online-prestige__loader"></div>',
    '  </div>',
    '  <div class="online-prestige__body">',
    '    <div class="online-prestige__head">',
    '      <div class="online-prestige__title">{title}</div>',
    '      <div class="online-prestige__time">{time}</div>',
    '    </div>',
    '    <div class="online-prestige__timeline"></div>',
    '    <div class="online-prestige__footer">',
    '      <div class="online-prestige__info">{info}</div>',
    '      <div class="online-prestige__quality">{quality}</div>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('\n');

  var TR_TEMPLATE_CONTENT_LOADING = [
    '<div class="online-empty">',
    '  <div class="broadcast__scan"><div></div></div>',
    '  <div class="online-empty__templates">',
    '    <div class="online-empty-template selector">',
    '      <div class="online-empty-template__ico"></div>',
    '      <div class="online-empty-template__body"></div>',
    '    </div>',
    '    <div class="online-empty-template">',
    '      <div class="online-empty-template__ico"></div>',
    '      <div class="online-empty-template__body"></div>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('\n');

  var TR_TEMPLATE_DOES_NOT_ANSWER = [
    '<div class="online-empty">',
    '  <div class="online-empty__title">#{empty_title_two}</div>',
    '  <div class="online-empty__time">#{empty_text}</div>',
    '</div>'
  ].join('\n');

  var TR_TEMPLATE_PRESTIGE_RATE = [
    '<div class="online-prestige-rate">',
    '  <span>★ {rate}</span>',
    '</div>'
  ].join('\n');

  var TR_TEMPLATE_PRESTIGE_FOLDER = [
    '<div class="online-prestige online-prestige--folder selector">',
    '  <div class="online-prestige__folder">',
    '    <svg viewBox="0 0 128 112" fill="none" xmlns="http://www.w3.org/2000/svg">',
    '      <rect y="20" width="128" height="92" rx="13" fill="white"></rect>',
    '      <path d="M29.9963 8H98.0037C96.0446 3.3021 91.4079 0 86 0H42C36.5921 0 31.9555 3.3021 29.9963 8Z" fill="white" fill-opacity="0.23"></path>',
    '      <rect x="11" y="8" width="106" height="76" rx="13" fill="white" fill-opacity="0.51"></rect>',
    '    </svg>',
    '  </div>',
    '  <div class="online-prestige__body">',
    '    <div class="online-prestige__head">',
    '      <div class="online-prestige__title">{title}</div>',
    '      <div class="online-prestige__time">{time}</div>',
    '    </div>',
    '    <div class="online-prestige__footer">',
    '      <div class="online-prestige__info">{info}</div>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('\n');

  var TR_TEMPLATE_PRESTIGE_WATCHED = [
    '<div class="online-prestige online-prestige-watched selector">',
    '  <div class="online-prestige-watched__icon">',
    '    <svg width="21" height="21" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">',
    '      <circle cx="10.5" cy="10.5" r="9" stroke="currentColor" stroke-width="3"/>',
    '      <path d="M14.8477 10.5628L8.20312 14.399L8.20313 6.72656L14.8477 10.5628Z" fill="currentColor"/>',
    '    </svg>',
    '  </div>',
    '  <div class="online-prestige-watched__body"></div>',
    '</div>'
  ].join('\n');

  function initTemplates() {
    if (window.tr_templates_initialized) return;
    window.tr_templates_initialized = true;
    Lampa.Template.add('tr_css', trCssHtml());
    $('body').append(Lampa.Template.get('tr_css', {}, true));
    Lampa.Template.add('tr_prestige_full', TR_TEMPLATE_PRESTIGE_FULL);
    Lampa.Template.add('tr_content_loading', TR_TEMPLATE_CONTENT_LOADING);
    Lampa.Template.add('tr_does_not_answer', TR_TEMPLATE_DOES_NOT_ANSWER);
    Lampa.Template.add('tr_prestige_rate', TR_TEMPLATE_PRESTIGE_RATE);
    Lampa.Template.add('tr_prestige_folder', TR_TEMPLATE_PRESTIGE_FOLDER);
    Lampa.Template.add('tr_prestige_watched', TR_TEMPLATE_PRESTIGE_WATCHED);
  }

  // --- Кнопка в карточке ----------------------------------------------------

  function addButton(e) {
    if (!e.render || !e.render.length) return;
    if (e.render.parent().find('.tr--button').length) return;
    var btn = $(
      '<div class="full-start__button selector tr--button">' +
        '<svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="currentColor" style="margin-right:0.4em;">' +
          '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-5H8l4-4 4 4h-3v5h-2z"/>' +
        '</svg>' +
        '<span>' + PLUGIN_NAME + '</span>' +
      '</div>'
    );
    btn.on('hover:enter', function () {
      initTemplates();
      var id = Lampa.Utils.hash(e.movie.number_of_seasons ? e.movie.original_name : e.movie.original_title);
      var all = Lampa.Storage.get('clarification_search', '{}');

      Lampa.Activity.push({
        url: '',
        title: PLUGIN_NAME,
        component: COMPONENT_NAME,
        search: all[id] ? all[id] : e.movie.title,
        search_one: e.movie.title,
        search_two: e.movie.original_title,
        movie: e.movie,
        page: 1,
        clarification: all[id] ? true : false
      });
    });
    e.render.after(btn);
  }

  function startPlugin() {
    if (window.lampa_settings && window.lampa_settings.read_only) return;

    initTemplates();
    Lampa.Component.add(COMPONENT_NAME, component);

    Lampa.Manifest.plugins = {
      type: 'video',
      version: PLUGIN_VERSION,
      name: PLUGIN_NAME,
      description: PLUGIN_NAME,
      component: COMPONENT_NAME
    };

    Lampa.Listener.follow('full', function (e) {
      if (e.type == 'complite') {
        var targetBtn = e.object.activity.render().find('.view--torrent');
        if (!targetBtn.length) targetBtn = e.object.activity.render().find('.view--online');
        if (!targetBtn.length) targetBtn = e.object.activity.render().find('.full-start__button').last();
        addButton({
          render: targetBtn,
          movie: e.data.movie
        });
      }
    });

    try {
      if (Lampa.Activity.active().component == 'full') {
        var aBtn = Lampa.Activity.active().activity.render().find('.view--torrent');
        if (!aBtn.length) aBtn = Lampa.Activity.active().activity.render().find('.view--online');
        if (!aBtn.length) aBtn = Lampa.Activity.active().activity.render().find('.full-start__button').last();
        addButton({
          render: aBtn,
          movie: Lampa.Activity.active().card
        });
      }
    } catch (e) {}
  }

  if (window.appready) {
    startPlugin();
  } else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') startPlugin();
    });
  }
})();
