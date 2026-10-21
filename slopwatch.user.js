// ==UserScript==
// @name         Slopwatch
// @namespace    https://github.com/
// @version      1.0.0
// @description  Warns you when a repo you're viewing has llm contributors
// @match        https://github.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  var DEBUG = true;

  var SLOP_USERS = [
    "claude",
    "cursoragent",
    "codex",
  ];

  var SLOP_APPS = [
    "/apps/github-copilot-cli",
    "/apps/copilot-pull-request-reviewer",
    "/apps/copilot-swe-agent",
    "/apps/chatgpt-codex-connector",
    "/apps/anthropic-code-agent",
    "/apps/coderabbitai",
    "/apps/gemini-code-assist",
    "/apps/devin-ai-integration",
    "/apps/factory-droid",
    "/apps/sourcery-ai",
    "/apps/greptile-apps",
    "/apps/ellipsis-dev",
  ];

  var MAX_TRIES = 8;
  var START_DELAY = 1000;
  var MAX_DELAY = 16000;
  var NOT_REPOS = [
    "about", "account", "apps", "codespaces", "collections", "contact",
    "copilot", "customer-stories", "dashboard", "enterprise", "events",
    "explore", "features", "gist", "github-copilot", "issues", "login",
    "logout", "marketplace", "new", "notifications", "organizations", "orgs",
    "pricing", "pulls", "readme", "search", "security", "sessions", "settings",
    "signup", "site", "sponsors", "stars", "team", "topics", "trending", "users"
  ];

  var currentRequest = null;
  var bannerId = "slopwatch-banner";
  var lastPath = null;

  function fixPath(path) {
    path = String(path).trim().replace(/^\/+|\/+$/g, "");
    return ("/" + path).toLowerCase();
  }

  function getRepo() {
    var parts = location.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    if (parts.length > 2 && parts[2].toLowerCase() != "tree") {
      return null;
    }

    var first = parts[0].toLowerCase();
    for (var i = 0; i < NOT_REPOS.length; i++) {
      if (NOT_REPOS[i] == first) {
        return null;
      }
    }

    return {
      owner: parts[0],
      repo: parts[1],
      key: (parts[0] + "/" + parts[1]).toLowerCase()
    };
  }

  async function getContributors(owner, repo, signal) {
    var url = "https://github.com/" + owner + "/" + repo + "/graphs/contributors-data";
    var delay = START_DELAY;

    for (var tries = 0; tries < MAX_TRIES; tries++) {
      var res = await fetch(url, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: signal
      });

      if (DEBUG) {
        console.log("[slopwatch] try " + (tries + 1) + " status " + res.status);
      }

      if (res.status == 200) {
        var txt = await res.text();
        if (txt.trim() != "") {
          var data = JSON.parse(txt);
          if (Array.isArray(data)) {
            return data;
          }
        }
      } else if (res.status != 202) {
        throw new Error("contributors-data returned " + res.status);
      }

      await new Promise(function (resolve, reject) {
        var timer = setTimeout(resolve, delay);

        signal.addEventListener("abort", function () {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });

      delay = delay * 2;
      if (delay > MAX_DELAY) {
        delay = MAX_DELAY;
      }
    }

    throw new Error("contributors-data not ready after " + MAX_TRIES + " attempts");
  }

  function isSlopper(login, path) {
    for (var i = 0; i < SLOP_USERS.length; i++) {
      if (SLOP_USERS[i] == login) return true;
    }

    for (var k = 0; k < SLOP_APPS.length; k++) {
      if (SLOP_APPS[k] == path) return true;
    }

    return false;
  }

  function getSloppers(data) {
    var found = [];

    for (var i = 0; i < data.length; i++) {
      var entry = data[i];
      if (!entry || !entry.author) {
        continue;
      }

      var login = (entry.author.login || "").toLowerCase();
      var path = "";
      if (entry.author.path) {
        path = fixPath(entry.author.path);
      }

      if (isSlopper(login, path)) {
        found.push({
          login: entry.author.login || null,
          path: entry.author.path || (entry.author.login ? "/" + entry.author.login : null),
          commits: entry.total != null ? entry.total : null
        });
      }
    }

    return found;
  }

  function makeInfoBanner(name, before, after) {
    var banner = document.createElement("div");
    banner.id = bannerId;
    banner.className = "flash";
    banner.setAttribute("role", "status");
    banner.style.margin = "16px 0";
    banner.appendChild(document.createTextNode(before));
    var code = document.createElement("code");
    code.textContent = name;
    banner.appendChild(code);
    banner.appendChild(document.createTextNode(after));
    return banner;
  }

  function makeBanner(name, matches) {
    var banner = document.createElement("div");
    banner.id = bannerId;
    banner.className = "flash flash-warn";
    banner.setAttribute("role", "alert");
    banner.style.margin = "16px 0";
    banner.appendChild(document.createTextNode("AI/LLM contributors found in "));
    var code = document.createElement("code");
    code.textContent = name;
    banner.appendChild(code);
    banner.appendChild(document.createTextNode(": "));
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];

      if (i > 0) {
        banner.appendChild(document.createTextNode(", "));
      }

      var link = document.createElement("a");
      link.textContent = m.login || m.path;
      if (m.path) {
        link.href = "https://github.com/search?q=repo:" + name + ' "' + (m.path = m.path.startsWith("/apps/") ? m.path.slice(6) + "[bot]" : m.path.replace(/^\/+/, "")) + '"&type=commits';
        link.target = "_blank";
      }
      banner.appendChild(link);

      if (m.commits != null) {
        banner.appendChild(document.createTextNode(" (" + m.commits + " commits)"));
      }
    }

    return banner;
  }

  async function run() {
    // hack: hijacking turbo load causes a double-run :(
    if (location.pathname == lastPath) {
      return;
    }

    lastPath = location.pathname;

    if (currentRequest) {
      currentRequest.abort();
    }

    var old = document.getElementById(bannerId);
    if (old) {
      old.remove();
    }

    var repo = getRepo();
    if (!repo) {
      return;
    }

    var content = document.querySelector('[data-component="SplitPageLayout.Content"][data-is-hidden="false"]');
    if (content) {
      content.prepend(makeInfoBanner(repo.owner + "/" + repo.repo, "Checking ", " for AI/LLM contributors\u2026"));
    }

    currentRequest = new AbortController();
    try {
      var data = await getContributors(repo.owner, repo.repo, currentRequest.signal);
      var matches = getSloppers(data);

      if (DEBUG) {
        console.log("[slopwatch] " + repo.key + " matches: " + matches.length);
      }

      if (currentRequest.signal.aborted) {
        return;
      }

      var currentRepo = getRepo();
      if (!currentRepo || currentRepo.key != repo.key) {
        return;
      }

      old = document.getElementById(bannerId);
      if (old) {
        old.remove();
      }

      content = document.querySelector('[data-component="SplitPageLayout.Content"][data-is-hidden="false"]');
      if (content) {
        if (matches.length > 0) {
          content.prepend(makeBanner(repo.owner + "/" + repo.repo, matches));
        } else {
          content.prepend(makeInfoBanner(repo.owner + "/" + repo.repo, "No AI/LLM contributors found in ", "."));
        }
      }
    } catch (err) {
      if (err.name != "AbortError") {
        console.warn("[slopwatch]", err);
      }
    }
  }

  document.addEventListener("turbo:load", run);
  document.addEventListener("pjax:end", run);
  window.addEventListener("popstate", run);

  run();
})();
