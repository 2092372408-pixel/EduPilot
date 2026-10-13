// Desktop launches live as long as at least one application page is connected.
// A persistent stream survives background-tab timer throttling; the grace period
// lets refreshes, navigation and brief network interruptions reconnect.
function createDesktopLifecycle({ onIdle, graceMs = 15000, startupMs = 120000 }) {
  const clients = new Set();
  let closed = false;
  let timer;
  function arm(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (clients.size || closed) return;
      closed = true;
      onIdle();
    }, delay);
    timer.unref?.();
  }
  arm(startupMs);
  return {
    get count() { return clients.size; },
    connect(res) {
      if (closed) { res.writeHead(503); res.end(); return; }
      clearTimeout(timer);
      clients.add(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
        'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff',
      });
      res.write(': connected\n\n');
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
      heartbeat.unref?.();
      res.once('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
        if (!clients.size && !closed) arm(graceMs);
      });
    },
    close() {
      closed = true;
      clearTimeout(timer);
      for (const res of clients) res.end();
    },
  };
}

module.exports = { createDesktopLifecycle };
