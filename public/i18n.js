/* Explicit UI localization. User-authored text is never traversed or replaced. */
(function () {
  const requestedLanguage = new URLSearchParams(location.search).get('lang');
  if (requestedLanguage === 'en' || requestedLanguage === 'zh') localStorage.setItem('eduowl_lang', requestedLanguage);
  // Another tab may change the preference; this document keeps its own language.
  const language = localStorage.getItem('eduowl_lang') === 'en' ? 'en' : 'zh';
  window.eduLanguage = () => language;
  window.eduUrl = (path) => {
    const url = new URL(path, location.href);
    if (url.origin === location.origin) url.searchParams.set('lang', language);
    return url.href;
  };
  document.documentElement.lang = eduLanguage();
  window.eduLocale = () => eduLanguage() === 'en' ? 'en-US' : 'zh-CN';
  window.ui = (text) => eduLanguage() === 'en' ? (EduEnglish[text] ?? text) : text;
  window.eduFetch = (input, options = {}) => {
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('Accept-Language', eduLanguage());
    return fetch(input, { ...options, headers });
  };
  window.applyUiLanguage = () => {
    document.documentElement.lang = eduLanguage();
    document.querySelectorAll('[data-ui]').forEach(el => { el.textContent = ui(el.dataset.ui); });
    for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
      document.querySelectorAll('[data-ui-' + attr + ']').forEach(el => {
        el.setAttribute(attr, ui(el.getAttribute('data-ui-' + attr)));
      });
    }
  };
  document.addEventListener('DOMContentLoaded', applyUiLanguage);
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (link && /^(\/|https?:)/.test(link.getAttribute('href'))) link.href = eduUrl(link.href);
  });
})();
