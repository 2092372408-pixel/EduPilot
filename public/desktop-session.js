// Included only for desktop launches. Every application page keeps the service
// alive, including report, upload, practice and exam tabs.
(() => {
  let connection;
  function connect() {
    if (!connection) connection = new EventSource('/api/desktop/events');
  }
  window.addEventListener('pagehide', () => {
    connection?.close();
    connection = null;
  });
  window.addEventListener('pageshow', connect);
  connect();
})();
