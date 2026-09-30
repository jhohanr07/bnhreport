/**
 * gas-shim.js
 * Emula google.script.run para que index.html / admin.html / monitor.html
 * sigan funcionando FUERA de Apps Script (por ejemplo en Vercel),
 * hablando con tu Web App de Apps Script mediante fetch.
 *
 * >>> ÚNICO VALOR A EDITAR: GAS_URL <<<
 */
(function () {
  // Pega aquí la URL de tu implementación de Apps Script (termina en /exec)
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbx1mCL5TSG_pbSlk4k9WKQptGMgHVb68YJAXL0ALjDI8zKPxjmU4PrLCHw_miVjpXx2/exec';

  function obtenerPin(fn) {
    var pin = sessionStorage.getItem('bnh_pin') || '';
    // Si una página (ej. monitor) pide pagos sin haber pasado por el login, se pide la clave.
    if (!pin && fn === 'obtenerPagos') {
      pin = (window.prompt('Clave de acceso:') || '').trim();
      if (pin) sessionStorage.setItem('bnh_pin', pin);
    }
    return pin;
  }

  function llamar(fn, args) {
    return fetch(GAS_URL, {
      method: 'POST',
      // text/plain evita el preflight CORS (Apps Script no responde OPTIONS)
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args, pin: obtenerPin(fn) }),
      redirect: 'follow'
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) {
          if (j.error === 'UNAUTHORIZED') sessionStorage.removeItem('bnh_pin');
          throw new Error(j.error || 'Error desconocido');
        }
        return j.data;
      });
  }

  function crearRunner(ok, fail) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (f) { return crearRunner(f, fail); };
        if (prop === 'withFailureHandler') return function (f) { return crearRunner(ok, f); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          llamar(String(prop), args)
            .then(function (d) { if (ok) ok(d); })
            .catch(function (e) { if (fail) fail(e); else console.error(e); });
        };
      }
    });
  }

  window.google = { script: { run: crearRunner(null, null) } };
})();
