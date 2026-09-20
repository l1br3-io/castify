/*
 * Castify legacy TV player.
 *
 * GOTCHA: this file must stay ES5 — no let/const, arrow functions, `?.`,
 * `??`, template literals, Promise, or fetch. The target browser is a
 * Samsung Smart TV (Tizen, Chromium-38-era); anything newer is a parse
 * error that blanks the page. The acorn ecmaVersion:5 gate in
 * src/lib/legacy-tv.test.ts enforces this.
 *
 * Dispatch: an inline probe in index.html appends this script on browsers
 * that cannot run the modern bundle (?legacy=1 forces it for dev/e2e).
 * The modern app's #root is hidden and all rendering happens inside the
 * #castify-legacy container, whose styles live in /tv/legacy.css.
 *
 * Runtime notes (Chromium-38-era): Array.prototype.find is Chrome 45+ and
 * fetch is Chrome 42+ — plain `for` loops and XMLHttpRequest only.
 */
(function () {
  "use strict";

  if (window.__castifyLegacyLoaded) {
    return;
  }
  window.__castifyLegacyLoaded = true;

  /* ── plumbing ──────────────────────────────────────────────────────── */

  function ensureStylesheet() {
    if (document.getElementById("castify-legacy-css")) {
      return;
    }
    var link = document.createElement("link");
    link.id = "castify-legacy-css";
    link.rel = "stylesheet";
    link.href = "/tv/legacy.css";
    document.head.appendChild(link);
  }

  function ensureContainer() {
    var root = document.getElementById("root");
    if (root) {
      root.style.display = "none";
    }
    var container = document.getElementById("castify-legacy");
    if (!container) {
      container = document.createElement("div");
      container.id = "castify-legacy";
      document.body.appendChild(container);
    }
    return container;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /*
   * XHR GET returning parsed JSON. The unlock cookie is HttpOnly with
   * Path=/api/share/ — same-origin XHR attaches it automatically, so no
   * CSRF bootstrap exists here and none is needed (/api/share/* is
   * pre-auth).
   *
   * handlers: { ok: fn(data), status: fn(code, data), error: fn() } —
   * `error` fires on network failure (status 0), `status` on non-2xx.
   */
  function getJson(url, handlers) {
    requestJson("GET", url, null, handlers);
  }

  function postJson(url, body, handlers) {
    requestJson("POST", url, JSON.stringify(body), handlers);
  }

  function requestJson(method, url, body, handlers) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    if (body !== null) {
      xhr.setRequestHeader("Content-Type", "application/json");
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }
      if (xhr.status === 0) {
        handlers.error();
        return;
      }
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        handlers.ok(data);
      } else {
        handlers.status(xhr.status, data);
      }
    };
    xhr.send(body);
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) {
      return "";
    }
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    function pad(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) {
      return "";
    }
    if (bytes < 1024) {
      return bytes + " B";
    }
    var units = ["KB", "MB", "GB", "TB"];
    var value = bytes / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value = value / 1024;
      i++;
    }
    return value.toFixed(1) + " " + units[i];
  }

  function renderLoading(container) {
    container.innerHTML = '<p class="tv-loading">Loading&#8230;</p>';
  }

  function renderMessage(container, text) {
    container.innerHTML =
      '<div class="tv-message">' +
      '<p class="tv-message-title">' + escapeHtml(text) + "</p>" +
      "</div>";
  }

  function renderMessageWithBack(container, text, backHref) {
    container.innerHTML =
      '<div class="tv-message">' +
      '<p class="tv-message-title">' + escapeHtml(text) + "</p>" +
      '<a class="tv-back" href="' + escapeHtml(backHref + legacyParam()) + '">Back to the share</a>' +
      "</div>";
  }

  function renderRetryableError(container, retry, title) {
    container.innerHTML =
      '<div class="tv-message">' +
      '<p class="tv-message-title">' + escapeHtml(title || "Something went wrong.") + "</p>" +
      '<p class="tv-message-body">Check the TV\'s connection and try again.</p>' +
      '<button type="button" class="tv-button" id="tv-retry">Retry</button>' +
      "</div>";
    var button = document.getElementById("tv-retry");
    if (button) {
      button.onclick = function () {
        retry();
      };
    }
  }

  /*
   * Unplayable-format card — shared by the canPlayType gate, the burned
   * CDN-expiry retry, and failed recovery refetches. Same spirit as the
   * modern page's ShareUnsupportedFormat.
   */
  function renderUnsupportedFormat(container) {
    renderMessage(container, "This format can't be played in-browser.");
  }

  /*
   * Transcode terminal card. The modern page resolves transcode through
   * hls.js; the legacy page must not (module syntax + ~500 KB) — the
   * card is terminal by design (spec FR-4.1).
   */
  function renderTranscodeCard(container) {
    container.innerHTML =
      '<div class="tv-message">' +
      '<p class="tv-message-title">Transcoding isn\'t supported on this TV.</p>' +
      '<p class="tv-message-body">Shared videos should be MP4 (H.264) to play here.</p>' +
      "</div>";
  }

  /* Terminal share errors — copy mirrors the modern page. Anything else
   * degrades to the retryable generic error. */
  function renderShareError(container, code, retry) {
    if (code === 404) {
      renderMessage(container, "This share doesn't exist.");
      return;
    }
    if (code === 410) {
      renderMessage(container, "This share is no longer available.");
      return;
    }
    renderRetryableError(container, retry);
  }

  /* ── routing ───────────────────────────────────────────────────────── */

  /* /share/{token} and /share/{token}/watch/{videoId}; tokens and video
   * ids are URL-safe slugs. Anything else is not a share route. */
  function parseRoute(pathname) {
    var m = /^\/share\/([A-Za-z0-9_-]+)(?:\/watch\/([A-Za-z0-9_-]+))?$/.exec(pathname);
    if (!m) {
      return null;
    }
    return { token: m[1], videoId: m[2] || null };
  }

  /*
   * Forced mode (?legacy=1) must survive the legacy page's own
   * navigations: a modern browser following a legacy link would
   * otherwise drop the flag, pass the loader's probes, and render the
   * modern app mid-journey (e2e/dev only — real TVs probe into legacy
   * and carry no flag to preserve).
   */
  function legacyParam() {
    return window.location.search.indexOf("legacy=1") !== -1 ? "?legacy=1" : "";
  }

  /* ── watch page ────────────────────────────────────────────────────── */

  /* Mirrors the modern page's optimistic gate: null mime plays (the
   * error path catches failed decodes); otherwise canPlayType must not
   * answer "". */
  function canPlayMime(mime) {
    if (!mime) {
      return true;
    }
    var probe = document.createElement("video");
    if (!probe.canPlayType) {
      return true;
    }
    return probe.canPlayType(mime) !== "";
  }

  function findVideo(items, videoId) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === videoId) {
        return items[i];
      }
    }
    return null;
  }

  function renderWatch(container, token, videoId) {
    renderLoading(container);
    getJson("/api/share/" + token + "/items", {
      ok: function (data) {
        var video = findVideo(data && data.items ? data.items : [], videoId);
        if (!video) {
          renderMessageWithBack(container, "This video isn't part of the share.", "/share/" + token);
          return;
        }
        renderStream(container, token, video, videoId);
      },
      status: function (code) {
        if (code === 401) {
          renderUnlockGate(container, token, function () {
            renderWatch(container, token, videoId);
          });
          return;
        }
        renderShareError(container, code, function () {
          renderWatch(container, token, videoId);
        });
      },
      error: function () {
        renderRetryableError(container, function () {
          renderWatch(container, token, videoId);
        });
      },
    });
  }

  function renderStream(container, token, video, videoId) {
    var videoPath = "/api/share/" + token + "/videos/" + encodeURIComponent(video.id);
    renderLoading(container);
    getJson(videoPath + "/stream-url", {
      ok: function (stream) {
        if (!stream || !stream.url) {
          renderRetryableError(container, function () {
            renderStream(container, token, video, videoId);
          }, "Couldn't load this video.");
          return;
        }
        if (stream.strategy === "transcode") {
          renderTranscodeCard(container);
          return;
        }
        if (!canPlayMime(video.mime_type)) {
          renderUnsupportedFormat(container);
          return;
        }
        renderPlayer(container, token, video, stream.url);
      },
      status: function (code) {
        if (code === 404) {
          renderMessage(container, "This video is no longer available in this share.");
          return;
        }
        renderRetryableError(container, function () {
          renderStream(container, token, video, videoId);
        }, "Couldn't load this video.");
      },
      error: function () {
        renderRetryableError(container, function () {
          renderStream(container, token, video, videoId);
        }, "Couldn't load this video.");
      },
    });
  }

  function renderPlayer(container, token, video, url) {
    var videoPath = "/api/share/" + token + "/videos/" + encodeURIComponent(video.id);
    var meta = [];
    var duration = formatDuration(video.duration_ms);
    var size = formatSize(video.size_bytes);
    if (duration) {
      meta.push(escapeHtml(duration));
    }
    if (size) {
      meta.push(escapeHtml(size));
    }
    container.innerHTML =
      '<div class="tv-watch">' +
      '<h1 class="tv-title">' + escapeHtml(video.name) + "</h1>" +
      '<video class="tv-video" controls preload="metadata" src="' + escapeHtml(url) +
      '" poster="' + escapeHtml(videoPath + "/thumbnail") + '"></video>' +
      (meta.length ? '<p class="tv-meta">' + meta.join(" &#183; ") + "</p>" : "") +
      "</div>";
    var videoEl = container.getElementsByTagName("video")[0];
    wireExpiryRecovery(container, videoPath, videoEl);
    attachSubtitles(videoPath, videoEl);
  }

  /*
   * CDN-expiry recovery (direct URLs are short-lived preauthenticated
   * links). On a <video> error, refetch /stream-url (a fresh URL — not
   * the same one), swap src, and restore currentTime best-effort. Hard
   * one-retry bound: a loop here would hammer the backend on a genuinely
   * broken file; the second error is terminal (mirrors the modern
   * player's retriedStreamUrlRef).
   */
  function wireExpiryRecovery(container, videoPath, videoEl) {
    if (!videoEl) {
      return;
    }
    var recovered = false;
    videoEl.onerror = function () {
      if (recovered) {
        renderUnsupportedFormat(container);
        return;
      }
      recovered = true;
      var time = videoEl.currentTime;
      getJson(videoPath + "/stream-url", {
        ok: function (stream) {
          if (!stream || !stream.url) {
            renderUnsupportedFormat(container);
            return;
          }
          videoEl.setAttribute("src", stream.url);
          videoEl.load();
          try {
            videoEl.currentTime = time;
          } catch (e) {
            /* Best-effort — some engines need loadedmetadata first. */
          }
        },
        status: function () {
          renderUnsupportedFormat(container);
        },
        error: function () {
          renderUnsupportedFormat(container);
        },
      });
    };
  }

  /*
   * Native <track> elements consume WebVTT; the server converts text
   * formats on the fly. ASS/SSA tracks are served raw for libass (modern
   * bundle only) and image-family tracks need burn-in — neither can run
   * on this engine, so both are skipped (spec: ASS ignored). Failure is
   * non-fatal: the video plays, tracks are simply absent.
   */
  function attachSubtitles(videoPath, videoEl) {
    if (!videoEl) {
      return;
    }
    getJson(videoPath + "/subtitles", {
      ok: function (tracks) {
        if (!tracks || !tracks.length) {
          return;
        }
        for (var i = 0; i < tracks.length; i++) {
          var track = tracks[i];
          if (track.format_family !== "text") {
            continue;
          }
          if (track.format === "ass" || track.format === "ssa") {
            continue;
          }
          var el = document.createElement("track");
          el.setAttribute("kind", "subtitles");
          if (track.language) {
            el.setAttribute("srclang", track.language);
            el.setAttribute("label", track.language);
          } else {
            el.setAttribute("label", track.filename);
          }
          el.setAttribute("src", videoPath + "/subtitles/" + encodeURIComponent(track.id));
          videoEl.appendChild(el);
        }
      },
      status: function () {
        /* Non-fatal by design. */
      },
      error: function () {
        /* Non-fatal by design. */
      },
    });
  }

  /* ── landing page ──────────────────────────────────────────────────── */

  /*
   * /share/{token}: resolve supplies the title (the one endpoint that
   * answers while locked), items decides the view — 200 renders the flat
   * video list, 401 renders the inline unlock form (204 → re-run the
   * flow, which then renders the list).
   */
  function renderLanding(container, token) {
    renderLoading(container);
    getJson("/api/share/" + token, {
      ok: function (share) {
        var title = share && share.title ? share.title : "Shared videos";
        renderLandingItems(container, token, title);
      },
      status: function (code) {
        renderShareError(container, code, function () {
          renderLanding(container, token);
        });
      },
      error: function () {
        renderRetryableError(container, function () {
          renderLanding(container, token);
        });
      },
    });
  }

  function renderLandingItems(container, token, title) {
    getJson("/api/share/" + token + "/items", {
      ok: function (data) {
        renderVideoList(container, token, title, data && data.items ? data.items : []);
      },
      status: function (code) {
        if (code === 401) {
          renderUnlockForm(container, token, title);
          return;
        }
        renderShareError(container, code, function () {
          renderLanding(container, token);
        });
      },
      error: function () {
        renderRetryableError(container, function () {
          renderLanding(container, token);
        });
      },
    });
  }

  /*
   * The share's videos as a flat list. Each row is a single anchor
   * wrapping the thumbnail, the name, and duration/size meta — clicking
   * the thumbnail and clicking the name are the same action by
   * construction (FR-3.1, click parity).
   */
  function renderVideoList(container, token, title, items) {
    if (!items.length) {
      container.innerHTML =
        '<div class="tv-landing">' +
        '<h1 class="tv-title">' + escapeHtml(title) + "</h1>" +
        "</div>";
      renderMessage(container, "Nothing in this share.");
      return;
    }
    var rows = "";
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var videoPath = "/api/share/" + token + "/videos/" + encodeURIComponent(item.id);
      var meta = [];
      var duration = formatDuration(item.duration_ms);
      var size = formatSize(item.size_bytes);
      if (duration) {
        meta.push(escapeHtml(duration));
      }
      if (size) {
        meta.push(escapeHtml(size));
      }
      rows +=
        '<li class="tv-item">' +
        '<a class="tv-item-link" href="/share/' + escapeHtml(token) +
        "/watch/" + escapeHtml(encodeURIComponent(item.id)) + escapeHtml(legacyParam()) + '">' +
        '<img class="tv-item-thumb" src="' + escapeHtml(videoPath + "/thumbnail") + '" alt="">' +
        '<span class="tv-item-body">' +
        '<span class="tv-item-name">' + escapeHtml(item.name) + "</span>" +
        (meta.length ? '<span class="tv-item-meta">' + meta.join(" &#183; ") + "</span>" : "") +
        "</span>" +
        "</a>" +
        "</li>";
    }
    container.innerHTML =
      '<div class="tv-landing">' +
      '<h1 class="tv-title">' + escapeHtml(title) + "</h1>" +
      '<ul class="tv-items">' + rows + "</ul>" +
      "</div>";
  }

  /* ── unlock form ───────────────────────────────────────────────────── */

  /*
   * Resolve the share title (the one endpoint that answers while
   * locked), then render the unlock form. `onUnlocked` re-runs the
   * calling flow in place — the landing re-fetches the list, the watch
   * page re-fetches the stream. Omit it for the landing default.
   */
  function renderUnlockGate(container, token, onUnlocked) {
    getJson("/api/share/" + token, {
      ok: function (share) {
        var title = share && share.title ? share.title : "Shared videos";
        renderUnlockForm(container, token, title, onUnlocked);
      },
      status: function (code) {
        renderShareError(container, code, function () {
          renderUnlockGate(container, token, onUnlocked);
        });
      },
      error: function () {
        renderRetryableError(container, function () {
          renderUnlockGate(container, token, onUnlocked);
        });
      },
    });
  }

  function renderUnlockForm(container, token, title, onUnlocked) {
    container.innerHTML =
      '<div class="tv-message tv-unlock">' +
      '<h1 class="tv-title">' + escapeHtml(title) + "</h1>" +
      '<p class="tv-message-body">This share is password-protected.</p>' +
      '<form class="tv-unlock-form" id="tv-unlock-form">' +
      '<label class="tv-label" for="tv-password">Password</label>' +
      '<input class="tv-input" type="password" id="tv-password" autocomplete="off">' +
      '<button type="submit" class="tv-button" id="tv-unlock-submit">Unlock</button>' +
      "</form>" +
      '<p class="tv-unlock-error" id="tv-unlock-error"></p>' +
      "</div>";
    var form = document.getElementById("tv-unlock-form");
    if (form) {
      form.onsubmit = function (event) {
        if (event && event.preventDefault) {
          event.preventDefault();
        }
        submitUnlock(container, token, onUnlocked);
        return false;
      };
    }
  }

  function submitUnlock(container, token, onUnlocked) {
    var input = document.getElementById("tv-password");
    var errorEl = document.getElementById("tv-unlock-error");
    var button = document.getElementById("tv-unlock-submit");
    var password = input ? input.value : "";
    if (!password) {
      return;
    }
    if (errorEl) {
      errorEl.innerHTML = "";
    }
    if (button) {
      button.disabled = true;
    }
    postJson("/api/share/" + token + "/unlock", { password: password }, {
      ok: function () {
        if (onUnlocked) {
          onUnlocked();
          return;
        }
        renderLanding(container, token);
      },
      status: function (code) {
        if (button) {
          button.disabled = false;
        }
        if (code === 401) {
          showUnlockError("Wrong password. Try again.");
          return;
        }
        if (code === 429) {
          showUnlockError("Too many attempts. Wait a moment and try again.");
          return;
        }
        if (code === 404 || code === 410) {
          renderShareError(container, code, function () {
            renderLanding(container, token);
          });
          return;
        }
        showUnlockError("Something went wrong. Try again.");
      },
      error: function () {
        if (button) {
          button.disabled = false;
        }
        showUnlockError("Something went wrong. Try again.");
      },
    });
  }

  function showUnlockError(text) {
    var errorEl = document.getElementById("tv-unlock-error");
    if (errorEl) {
      errorEl.innerHTML = escapeHtml(text);
    }
  }

  /* ── boot ──────────────────────────────────────────────────────────── */

  function render() {
    ensureStylesheet();
    var container = ensureContainer();
    var route = parseRoute(window.location.pathname);
    if (route && route.videoId) {
      renderWatch(container, route.token, route.videoId);
    } else if (route) {
      renderLanding(container, route.token);
    } else {
      renderMessage(container, "Castify on this TV supports share links only.");
    }
  }

  /* Re-entry point for tests and forced mode; the TV path auto-runs it. */
  window.__castifyLegacyInit = function () {
    render();
  };

  render();
})();
