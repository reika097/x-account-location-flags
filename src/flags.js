// 国名（X が返す表示名）→ ISO 3166-1 alpha-2 コードの変換と、国旗画像 URL の生成。
// X の UI 言語によって国名が英語以外で返る可能性があるため、Intl.DisplayNames で
// 複数言語の国名辞書を作る。
const XFlags = (() => {
  // 国ではない地域コード（EU など）は国旗扱いしない
  const EXCLUDE = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);

  const ALIASES = {
    'united states of america': 'US', usa: 'US', 'u s': 'US', america: 'US',
    uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB',
    wales: 'GB', 'northern ireland': 'GB',
    korea: 'KR', 'republic of korea': 'KR', 'south korea': 'KR', 'north korea': 'KP',
    russia: 'RU', 'russian federation': 'RU',
    turkey: 'TR', turkiye: 'TR',
    'czech republic': 'CZ', czechia: 'CZ',
    'hong kong': 'HK', macau: 'MO', macao: 'MO', taiwan: 'TW',
    vietnam: 'VN', 'viet nam': 'VN',
    'ivory coast': 'CI', 'cote d ivoire': 'CI',
    burma: 'MM', myanmar: 'MM',
    congo: 'CG', 'republic of the congo': 'CG', 'dr congo': 'CD', drc: 'CD',
    'democratic republic of the congo': 'CD',
    palestine: 'PS', 'palestinian territories': 'PS',
    swaziland: 'SZ', eswatini: 'SZ', 'cape verde': 'CV', 'east timor': 'TL',
    vatican: 'VA', 'vatican city': 'VA', 'holy see': 'VA',
    macedonia: 'MK', 'north macedonia': 'MK',
    bosnia: 'BA', 'bosnia and herzegovina': 'BA',
    uae: 'AE', 'united arab emirates': 'AE',
    bahamas: 'BS', gambia: 'GM', micronesia: 'FM', laos: 'LA', iran: 'IR', syria: 'SY',
    moldova: 'MD', tanzania: 'TZ', bolivia: 'BO', venezuela: 'VE', brunei: 'BN',
    'saint kitts and nevis': 'KN', 'saint lucia': 'LC',
    'saint vincent and the grenadines': 'VC', 'sao tome and principe': 'ST',
  };

  function norm(s) {
    return String(s)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  const map = new Map();
  for (const [k, v] of Object.entries(ALIASES)) map.set(norm(k), v);

  const uiLang = typeof chrome !== 'undefined' && chrome.i18n ? chrome.i18n.getUILanguage() : '';
  const langs = [
    ...new Set(['en', uiLang, navigator.language, document.documentElement.lang].filter(Boolean)),
  ];
  for (const lang of langs) {
    let dn;
    try {
      dn = new Intl.DisplayNames([lang], { type: 'region', fallback: 'none' });
    } catch (_) {
      continue;
    }
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        const code = String.fromCharCode(65 + i, 65 + j);
        if (EXCLUDE.has(code)) continue;
        let name;
        try {
          name = dn.of(code);
        } catch (_) {
          continue;
        }
        if (name && name !== code) {
          const key = norm(name);
          if (!map.has(key)) map.set(key, code);
        }
      }
    }
  }

  function codeFor(name) {
    if (!name) return null;
    const n = norm(name);
    return map.get(n) || map.get(n.replace(/^the /, '')) || null;
  }

  // X 自身が配信している Twemoji 画像を使う（Windows は国旗絵文字を描画できないため）
  const EMOJI_BASE = 'https://abs-0.twimg.com/emoji/v2/svg/';

  function flagEmoji(code) {
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }

  function flagUrl(code) {
    const cps = [...code].map((c) => (0x1f1e6 + c.charCodeAt(0) - 65).toString(16));
    return EMOJI_BASE + cps.join('-') + '.svg';
  }

  const globeUrl = EMOJI_BASE + '1f310.svg';

  return { codeFor, flagEmoji, flagUrl, globeUrl };
})();
