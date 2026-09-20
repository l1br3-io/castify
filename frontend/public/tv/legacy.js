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
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
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
    xhr.send();
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

  function renderRetryableError(container, retry) {
    container.innerHTML =
      '<div class="tv-message">' +
      '<p class="tv-message-title">Something went wrong.</p>' +
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

  /* ── watch page ────────────────────────────────────────────────────── */

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
          renderMessage(container, "This video isn't part of the share.");
          return;
        }
        renderStream(container, token, video);
      },
      status: function () {
        renderRetryableError(container, function () {
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

  function renderStream(container, token, video) {
    var videoPath = "/api/share/" + token + "/videos/" + encodeURIComponent(video.id);
    renderLoading(container);
    getJson(videoPath + "/stream-url", {
      ok: function (stream) {
        if (!stream || !stream.url) {
          renderRetryableError(container, function () {
            renderStream(container, token, video);
          });
          return;
        }
        if (stream.strategy === "transcode") {
          renderMessage(container, "Transcoding isn't supported on this TV.");
          return;
        }
        renderPlayer(container, token, video, stream.url);
      },
      status: function () {
        renderRetryableError(container, function () {
          renderStream(container, token, video);
        });
      },
      error: function () {
        renderRetryableError(container, function () {
          renderStream(container, token, video);
        });
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
    attachSubtitles(videoPath, container.getElementsByTagName("video")[0]);
  }

  /*
   * Native <track> elements consume WebVTT; the server converts text
   * formats on the fly. ASS/SSA tracks are served raw for libass (modern
   * bundle only) and image-family tracks need burn-in — neither can run
   * on this engine, so both are skipped (spec: ASS ignored).
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
    });
  }

  /* ── boot ──────────────────────────────────────────────────────────── */

  function render() {
    ensureStylesheet();
    var container = ensureContainer();
    var route = parseRoute(window.location.pathname);
    if (route && route.videoId) {
      renderWatch(container, route.token, route.videoId);
    } else {
      /* Task 004 replaces this with the landing flow / non-share notice. */
      renderLoading(container);
    }
  }

  /* Re-entry point for tests and forced mode; the TV path auto-runs it. */
  window.__castifyLegacyInit = function () {
    render();
  };

  render();
})();
