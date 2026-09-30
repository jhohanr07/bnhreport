/* ============================================================================
 * API PARA VERCEL  —  PEGAR EN Code.gs
 *
 * 1) REEMPLAZA solo la función doGet por la de abajo (agrega 2 líneas al inicio;
 *    el resto es idéntico a tu doGet actual).
 * 2) AGREGA doPost, jsonOut_ y pinValido_ (funciones nuevas).
 * Todo lo demás de Code.gs queda SIN CAMBIOS.
 * ========================================================================== */

function doGet(e) {
  const params = (e && e.parameter) || {};

  // NUEVO: prueba rápida de que la API responde -> .../exec?action=ping
  if (String(params.action || '') === 'ping') return jsonOut_({ ok: true, data: 'pong' });

  const page = String(params.page || '').toLowerCase().trim();
  const isAdmin = page === 'admin';
  const isMonitor = page === 'monitor';

  try {
    const nombrePlantilla = isMonitor ? 'monitor' : (isAdmin ? 'admin' : 'index');
    const template = HtmlService.createTemplateFromFile(nombrePlantilla);

    let titulo = 'Reporte de Pago · BNH Medical';
    if (isAdmin)   titulo = 'Panel Administrativo · BNH Medical';
    if (isMonitor) titulo = 'Monitoreo · BNH Medical';

    return template.evaluate()
      .setTitle(titulo)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    console.error('❌ Error en doGet: ' + err.message);
    return HtmlService.createHtmlOutput(
      '<p>Ocurrió un error al cargar la página. Contacta al administrador.</p>'
    ).setTitle('Error · BNH Medical');
  }
}

/**
 * NUEVO: punto de entrada para el frontend alojado en Vercel.
 * Recibe { fn, args, pin } y ejecuta SOLO funciones de una lista blanca.
 */
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const fn = req.fn;
    const args = req.args || [];
    let data;

    switch (fn) {
      case 'procesarFormulario':
        data = procesarFormulario(args[0]);
        break;
      case 'obtenerVendedores':
        data = obtenerVendedores();
        break;
      case 'validarPin':
        data = pinValido_(args[0]);
        break;
      case 'obtenerPagos':
        if (!pinValido_(req.pin)) throw new Error('UNAUTHORIZED');
        data = obtenerPagos();
        break;
      default:
        throw new Error('Función no permitida: ' + fn);
    }
    return jsonOut_({ ok: true, data: data });
  } catch (err) {
    console.error('❌ Error en doPost: ' + err.message);
    return jsonOut_({ ok: false, error: err.message });
  }
}

/** NUEVO: respuesta JSON estándar */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * NUEVO: valida la clave del panel en el SERVIDOR (ya no queda visible en el código
 * público). Para cambiarla: Configuración del proyecto > Propiedades del script >
 * agregar ADMIN_PIN. Si no existe, se usa la clave actual 'BNH2025'.
 */
function pinValido_(pin) {
  const esperado = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || 'BNH2025';
  return String(pin || '').trim() === esperado;
}
