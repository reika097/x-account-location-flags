// プロフィール画面とホバーカード（名前にマウスを乗せると出るプロフィール）の
// @ID の右側に、所在国の国旗と VPN マークを挿入する。
// タイムラインやスレッドは対象外（大量のリクエストで表示が遅くなるため）。
//
// X には旧 DOM（data-testid あり）と新 DOM（data-testid なし）があるため、
// testid に頼らず「@ID というテキストの要素」を探して挿入位置を決める。
(() => {
  const DEFAULTS = { enabled: true, showVpn: true, intervalSec: 1, ttlDays: 14 };
  const NONE_TTL_MS = 24 * 60 * 60 * 1000; // 情報なしの結果は 1 日だけキャッシュ
  const HANDLE_RE = /^@([A-Za-z0-9_]{1,15})$/;

  let settings = { ...DEFAULTS };
  const mem = new Map(); // handle(小文字) -> info | null
  const inflight = new Map(); // handle -> Promise<info|null>
  const waiters = new Map(); // handle -> resolve[]
  const queue = []; // 取得待ちの handle（新しいものから処理）
  const badges = new WeakMap(); // @ID 要素 -> 挿入したバッジ
  let working = false;
  let pausedUntil = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- page.js との通信 ----------
  const callbacks = new Map();
  let seq = 0;
  document.addEventListener('xflag:response', (e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    const cb = callbacks.get(d.id);
    if (cb) {
      callbacks.delete(d.id);
      cb(d);
    }
  });

  function pageRequest(screenName) {
    return new Promise((resolve) => {
      const id = ++seq;
      callbacks.set(id, resolve);
      document.dispatchEvent(
        new CustomEvent('xflag:request', { detail: JSON.stringify({ id, screenName }) })
      );
      setTimeout(() => {
        if (callbacks.has(id)) {
          callbacks.delete(id);
          resolve({ id, ok: false, status: 0, error: 'timeout' });
        }
      }, 20000);
    });
  }

  // ---------- ステータス（ポップアップ表示用） ----------
  function setStatus(patch) {
    chrome.storage.local.get('status').then(({ status }) => {
      chrome.storage.local.set({ status: { ...(status || {}), ...patch, updatedAt: Date.now() } });
    });
  }

  // ---------- 取得キュー ----------
  function enqueue(key) {
    return new Promise((resolve) => {
      if (!waiters.has(key)) {
        waiters.set(key, []);
        queue.push(key);
      }
      waiters.get(key).push(resolve);
      work();
    });
  }

  function settle(key, info) {
    const list = waiters.get(key) || [];
    waiters.delete(key);
    list.forEach((r) => r(info));
  }

  async function work() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const wait = pausedUntil - Date.now();
        if (wait > 0) {
          await sleep(Math.min(wait, 5000));
          continue;
        }
        const key = queue.pop();
        const res = await pageRequest(key);

        if (res.status === 429) {
          queue.push(key);
          pausedUntil = res.reset ? res.reset * 1000 + 1000 : Date.now() + 60000;
          setStatus({ rateLimitedUntil: pausedUntil });
          continue;
        }

        let info = null;
        if (res.ok) {
          const a = res.about;
          info = a && a.account_based_in
            ? { c: a.account_based_in, a: a.location_accurate !== false, s: a.source || '', t: Date.now() }
            : { none: true, t: Date.now() };
          chrome.storage.local.set({ ['u:' + key]: info });
          setStatus({ lastOkAt: Date.now(), lastError: '', rateLimitedUntil: 0 });
        } else {
          setStatus({ lastError: `@${key}: ${res.error || 'HTTP ' + res.status}` });
        }
        // 失敗時も null を入れて、このページ表示中は再リクエストしない
        mem.set(key, info);
        settle(key, info);
        await sleep(Math.max(0.5, Number(settings.intervalSec) || DEFAULTS.intervalSec) * 1000);
      }
    } finally {
      working = false;
    }
  }

  function isFresh(info) {
    if (!info || !info.t) return false;
    const ttl = info.none ? NONE_TTL_MS : settings.ttlDays * 24 * 60 * 60 * 1000;
    return Date.now() - info.t < ttl;
  }

  function getInfo(key) {
    if (mem.has(key)) return Promise.resolve(mem.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const stored = (await chrome.storage.local.get('u:' + key))['u:' + key];
      if (isFresh(stored)) {
        mem.set(key, stored);
        return stored;
      }
      return enqueue(key);
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // ---------- @ID 要素の検出 ----------
  // バッジ自身のテキスト（"VPN"）を除いたテキスト
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 1 && n.classList.contains('xflag')) continue;
      t += n.textContent;
    }
    return t.trim();
  }

  function handleOf(span) {
    const m = ownText(span).match(HANDLE_RE);
    if (!m) return null;
    // 同じテキストを持つ子 span があれば、より内側のほうを使う
    for (const c of span.children) {
      if (c.tagName === 'SPAN' && ownText(c) === ownText(span)) return null;
    }
    return m[1];
  }

  // プロフィール画面: URL の @ID と一致する、ヘッダー部分の要素
  function findProfileHandle() {
    const pathHandle = location.pathname.split('/')[1] || '';
    if (!/^[A-Za-z0-9_]{1,15}$/.test(pathHandle)) return null;
    const want = pathHandle.toLowerCase();

    const scope = document.querySelector('[data-testid="UserName"]') || document.querySelector('main');
    if (!scope) return null;

    // タイムラインの投稿（article）に入る前までを探す
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.tagName === 'ARTICLE') break;
      if (n.tagName !== 'SPAN' || n.closest('.xflag')) continue;
      const h = handleOf(n);
      if (h && h.toLowerCase() === want) return n;
    }
    return null;
  }

  // ホバーカード: 旧 DOM は data-testid="HoverCard"、新 DOM はアプリ本体の外に出るポップアップ
  function hoverCards() {
    const cards = [...document.querySelectorAll('[data-testid="HoverCard"]')];
    const main = document.querySelector('main');
    if (!main) return cards;
    const appRoot = [...document.body.children].find((c) => c.contains(main));
    for (const c of document.body.children) {
      if (c === appRoot || c.tagName !== 'DIV' || !c.childElementCount) continue;
      cards.push(c);
    }
    return cards;
  }

  function findCardHandle(card) {
    for (const span of card.querySelectorAll('span')) {
      if (span.closest('.xflag')) continue;
      if (handleOf(span)) return span; // 最初に出てくる @ID がカードの持ち主
    }
    return null;
  }

  // ---------- 描画 ----------
  function buildBadge(info) {
    const code = XFlags.codeFor(info.c);
    const vpn = info.a === false;

    const badge = document.createElement('span');
    badge.className = 'xflag';

    const img = document.createElement('img');
    img.className = 'xflag-img';
    img.src = code ? XFlags.flagUrl(code) : XFlags.globeUrl;
    img.alt = code ? XFlags.flagEmoji(code) : '🌐';
    img.draggable = false;
    badge.appendChild(img);

    if (vpn && settings.showVpn) {
      const v = document.createElement('span');
      v.className = 'xflag-vpn';
      v.textContent = 'VPN';
      badge.appendChild(v);
    }

    const t = (key, subs) => chrome.i18n.getMessage(key, subs);
    const lines = [t('tooltipBasedIn', [info.c])];
    if (info.s) lines.push(t('tooltipSource', [info.s]));
    if (vpn) lines.push(t('tooltipVpn'));
    badge.title = lines.join('\n');
    // リンクの中に入っても、バッジのクリックでプロフィールへ飛ばないようにする
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    return badge;
  }

  function isColumnLayout(el) {
    const cs = getComputedStyle(el);
    if (cs.display.includes('grid')) return true;
    return cs.display.includes('flex') && cs.flexDirection.startsWith('column');
  }

  // @ID の右側（同じ行）にバッジを入れる
  function insertBadge(span, badge) {
    let node = span;
    // リンクの外側に出す
    while (node.parentElement && node.parentElement.tagName === 'A') node = node.parentElement;
    const parent = node.parentElement;
    if (parent && !isColumnLayout(parent)) {
      node.after(badge); // 横並び or 通常のテキストの流れ → 直後に置けば同じ行
    } else {
      span.appendChild(badge); // 縦並びの場合は @ID の要素の中に入れて同じ行に
    }
  }

  function removeBadge(span) {
    const old = badges.get(span);
    if (old) old.remove();
    badges.delete(span);
  }

  function render(span, info) {
    removeBadge(span);
    if (!settings.enabled || !info || info.none || !info.c) return;
    const badge = buildBadge(info);
    insertBadge(span, badge);
    badges.set(span, badge);
  }

  function processTarget(span) {
    const handle = handleOf(span);
    if (!handle) return;
    const key = handle.toLowerCase();
    if (span.dataset.xflag === key) {
      const b = badges.get(span);
      if (b && b.isConnected) return; // 描画済み
      if (!mem.has(key)) return; // 取得待ち
      const info = mem.get(key);
      if (!info || info.none) return; // 表示するものがない
    }
    span.dataset.xflag = key;
    removeBadge(span);
    getInfo(key).then((info) => {
      if (span.isConnected && span.dataset.xflag === key) render(span, info);
    });
  }

  function scan() {
    if (!settings.enabled) return;
    const profile = findProfileHandle();
    if (profile) processTarget(profile);
    for (const card of hoverCards()) {
      const span = findCardHandle(card);
      if (span) processTarget(span);
    }
  }

  function resetAll() {
    document.querySelectorAll('.xflag').forEach((n) => n.remove());
    document.querySelectorAll('[data-xflag]').forEach((el) => delete el.dataset.xflag);
  }

  let scheduled = false;
  const mo = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  });

  // ---------- 設定 ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      resetAll();
      scan();
    }
    // ポップアップからキャッシュ削除された場合
    if (changes.cacheClearedAt) {
      mem.clear();
      resetAll();
      scan();
    }
  });

  // 期限切れのキャッシュを 1 日 1 回削除する（storage の上限 10MB 対策）
  async function pruneCache() {
    const { lastPruneAt = 0 } = await chrome.storage.local.get('lastPruneAt');
    if (Date.now() - lastPruneAt < 24 * 60 * 60 * 1000) return;
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith('u:') && !isFresh(all[k]));
    if (stale.length) await chrome.storage.local.remove(stale);
    await chrome.storage.local.set({ lastPruneAt: Date.now() });
  }

  chrome.storage.local.get('settings').then(({ settings: s }) => {
    settings = { ...DEFAULTS, ...(s || {}) };
    pruneCache();
    scan();
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
})();
