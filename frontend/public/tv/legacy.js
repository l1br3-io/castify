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

  /* ── inline SVGs (classical task 002) ──────────────────────────────── */

  /* Lifted from the standalone TV layout. Inline SVG is Chromium-38-safe
   * (no icon fonts, no external assets); strokes/fills are precompiled —
   * the accent hex replaces the standalone's var(--color-accent). */
  var SEARCH_ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg>';
  var FOLDER_ICON =
    '<svg class="tv-folder-icon" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#b68235" stroke-width="1.7"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>';
  var PLAY_ICON =
    '<svg class="tv-play-icon" width="52" height="52" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';

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
      '<a class="tv-back" href="' + escapeHtml(backHref) + '">Back to the share</a>' +
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
  function isForced() {
    return window.location.search.indexOf("legacy=1") !== -1;
  }

  /*
   * No URLSearchParams (Chromium 49+) — hand-parse location.search. A
   * malformed percent-escape in a hand-edited URL must not throw and
   * brick the page, hence the try/catch.
   */
  function getQueryParam(name) {
    var match = new RegExp("[?&]" + name + "=([^&]*)").exec(window.location.search);
    if (!match) {
      return "";
    }
    try {
      return decodeURIComponent(match[1].replace(/\+/g, " "));
    } catch (e) {
      return "";
    }
  }

  /*
   * Every internal link's query string is built here, merging legacy=1
   * with the view params (folder, q). GOTCHA: the original legacyParam()
   * APPENDED "?legacy=1" blindly — any link that needed a second param
   * clobbered it (the "?" was baked into the append). One builder, every
   * href, nothing concatenated by hand.
   */
  function buildQueryString(folderId, q) {
    var parts = [];
    if (isForced()) {
      parts.push("legacy=1");
    }
    if (folderId) {
      parts.push("folder=" + encodeURIComponent(folderId));
    }
    if (q) {
      parts.push("q=" + encodeURIComponent(q));
    }
    return parts.length ? "?" + parts.join("&") : "";
  }

  function buildShareUrl(token, folderId, q) {
    return "/share/" + token + buildQueryString(folderId, q);
  }

  function buildWatchUrl(token, videoId, folderId, q) {
    return "/share/" + token + "/watch/" + encodeURIComponent(videoId) + buildQueryString(folderId, q);
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
          /* The back link carries whatever browse/search state the URL
           * holds — the recipient lands where they left off. */
          renderMessageWithBack(
            container,
            "This video isn't part of the share.",
            buildShareUrl(token, getQueryParam("folder"), getQueryParam("q"))
          );
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
    /* Back to the exact folder/search state the watch URL carries —
     * FR-4: the remote's Return and this link land in the same place. */
    var backHref = buildShareUrl(token, getQueryParam("folder"), getQueryParam("q"));
    container.innerHTML =
      '<div class="tv-watch">' +
      '<h1 class="tv-title">' + escapeHtml(video.name) + "</h1>" +
      '<video class="tv-video" controls preload="metadata" src="' + escapeHtml(url) +
      '" poster="' + escapeHtml(videoPath + "/thumbnail") + '"></video>' +
      (meta.length ? '<p class="tv-meta">' + meta.join(" &#183; ") + "</p>" : "") +
      '<a class="tv-back" href="' + escapeHtml(backHref) + '">Back to the share</a>' +
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

  /* One items fetch's worth of landing state; folder navigation
   * re-renders from here without further requests. */
  var landingData = null;
  var popstateWired = false;

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
        var folders = data && data.folders ? data.folders : [];
        var items = data && data.items ? data.items : [];
        if (!folders.length && !items.length) {
          renderMessage(container, "Nothing in this share.");
          return;
        }
        landingData = { container: container, token: token, title: title, tree: buildTree(folders, items) };
        renderBrowse();
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

  /* ── folder browse (legacy-tv-nav-search task 001) ─────────────────── */

  /* The in-memory index over the one items fetch: folder navigation is
   * pure client-side re-rendering, so the recipient request budget stays
   * resolve + unlock + one items fetch. "" keys are the share root. */
  function buildTree(folders, items) {
    var folderById = {};
    var foldersByParent = {};
    var itemsByFolder = {};
    var i;
    for (i = 0; i < folders.length; i++) {
      var folder = folders[i];
      folderById[folder.id] = folder;
      var parentKey = folder.parent_id || "";
      if (!foldersByParent[parentKey]) {
        foldersByParent[parentKey] = [];
      }
      foldersByParent[parentKey].push(folder);
    }
    var key;
    for (key in foldersByParent) {
      if (foldersByParent.hasOwnProperty(key)) {
        foldersByParent[key].sort(function (a, b) {
          return a.position - b.position;
        });
      }
    }
    for (i = 0; i < items.length; i++) {
      var itemKey = items[i].folder_id || "";
      if (!itemsByFolder[itemKey]) {
        itemsByFolder[itemKey] = [];
      }
      itemsByFolder[itemKey].push(items[i]);
    }
    return {
      folderById: folderById,
      foldersByParent: foldersByParent,
      itemsByFolder: itemsByFolder,
    };
  }

  function foldersAt(tree, folderId) {
    return tree.foldersByParent[folderId || ""] || [];
  }

  function itemsAt(tree, folderId) {
    return tree.itemsByFolder[folderId || ""] || [];
  }

  /* Ancestor chain root-first for the breadcrumb trail. The seen-set
   * guards against malformed parent cycles looping forever. */
  function folderChain(tree, folderId) {
    var chain = [];
    var seen = {};
    var current = folderId ? tree.folderById[folderId] : null;
    while (current && !seen[current.id]) {
      seen[current.id] = true;
      chain.unshift(current);
      current = current.parent_id ? tree.folderById[current.parent_id] : null;
    }
    return chain;
  }

  function renderCrumbs(state, folderId) {
    if (!folderId) {
      return "";
    }
    var chain = folderChain(state.tree, folderId);
    var html =
      '<p class="tv-crumbs">' +
      '<a class="tv-crumb" href="' + escapeHtml(buildShareUrl(state.token, "")) + '" data-folder="">' +
      escapeHtml(state.title) +
      "</a>";
    for (var i = 0; i < chain.length; i++) {
      html += '<span class="tv-crumb-sep">&#8250;</span>';
      if (i === chain.length - 1) {
        html += '<span class="tv-crumb-current">' + escapeHtml(chain[i].name) + "</span>";
      } else {
        html +=
          '<a class="tv-crumb" href="' + escapeHtml(buildShareUrl(state.token, chain[i].id)) +
          '" data-folder="' + escapeHtml(chain[i].id) + '">' +
          escapeHtml(chain[i].name) +
          "</a>";
      }
    }
    html += "</p>";
    return html;
  }

  /* Folder row: one anchor (click parity like video rows), no thumbnail —
   * accent folder icon left, name, direct counts right, CSS-drawn
   * chevron. Counts are direct children only, parts shown only when
   * non-zero. Full-width li (tv-item-folder) stacks above the card row. */
  function renderFolderRow(state, folder) {
    var counts = [];
    var videoCount = itemsAt(state.tree, folder.id).length;
    var subfolderCount = foldersAt(state.tree, folder.id).length;
    if (videoCount) {
      counts.push(videoCount + " videos");
    }
    if (subfolderCount) {
      counts.push(subfolderCount + " folders");
    }
    return (
      '<li class="tv-item tv-item-folder">' +
      '<a class="tv-folder-link" href="' + escapeHtml(buildShareUrl(state.token, folder.id)) +
      '" data-folder="' + escapeHtml(folder.id) + '">' +
      FOLDER_ICON +
      '<span class="tv-folder-name">' + escapeHtml(folder.name) + "</span>" +
      (counts.length ? '<span class="tv-folder-counts">' + counts.join(" &#183; ") + "</span>" : "") +
      "</a>" +
      "</li>"
    );
  }

  /*
   * Video card (classical task 002): the anchor keeps every hook
   * (tv-item-link, tv-item-thumb, tv-item-name, tv-item-meta,
   * tv-item-path); the card/plate wrappers are additive. The plate draws
   * stripes + a centered play icon; the real <img> covers it once
   * loaded, so a failed thumbnail degrades to the icon instead of a
   * broken-image glyph.
   */
  function renderItemRow(state, item, folderId, q) {
    var videoPath = "/api/share/" + state.token + "/videos/" + encodeURIComponent(item.id);
    var meta = [];
    var duration = formatDuration(item.duration_ms);
    var size = formatSize(item.size_bytes);
    if (duration) {
      meta.push(escapeHtml(duration));
    }
    if (size) {
      meta.push(escapeHtml(size));
    }
    /* Search results name where the hit lives; browse rows are already
     * "in" that place, so the label would be noise. */
    var path = q ? folderPath(state.tree, item.folder_id || "") : "";
    return (
      '<li class="tv-item tv-item-card">' +
      '<a class="tv-item-link" href="' + escapeHtml(buildWatchUrl(state.token, item.id, folderId, q)) + '">' +
      '<div class="tv-card">' +
      '<div class="tv-plate">' +
      PLAY_ICON +
      '<img class="tv-item-thumb" src="' + escapeHtml(videoPath + "/thumbnail") + '" alt="">' +
      "</div>" +
      '<div class="tv-card-body">' +
      '<span class="tv-item-name">' + escapeHtml(item.name) + "</span>" +
      (path ? '<span class="tv-item-path">' + escapeHtml(path) + "</span>" : "") +
      '<span class="tv-card-meta">' +
      '<span class="tv-tag">Video</span>' +
      (meta.length ? '<span class="tv-item-meta">' + meta.join(" &#183; ") + "</span>" : "") +
      "</span>" +
      "</div>" +
      "</div>" +
      "</a>" +
      "</li>"
    );
  }

  /* The validated folder param — a stale id (folder since deleted)
   * means the root level, not a bricked page. */
  function currentFolderId(tree) {
    var folderId = getQueryParam("folder");
    if (folderId && !tree.folderById[folderId]) {
      return "";
    }
    return folderId;
  }

  function parentFolderId(tree, folderId) {
    var folder = folderId ? tree.folderById[folderId] : null;
    return folder && folder.parent_id ? folder.parent_id : "";
  }

  /*
   * The explicit on-screen Back control. The remote's Return walks
   * history — this link names its destination outright, so a
   * deep-linked ?folder= (no in-app history behind it) still has a way
   * up. Root browse hides it: there is nowhere back to go inside the
   * share.
   */
  function renderBackNav(href) {
    return '<a class="tv-back-nav" href="' + escapeHtml(href) + '">&#8249; Back</a>';
  }

  /* ── whole-share search (legacy-tv-nav-search task 002) ────────────── */

  /* One pending debounce at a time; explicit navigation (folder rows,
   * crumbs, clear button) cancels it so a stale timer can't re-append
   * ?q= after the user has already gone somewhere else. */
  var searchTimer = null;

  function clearSearchTimer() {
    if (searchTimer !== null) {
      window.clearTimeout(searchTimer);
      searchTimer = null;
    }
  }

  /* Flat whole-share sweep, deterministic order: root videos first, then
   * a position-ordered depth walk — folders (matching ones collected en
   * route) before their own contents, ancestors before descendants. */
  function searchShare(tree, query) {
    var q = query.toLowerCase();
    var folders = [];
    var items = [];
    function walk(folderId) {
      var levelItems = itemsAt(tree, folderId);
      var i;
      for (i = 0; i < levelItems.length; i++) {
        if (levelItems[i].name.toLowerCase().indexOf(q) !== -1) {
          items.push(levelItems[i]);
        }
      }
      var kids = foldersAt(tree, folderId);
      for (i = 0; i < kids.length; i++) {
        if (kids[i].name.toLowerCase().indexOf(q) !== -1) {
          folders.push(kids[i]);
        }
        walk(kids[i].id);
      }
    }
    walk("");
    return { folders: folders, items: items };
  }

  /* Folder path for a search hit: chain names, root omitted, " › "
   * separators — the same voice as the breadcrumb trail. */
  function folderPath(tree, folderId) {
    var chain = folderChain(tree, folderId);
    var names = [];
    for (var i = 0; i < chain.length; i++) {
      names.push(chain[i].name);
    }
    return names.join(" \u203A ");
  }

  /* The signature band: title and search share one row — search is a
   * first-class citizen of the landing, not a bolt-on. The input rides
   * inside .tv-search-wrap (the standalone's bordered .input) next to
   * the inline magnifier. */
  function renderHeaderBand(state, q) {
    return (
      '<div class="tv-header-band">' +
      '<h1 class="tv-title">' + escapeHtml(state.title) + "</h1>" +
      '<div class="tv-search-wrap">' +
      SEARCH_ICON +
      '<input type="search" class="tv-search" id="tv-search" placeholder="Search videos" value="' +
      escapeHtml(q || "") +
      '">' +
      "</div>" +
      "</div>"
    );
  }

  function renderFolderLevel(state) {
    var container = state.container;
    var folderId = currentFolderId(state.tree);
    var folders = foldersAt(state.tree, folderId);
    var items = itemsAt(state.tree, folderId);
    var html =
      '<div class="tv-landing">' +
      renderHeaderBand(state, "") +
      (folderId ? renderBackNav(buildShareUrl(state.token, parentFolderId(state.tree, folderId))) : "") +
      renderCrumbs(state, folderId) +
      '<div class="tv-hr"></div>';
    if (!folders.length && !items.length) {
      html += '<p class="tv-empty-level">Nothing in this folder.</p>';
      html += "</div>";
      container.innerHTML = html;
      wireFolderNav(container);
      wireThumbs(container);
      wireBackNav(container);
    } else {
      html += '<ul class="tv-items">';
      var i;
      for (i = 0; i < folders.length; i++) {
        html += renderFolderRow(state, folders[i]);
      }
      for (i = 0; i < items.length; i++) {
        html += renderItemRow(state, items[i], folderId, "");
      }
      html += "</ul></div>";
      container.innerHTML = html;
      wireFolderNav(container);
      wireThumbs(container);
      wireBackNav(container);
    }
  }

  function renderSearch(state, query) {
    var container = state.container;
    var results = searchShare(state.tree, query);
    var total = results.folders.length + results.items.length;
    var html =
      '<div class="tv-landing">' +
      renderHeaderBand(state, query) +
      renderBackNav(buildShareUrl(state.token, currentFolderId(state.tree), "")) +
      '<p class="tv-results-count">' + total + (total === 1 ? " result" : " results") + "</p>" +
      '<div class="tv-hr"></div>';
    if (!total) {
      html += '<p class="tv-empty-level">No videos match.</p>' +
        '<button type="button" class="tv-button tv-clear" id="tv-clear-search">Clear search</button>';
    } else {
      html += '<ul class="tv-items">';
      var i;
      for (i = 0; i < results.folders.length; i++) {
        html += renderFolderRow(state, results.folders[i]);
      }
      for (i = 0; i < results.items.length; i++) {
        var item = results.items[i];
        html += renderItemRow(state, item, item.folder_id || "", query);
      }
      html += "</ul>";
    }
    html += "</div>";
    container.innerHTML = html;
    wireFolderNav(container);
    wireThumbs(container);
    wireBackNav(container);
    wireClearSearch();
  }

  /*
   * Folder-first browse at the level the URL names — or search results
   * when ?q= is set (search mode ignores folder; the param stays in the
   * URL so clearing the query restores the folder view). Cold loads and
   * pushState/popstate re-entry all land here; the mode is read fresh
   * from location.search each render.
   */
  function renderBrowse() {
    var state = landingData;
    if (!state) {
      return;
    }
    /* GOTCHA: the innerHTML swap below destroys the old input — capture
     * focus first and restore it after, so a mid-typing re-render doesn't
     * drop the on-screen keyboard. A cold load with ?q= never focuses
     * (same rule as browse: no autofocus on TVs). */
    var searchEl = document.getElementById("tv-search");
    var searchHadFocus = !!(searchEl && document.activeElement === searchEl);
    var query = getQueryParam("q");
    if (query) {
      renderSearch(state, query);
    } else {
      renderFolderLevel(state);
    }
    wireSearch();
    if (searchHadFocus) {
      var fresh = document.getElementById("tv-search");
      if (fresh) {
        fresh.focus();
      }
    }
    /* GOTCHA: entering a folder is history.pushState, which never
     * re-runs this script — the remote's Return button only fires
     * popstate. Without this re-render, back updates the URL and leaves
     * the list one level deep. addEventListener (not the onpopstate
     * property) so the handler survives jsdom's test harness too. */
    if (!popstateWired) {
      popstateWired = true;
      window.addEventListener("popstate", function () {
        renderBrowse();
      });
    }
  }

  function wireClearSearch() {
    var button = document.getElementById("tv-clear-search");
    if (!button) {
      return;
    }
    button.onclick = function () {
      clearSearchTimer();
      var state = landingData;
      if (!state) {
        return;
      }
      window.history.replaceState({}, "", "/share/" + state.token + buildQueryString(currentFolderId(state.tree), ""));
      renderBrowse();
    };
  }

  function wireSearch() {
    var input = document.getElementById("tv-search");
    if (!input) {
      return;
    }
    /* The wrap carries the border; light it from the input's focus
     * (Chromium 38 has no :has to do this from CSS alone). */
    input.onfocus = function () {
      if (this.parentNode) {
        this.parentNode.classList.add("tv-search-focus");
      }
    };
    input.onblur = function () {
      if (this.parentNode) {
        this.parentNode.classList.remove("tv-search-focus");
      }
    };
    input.oninput = function () {
      var value = this.value;
      clearSearchTimer();
      /* GOTCHA: the TV CPU is weak — a synchronous whole-list re-render
       * per keystroke stutters the on-screen keyboard. oninput is the
       * ES5-safe event; the re-render happens ~250ms after the last
       * keystroke, and the URL write is replaceState, NOT pushState —
       * back must not step through every keystroke. Zero XHRs here: the
       * payload is already in memory. */
      searchTimer = window.setTimeout(function () {
        searchTimer = null;
        var state = landingData;
        if (!state) {
          return;
        }
        if (value === getQueryParam("q")) {
          return;
        }
        window.history.replaceState(
          {}, "",
          "/share/" + state.token + buildQueryString(currentFolderId(state.tree), value)
        );
        renderBrowse();
      }, 250);
    };
  }

  /*
   * Folder links and crumbs carry real hrefs (click parity, no-JS
   * fallback) but left-clicks are intercepted: the payload is already in
   * memory, so entering a folder is a pushState + re-render, not a fetch.
   */
  function wireFolderNav(container) {
    var navLinks = [];
    collectByClass(container, "tv-folder-link", navLinks);
    collectByClass(container, "tv-crumb", navLinks);
    for (var i = 0; i < navLinks.length; i++) {
      navLinks[i].onclick = function (event) {
        if (event && event.preventDefault) {
          event.preventDefault();
        }
        clearSearchTimer();
        var state = landingData;
        var folderId = this.getAttribute("data-folder") || "";
        if (state) {
          window.history.pushState({}, "", buildShareUrl(state.token, folderId));
          renderBrowse();
        }
        return false;
      };
    }
  }

  function collectByClass(root, className, out) {
    var found = root.getElementsByClassName(className);
    for (var i = 0; i < found.length; i++) {
      out.push(found[i]);
    }
  }

  /*
   * Graceful plate thumbnails (classical task 002): a thumb that 404s
   * (pending generation) or decode-fails must vanish so the plate's
   * stripes + play icon read instead of a broken-image glyph. Wired per
   * render (rows are innerHTML strings); display:none keeps layout.
   */
  function wireThumbs(container) {
    var thumbs = container.querySelectorAll(".tv-item-thumb");
    for (var i = 0; i < thumbs.length; i++) {
      thumbs[i].onerror = function () {
        this.style.display = "none";
      };
    }
  }

  /*
   * Same interception contract as folder links (real href, no-JS
   * fallback, in-memory re-render), with one twist: exiting search
   * REPLACES the history entry — back must not bounce the recipient
   * into their own query again, the rule the debounced ?q= writes and
   * the clear-search button already follow. Climbing toward the root
   * PUSHES, so the remote's Return can step back down like any link.
   */
  function wireBackNav(container) {
    var links = [];
    collectByClass(container, "tv-back-nav", links);
    for (var i = 0; i < links.length; i++) {
      links[i].onclick = function (event) {
        if (event && event.preventDefault) {
          event.preventDefault();
        }
        clearSearchTimer();
        var state = landingData;
        if (state) {
          var href = this.getAttribute("href") || buildShareUrl(state.token, "", "");
          if (getQueryParam("q")) {
            window.history.replaceState({}, "", href);
          } else {
            window.history.pushState({}, "", href);
          }
          renderBrowse();
        }
        return false;
      };
    }
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

  /* ── classical canvas (legacy-tv-classical task 001) ───────────────── */

  /* The classical canvas: every render* writes into the content column of
   * a fixed 1920x1080 stage scaled to the viewport width. The stage keeps
   * the standalone's paper proportions on any screen; the letterbox shows
   * only on non-16:9 viewports. */
  function mountCanvas(container) {
    if (container.querySelector(".tv-frame")) {
      /* Re-entry (tests, forced-mode reloads): keep the scaffold and its
       * resize wiring — rebuilding would stack duplicate listeners. */
      applyScale(container);
      return;
    }
    container.innerHTML =
      '<div class="tv-frame"><div class="tv-stage">' +
      '<div class="tv-content" id="tv-content"></div></div></div>';
    applyScale(container);
    /* GOTCHA: ResizeObserver is Chromium 64+ — banned here. The scale is
     * recomputed on mount and on every window.resize instead. */
    window.addEventListener("resize", function () {
      applyScale(container);
    });
  }

  function applyScale(container) {
    var stage = container.querySelector(".tv-stage");
    var frame = container.querySelector(".tv-frame");
    if (!stage || !frame) {
      return;
    }
    /* GOTCHA: jsdom and hidden tabs report clientWidth 0 — the naive
     * division would scale the stage to 0 and blank the page. Guard to 1:
     * an unscaled stage crops rather than disappears. */
    var width = container.clientWidth;
    var scale = width > 0 ? width / 1920 : 1;
    stage.style.webkitTransform = "scale(" + scale + ")";
    stage.style.transform = "scale(" + scale + ")";
    frame.style.height = Math.round(1080 * scale) + "px";
  }

  /* ── boot ──────────────────────────────────────────────────────────── */

  function render() {
    ensureStylesheet();
    var container = ensureContainer();
    mountCanvas(container);
    /* Every flow renders into the content column; signatures unchanged. */
    var content = document.getElementById("tv-content");
    var route = parseRoute(window.location.pathname);
    if (route && route.videoId) {
      renderWatch(content, route.token, route.videoId);
    } else if (route) {
      renderLanding(content, route.token);
    } else {
      renderMessage(content, "Castify on this TV supports share links only.");
    }
  }

  /* Re-entry point for tests and forced mode; the TV path auto-runs it. */
  window.__castifyLegacyInit = function () {
    render();
  };

  render();
})();
