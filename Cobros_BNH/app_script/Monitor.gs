/* ============================================================================
 *  MONITOREO DEL SISTEMA — funciones que consume monitor.html
 * ========================================================================== */

const NOMBRE_HOJA_MONITOREO = 'MONITOREO';
const MAX_HISTORICO_MONITOREO = 500; // límite de filas guardadas, para no inflar la hoja

function obtenerOCrearHojaMonitoreo_() {
  const libro = SpreadsheetApp.openById(SHEET_ID);
  let hoja = libro.getSheetByName(NOMBRE_HOJA_MONITOREO);
  if (!hoja) {
    hoja = libro.insertSheet(NOMBRE_HOJA_MONITOREO);
    hoja.appendRow(['Fecha', 'Prueba', 'Estado', 'Detalle', 'ms']);
  }
  return hoja;
}

function registrarResultadoMonitoreo_(hoja, prueba, estado, detalle, ms) {
  hoja.appendRow([new Date().toISOString(), prueba, estado, detalle, ms]);
}

/* -------- Pruebas individuales -------- */

function probarAccesoSheet_() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(NOMBRE_HOJA);
  if (!sheet) throw new Error('No se encontró la hoja "' + NOMBRE_HOJA + '"');
  return 'Hoja "' + NOMBRE_HOJA + '" accesible (' + sheet.getLastRow() + ' filas)';
}

function probarAccesoDrive_() {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  return 'Carpeta de comprobantes accesible: ' + folder.getName();
}

function probarVisionAPI_() {
  // Imagen mínima (1x1 px) solo para confirmar que la API responde sin error.
  const base64Prueba = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const url = 'https://vision.googleapis.com/v1/images:annotate';
  const payload = { requests: [{ image: { content: base64Prueba }, features: [{ type: 'TEXT_DETECTION' }] }] };
  const opciones = {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  const resp = UrlFetchApp.fetch(url, opciones);
  const codigo = resp.getResponseCode();
  if (codigo !== 200) throw new Error('Vision API respondió código ' + codigo);
  return 'Vision API respondió correctamente (200)';
}

function probarCuotaCorreo_() {
  const restante = MailApp.getRemainingDailyQuota();
  if (restante <= 0) throw new Error('Cuota diaria de correo agotada');
  return 'Cuota de correo restante: ' + restante;
}

/* -------- Orquestación -------- */

function ejecutarPruebasMonitoreo_() {
  const hoja = obtenerOCrearHojaMonitoreo_();
  const pruebas = [
    { nombre: 'Acceso a Sheet',            fn: probarAccesoSheet_ },
    { nombre: 'Acceso a Drive',            fn: probarAccesoDrive_ },
    { nombre: 'Cloud Vision API',          fn: probarVisionAPI_ },
    { nombre: 'Cuota de correo (MailApp)', fn: probarCuotaCorreo_ }
  ];

  pruebas.forEach(p => {
    const inicio = Date.now();
    let estado = 'OK', detalle = '';
    try {
      detalle = p.fn();
    } catch (err) {
      estado = 'ERROR';
      detalle = err.message;
    }
    registrarResultadoMonitoreo_(hoja, p.nombre, estado, detalle, Date.now() - inicio);
  });

  // Poda el histórico para que la hoja no crezca indefinidamente
  const ultimaFila = hoja.getLastRow();
  if (ultimaFila - 1 > MAX_HISTORICO_MONITOREO) {
    hoja.deleteRows(2, ultimaFila - 1 - MAX_HISTORICO_MONITOREO);
  }
}

/** Botón "Probar ahora" en monitor.html */
function ejecutarPruebaManualAhora() {
  ejecutarPruebasMonitoreo_();
  return obtenerDatosMonitoreo();
}

/** Carga inicial / botón "Actualizar" en monitor.html */
function obtenerDatosMonitoreo() {
  try {
    const hoja = obtenerOCrearHojaMonitoreo_();
    const ultimaFila = hoja.getLastRow();
    if (ultimaFila < 2) {
      return { sinDatos: true, activo: monitoreoActivo_() };
    }

    const datos = hoja.getRange(2, 1, ultimaFila - 1, 5).getValues();
    const historico = datos.map(f => ({
      fecha: f[0] instanceof Date ? f[0].toISOString() : f[0],
      prueba: f[1], estado: f[2], detalle: f[3], ms: f[4]
    }));

    const ultimoPorPrueba = {};
    historico.forEach(r => { ultimoPorPrueba[r.prueba] = r; });

    const disponibilidad = {};
    Object.keys(ultimoPorPrueba).forEach(nombre => {
      const registros = historico.filter(r => r.prueba === nombre).slice(-20);
      const okCount = registros.filter(r => r.estado === 'OK').length;
      disponibilidad[nombre] = registros.length ? Math.round((okCount / registros.length) * 100) : 100;
    });

    const estadoGeneral = Object.values(ultimoPorPrueba).some(r => r.estado !== 'OK') ? 'ERROR' : 'OK';

    return { sinDatos: false, activo: monitoreoActivo_(), estadoGeneral, ultimoPorPrueba, disponibilidad, historico };
  } catch (err) {
    console.error('❌ Error en obtenerDatosMonitoreo: ' + err.message);
    return { sinDatos: true, activo: false };
  }
}

function monitoreoActivo_() {
  return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'ejecutarPruebasMonitoreo_');
}

/** Ejecuta esta función UNA VEZ manualmente desde el editor para activar
 *  el monitoreo automático cada hora. */
function crearTriggerMonitoreo() {
  eliminarTriggerMonitoreo();
  ScriptApp.newTrigger('ejecutarPruebasMonitoreo_').timeBased().everyHours(1).create();
}

function eliminarTriggerMonitoreo() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'ejecutarPruebasMonitoreo_') ScriptApp.deleteTrigger(t);
  });
}