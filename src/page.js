// ページ側（MAIN world）で動くスクリプト。
// X 自身の API リクエストから認証ヘッダーを拾い、それを使って AboutAccountQuery を呼び出す。
// content.js とは CustomEvent（detail は JSON 文字列）でやり取りする。
(() => {
  if (window.__xflagPageLoaded) return;
  window.__xflagPageLoaded = true;

  // X の Web クライアントが使う公開 Bearer トークン（ヘッダーを拾えなかった場合のフォールバック）
  const PUBLIC_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const DEFAULT_QUERY_ID = 'XRqGa7EeokUU5kppkh13EA';
  const CAPTURE_HEADERS = [
    'authorization',
    'x-csrf-token',
    'x-twitter-active-user',
    'x-twitter-auth-type',
    'x-twitter-client-language',
  ];

  const captured = {};
  let queryId = DEFAULT_QUERY_ID;
  let discoveryTried = false;

  function isGraphql(url) {
    return typeof url === 'string' && url.includes('/i/api/graphql/');
  }

  function noteUrl(url) {
    const m = url.match(/\/graphql\/([\w-]+)\/AboutAccountQuery/);
    if (m) queryId = m[1];
  }

  function captureHeader(name, value) {
    const key = String(name).toLowerCase();
    if (CAPTURE_HEADERS.includes(key) && value) captured[key] = String(value);
  }

  // --- fetch / XHR をフックしてヘッダーを取得 ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (isGraphql(url)) {
        noteUrl(url);
        const raw = (init && init.headers) || (input instanceof Request ? input.headers : null);
        if (raw) new Headers(raw).forEach((v, k) => captureHeader(k, v));
      }
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__xflagGraphql = isGraphql(String(url));
      if (this.__xflagGraphql) noteUrl(String(url));
    } catch (_) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this.__xflagGraphql) captureHeader(name, value);
    } catch (_) {}
    return origSetHeader.apply(this, arguments);
  };

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function buildHeaders() {
    const h = {
      authorization: captured['authorization'] || 'Bearer ' + PUBLIC_BEARER,
      'x-csrf-token': getCookie('ct0') || captured['x-csrf-token'] || '',
      'x-twitter-active-user': captured['x-twitter-active-user'] || 'yes',
      'x-twitter-auth-type': captured['x-twitter-auth-type'] || 'OAuth2Session',
      'content-type': 'application/json',
    };
    if (captured['x-twitter-client-language']) {
      h['x-twitter-client-language'] = captured['x-twitter-client-language'];
    }
    return h;
  }

  // queryId が変わっていた場合、読み込み済みの JS チャンクから探す
  async function discoverQueryId() {
    if (discoveryTried) return false;
    discoveryTried = true;
    const urls = new Set();
    for (const e of performance.getEntriesByType('resource')) {
      if (/responsive-web\/client-web.*\.js(\?|$)/.test(e.name)) urls.add(e.name);
    }
    for (const s of document.querySelectorAll('script[src]')) {
      if (/responsive-web\/client-web.*\.js(\?|$)/.test(s.src)) urls.add(s.src);
    }
    const re = /queryId:"([\w-]+)",operationName:"AboutAccountQuery"/;
    for (const url of urls) {
      try {
        const text = await (await origFetch(url)).text();
        const m = text.match(re);
        if (m) {
          queryId = m[1];
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  async function fetchAbout(screenName, retried) {
    const variables = encodeURIComponent(JSON.stringify({ screenName }));
    const url = `${location.origin}/i/api/graphql/${queryId}/AboutAccountQuery?variables=${variables}`;
    let res;
    try {
      res = await origFetch(url, { method: 'GET', headers: buildHeaders(), credentials: 'include' });
    } catch (err) {
      return { ok: false, status: 0, error: String(err) };
    }

    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) || 0;
      return { ok: false, status: 429, reset };
    }
    if ((res.status === 400 || res.status === 404) && !retried) {
      if (await discoverQueryId()) return fetchAbout(screenName, true);
    }
    if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status };

    let json;
    try {
      json = await res.json();
    } catch (err) {
      return { ok: false, status: res.status, error: 'invalid json' };
    }
    const result = json && json.data && json.data.user_result_by_screen_name
      ? json.data.user_result_by_screen_name.result
      : null;
    const about = result && result.about_profile ? result.about_profile : null;
    if (!about && json && json.errors && json.errors.length) {
      return { ok: false, status: res.status, error: json.errors[0].message || 'graphql error' };
    }
    return {
      ok: true,
      status: res.status,
      about: about && {
        account_based_in: about.account_based_in || '',
        location_accurate: about.location_accurate,
        source: about.source || '',
      },
    };
  }

  document.addEventListener('xflag:request', async (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    const result = await fetchAbout(req.screenName, false);
    result.id = req.id;
    document.dispatchEvent(new CustomEvent('xflag:response', { detail: JSON.stringify(result) }));
  });
})();
