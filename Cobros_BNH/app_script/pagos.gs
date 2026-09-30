/**
 * ============================================================================
 *  BNH Medical · Sistema Unificado de Pagos
 *  Web App (reporte + panel admin) + OCR automático de comprobantes (Cloud Vision)
 * ============================================================================

 */

// ===================== CONFIGURACIÓN GENERAL =====================
const SHEET_ID = '1cRIKmKsITlmhkCwccEIMaT7faVhYtPVagD3NIT1QbaA';
const NOMBRE_HOJA = 'PAGOS';
const DRIVE_FOLDER_ID = '1X7JIDp4FiV-8tM-9cHo1ISJ_tD4VYTKO'; // carpeta de comprobantes

// NUEVO: carpeta de Drive donde se guardan los RIF adjuntos (Inicial / Reserva).
// Reemplaza el valor por el ID real de tu carpeta de Drive (ver instrucciones
// al final de este archivo, sección "CONFIGURACIÓN DEL RIF").
const DRIVE_FOLDER_ID_RIF = '1MoxUIO5-s9MQ1M3By3CI_sDoBeQ65-CQ';

// NUEVO: configuración de la lista de vendedores. Se asume que la hoja
// "VENDEDORES" vive en el MISMO spreadsheet (SHEET_ID) que la hoja "PAGOS",
// ya que ambas pertenecen al archivo "RECIBO DE PAGOS BNH VIVA". Si en tu
// caso es un archivo distinto, cambia SHEET_ID_VENDEDORES por el ID de ese
// otro spreadsheet.
const SHEET_ID_VENDEDORES = SHEET_ID;
const NOMBRE_HOJA_VENDEDORES = 'VENDEDORES';
const COL_VENDEDOR_LISTA = 2;      // columna B
const FILA_INICIO_VENDEDORES = 2;
const FILA_FIN_VENDEDORES = 50;

// Columnas (1-indexed) — deben coincidir con los encabezados reales de la hoja
const COL_FECHA_REGISTRO = 1;  // A
const COL_NOMBRE         = 2;  // B
const COL_FECHA_PAGO     = 3;  // C
const COL_TIPO_PAGO      = 4;  // D
const COL_MONEDA         = 5;  // E
const COL_TITULAR        = 6;  // F
const COL_ARCHIVO        = 7;  // G  -> URL del comprobante (usada por el OCR)
const COL_REFERENCIA     = 8;  // H  -> resultado OCR
const COL_MONTO          = 9;  // I  -> resultado OCR
const COL_BENEFICIARIO   = 10; // J  -> resultado OCR
const COL_CORREO         = 11; // K  -> correo electrónico ingresado en el formulario
const COL_CONCEPTO_PAGO  = 12; // L  -> Concepto de pago (Inicial / Reserva / pago IVA / Cuota viva)
const COL_TELEFONO       = 13; // M  -> Teléfono ingresado en el formulario
const COL_RIF            = 14; // N  -> URL del RIF adjunto (Inicial / Reserva)
const COL_VENDEDOR       = 15; // O  -> VENDEDOR (Inicial / Reserva)
const COL_EMPRESA        = 18; // R  -> NUEVO: EMPRESA (usada por el filtro del panel admin)

// Valores de "Tipo de pago" (columna D) que activan el escaneo de SERIALES
// DE BILLETES en lugar del flujo tradicional de Referencia/Monto/Beneficiario.
const TIPOS_PAGO_EFECTIVO = ['EFECTIVO', 'CASH', 'DIVISAS', 'EFECTIVO BS', 'EFECTIVO USD'];

// Valor EXACTO de "Tipo de pago" (columna D) para el cual el Monto (columna I)
// NO se calcula por OCR, sino que viene directamente del formulario web
// (campo "montoManual"). Comparación exacta a propósito: variantes como
// "Efectivo BS" o "Efectivo USD" siguen usando extraerMontoEfectivo() normalmente.
const TIPO_PAGO_MONTO_MANUAL = 'EFECTIVO';

// Valores de "Concepto de pago" (columna L) que exigen adjuntar el RIF y
// seleccionar el Vendedor en el formulario. Comparación en mayúsculas
// contra formData.conceptoPago.
const CONCEPTOS_QUE_REQUIEREN_RIF = ['INICIAL', 'RESERVA'];

/* ============================================================================
 * VALIDACIÓN DE PAGOS DUPLICADOS (columna H - Referencia)
 * ========================================================================== */

// Valores que NUNCA deben considerarse "duplicados" entre sí, aunque coincidan
// textualmente (son placeholders de error o "sin dato", no referencias reales).
const VALORES_REFERENCIA_IGNORADOS = new Set([
  '', 'NO ENCONTRADA', 'NO ENCONTRADO', 'NO DETECTADO',
  'ERROR OCR', 'ERROR AL LEER SERIALES', 'NO SE DETECTÓ TEXTO'
]);

/**
 * Verifica si una Referencia (columna H) ya existe previamente en la hoja
 * PAGOS. Optimizada para leer ÚNICAMENTE el rango H2:H(filaTope) — nunca la
 * hoja completa — minimizando el consumo de cuota de Sheets.
 *
 * @param {Sheet} hoja Hoja "PAGOS"
 * @param {string} referencia Valor detectado en la columna H a validar
 * @param {number} [filaExcluir] Fila que debe excluirse de la comparación
 *        (la fila recién insertada, para no compararla consigo misma)
 * @return {boolean} true si ya existe una referencia igual (normalizada)
 */
function referenciaYaExiste(hoja, referencia, filaExcluir) {
  const refNormalizada = String(referencia || '').trim().toUpperCase();

  if (!refNormalizada || VALORES_REFERENCIA_IGNORADOS.has(refNormalizada)) {
    return false; // nunca bloqueamos por valores vacíos/errores de OCR
  }

  const ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return false;

  const filaTope = filaExcluir ? Math.min(filaExcluir - 1, ultimaFila) : ultimaFila;
  if (filaTope < 2) return false;

  const numFilas = filaTope - 1; // filas 2..filaTope
  // Lectura mínima: SOLO columna H, ninguna otra columna.
  const valores = hoja.getRange(2, COL_REFERENCIA, numFilas, 1).getValues();

  for (let i = 0; i < valores.length; i++) {
    const valor = String(valores[i][0] || '').trim().toUpperCase();
    if (valor && valor === refNormalizada) return true;
  }
  return false;
}


/* ============================================================================
 * WEB APP: doGet, procesarFormulario, obtenerPagos, obtenerVendedores
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

// Campos obligatorios que debe traer formData para poder procesar el pago.
const CAMPOS_REQUERIDOS_FORMULARIO = [
  'archivoBase64', 'nombreArchivo', 'nombre', 'fechaPago', 'conceptoPago', 'tipoPago', 'moneda', 'titular', 'telefono'
];

// Formato esperado para el teléfono -> +58 seguido de 10 dígitos
// (código de ciudad/operadora + número), ej. +584121234567
const REGEX_TELEFONO = /^\+58\d{10}$/;

/**
 * Determina si, para el "Tipo de pago" recibido en el formulario, el Monto
 * debe venir directamente del campo manual "montoManual" en vez de
 * calcularse por OCR. Comparación EXACTA (no "contiene"): solo aplica
 * cuando el usuario eligió exactamente "Efectivo".
 * @param {string} tipoPago Valor crudo de formData.tipoPago
 * @return {boolean}
 */
function requiereMontoManual(tipoPago) {
  return String(tipoPago || '').trim().toUpperCase() === TIPO_PAGO_MONTO_MANUAL;
}

/**
 * Determina si, para el "Concepto de pago" recibido en el formulario, es
 * obligatorio adjuntar el RIF y seleccionar el Vendedor (Inicial / Reserva).
 * @param {string} conceptoPago Valor crudo de formData.conceptoPago
 * @return {boolean}
 */
function requiereRif(conceptoPago) {
  return CONCEPTOS_QUE_REQUIEREN_RIF.includes(String(conceptoPago || '').trim().toUpperCase());
}

/**
 * Valida que formData traiga todos los campos obligatorios y que el
 * archivo venga en formato Data URL válido ("data:<mime>;base64,<datos>").
 * Si el Tipo de pago es exactamente "Efectivo", exige además el campo
 * "montoManual" (numérico, mayor a 0).
 * Valida además que "telefono" respete el formato +58 + 10 dígitos.
 * Si el Concepto de pago es "Inicial" o "Reserva", exige que venga el
 * archivo del RIF ("archivoRifBase64" / "nombreArchivoRif") en formato
 * Data URL válido, y también el campo "vendedor".
 * No modifica nada en la hoja; solo determina si procesarFormulario()
 * puede continuar con seguridad.
 * @param {Object} formData
 * @return {{valido: boolean, error: string}}
 */
function validarFormData(formData) {
  if (!formData || typeof formData !== 'object') {
    return { valido: false, error: 'No se recibieron datos del formulario.' };
  }

  for (const campo of CAMPOS_REQUERIDOS_FORMULARIO) {
    if (!formData[campo]) {
      return { valido: false, error: 'Falta el campo obligatorio: ' + campo };
    }
  }

  // Validación de formato del teléfono (+58 + 10 dígitos)
  const telefonoLimpio = String(formData.telefono || '').trim();
  if (!REGEX_TELEFONO.test(telefonoLimpio)) {
    return { valido: false, error: 'El teléfono debe tener el formato +58 seguido del código y número (Ej: +584121234567).' };
  }

  const partes = String(formData.archivoBase64).split(',');
  const match = partes[0] && partes[0].match(/data:(.*);base64/);
  if (partes.length < 2 || !match) {
    return { valido: false, error: 'El archivo del comprobante no tiene un formato Base64 válido.' };
  }

  // Si el Tipo de pago es exactamente "Efectivo", el monto NO se detecta por
  // OCR: debe venir del formulario en el campo "montoManual".
  if (requiereMontoManual(formData.tipoPago)) {
    const montoManual = Number(formData.montoManual);
    if (!formData.montoManual || isNaN(montoManual) || montoManual <= 0) {
      return { valido: false, error: 'Falta el campo obligatorio: montoManual (monto del pago en efectivo)' };
    }
  }

  // Si el Concepto de pago es "Inicial" o "Reserva", el RIF y el Vendedor
  // son obligatorios.
  if (requiereRif(formData.conceptoPago)) {
    if (!formData.archivoRifBase64 || !formData.nombreArchivoRif) {
      return { valido: false, error: 'Debes adjuntar el RIF para el concepto de pago seleccionado (' + formData.conceptoPago + ').' };
    }
    const partesRif = String(formData.archivoRifBase64).split(',');
    const matchRif = partesRif[0] && partesRif[0].match(/data:(.*);base64/);
    if (partesRif.length < 2 || !matchRif) {
      return { valido: false, error: 'El archivo del RIF no tiene un formato Base64 válido.' };
    }

    // NUEVO: Vendedor obligatorio cuando el Concepto es Inicial/Reserva.
    if (!formData.vendedor || !String(formData.vendedor).trim()) {
      return { valido: false, error: 'Debes seleccionar el Vendedor para el concepto de pago seleccionado (' + formData.conceptoPago + ').' };
    }
  }

  return { valido: true, error: '' };
}

/**
 * Recibe el formulario público, sube el comprobante a Drive,
 * agrega la fila (A-G) y dispara el OCR automáticamente sobre esa fila.
 * Si viene un RIF adjunto (obligatorio cuando el Concepto de pago es
 * "Inicial" o "Reserva"), también lo sube a Drive y guarda su URL en la
 * columna N. En ese mismo caso, guarda el Vendedor en la columna O.
 */
function procesarFormulario(formData) {
  try {
    const validacion = validarFormData(formData);
    if (!validacion.valido) {
      console.error('❌ Formulario rechazado: ' + validacion.error);
      return { success: false, error: validacion.error };
    }

    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(NOMBRE_HOJA);
    if (!sheet) {
      return { success: false, error: 'No se encontró la hoja "' + NOMBRE_HOJA + '" en el spreadsheet.' };
    }

    // 1. Guardar el comprobante en Drive
    const partes = formData.archivoBase64.split(',');
    const contentType = partes[0].match(/data:(.*);base64/)[1];
    const bytes = Utilities.base64Decode(partes[1]);
    const blob = Utilities.newBlob(bytes, contentType, formData.nombreArchivo);

    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const comprobanteUrl = file.getUrl();

    // 2. Agregar la fila (columnas A-G)
    // IMPORTANTE: appendRow solo escribe A-G. Las columnas H-J las llena el
    // OCR más abajo, y K, L, M, N y O (correo, concepto, teléfono, RIF,
    // vendedor) se escriben explícitamente por número de columna para no
    // desplazar ni desordenar los datos existentes.
    sheet.appendRow([
      new Date(),              // A - Fecha registro
      formData.nombre,         // B - Nombre
      formData.fechaPago,      // C - Fecha pago (yyyy-mm-dd)
      formData.tipoPago,       // D - Tipo de pago (Zelle / Bs / Binance / Efectivo)
      formData.moneda,         // E - Moneda (USD / Bs / USDT / Efectivo)
      formData.titular,        // F - Titular cuenta origen
      comprobanteUrl           // G - URL del comprobante
    ]);

    const fila = sheet.getLastRow();

    // 2b. Guardar el correo electrónico ingresado en el formulario (columna K)
    sheet.getRange(fila, COL_CORREO).setValue(formData.correo || '');

    // 2c. Guardar el Concepto de pago ingresado en el formulario (columna L)
    sheet.getRange(fila, COL_CONCEPTO_PAGO).setValue(formData.conceptoPago || '');

    // 2d. Guardar el Teléfono ingresado en el formulario (columna M)
    sheet.getRange(fila, COL_TELEFONO).setValue(String(formData.telefono || '').trim());

    // 2e. Si viene un RIF adjunto, se sube a Drive y su URL se guarda en la
    // columna N. Solo es obligatorio cuando el Concepto de pago es "Inicial"
    // o "Reserva" (ya validado en validarFormData); fail-open: si la subida
    // falla, el pago igual queda guardado y solo se registra el error en el log.
    if (formData.archivoRifBase64 && formData.nombreArchivoRif) {
      try {
        const partesRif = formData.archivoRifBase64.split(',');
        const contentTypeRif = partesRif[0].match(/data:(.*);base64/)[1];
        const bytesRif = Utilities.base64Decode(partesRif[1]);
        const blobRif = Utilities.newBlob(bytesRif, contentTypeRif, formData.nombreArchivoRif);

        const folderRif = DriveApp.getFolderById(DRIVE_FOLDER_ID_RIF);
        const fileRif = folderRif.createFile(blobRif);
        fileRif.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

        sheet.getRange(fila, COL_RIF).setValue(fileRif.getUrl());
        console.log('✅ RIF guardado en Drive y URL registrada en columna N.');
      } catch (errRif) {
        console.error('⚠️ El pago se guardó pero no se pudo subir el RIF: ' + errRif.message);
      }
    }

    // 2f. NUEVO: Guardar el Vendedor (columna O), solo cuando el Concepto de
    // pago es "Inicial" o "Reserva" (ya validado en validarFormData).
    if (requiereRif(formData.conceptoPago)) {
      sheet.getRange(fila, COL_VENDEDOR).setValue(String(formData.vendedor || '').trim());
    }

    // 2g. Si el Tipo de pago es exactamente "Efectivo", el Monto (columna I)
    // no se calcula por OCR: se guarda tal cual el valor manual enviado por
    // el formulario. Se escribe ANTES de llamar a procesarOCRFila() para que
    // el OCR (CASO A) sepa que no debe tocar esta columna.
    if (requiereMontoManual(formData.tipoPago)) {
      sheet.getRange(fila, COL_MONTO).setValue(Number(formData.montoManual));
    }

    // 3. Procesar OCR inmediatamente sobre la fila recién creada
    let ocrOk = true;
    try {
      procesarOCRFila(sheet, fila);
    } catch (ocrErr) {
      ocrOk = false;
      console.error('⚠️ El pago se guardó pero el OCR falló: ' + ocrErr.message);
    }

    // 4. VALIDACIÓN DE PAGO DUPLICADO (columna H)
    // Si la Referencia recién detectada por OCR ya existe en el histórico,
    // se revierte todo: se elimina la fila y se envía el comprobante a la
    // papelera de Drive. El frontend recibe duplicado:true y NO da el pago
    // por guardado.
    if (ocrOk) {
      try {
        const referenciaDetectada = sheet.getRange(fila, COL_REFERENCIA).getValue();

        if (referenciaYaExiste(sheet, referenciaDetectada, fila)) {
          sheet.deleteRow(fila);
          try {
            file.setTrashed(true);
          } catch (errTrash) {
            console.error('⚠️ No se pudo enviar a la papelera el comprobante duplicado: ' + errTrash.message);
          }
          return {
            success: false,
            duplicado: true,
            referencia: String(referenciaDetectada).trim()
          };
        }
      } catch (errDup) {
        // Si la validación de duplicados falla por cualquier motivo, no
        // bloqueamos el pago (fail-open) — solo se registra el error.
        console.error('⚠️ Error al validar pago duplicado: ' + errDup.message);
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}


/**
 * Devuelve todos los pagos registrados, en el formato que
 * consume el dashboard (admin.html).
 */
function obtenerPagos() {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(NOMBRE_HOJA);
    if (!sheet) {
      console.error('❌ obtenerPagos: no se encontró la hoja "' + NOMBRE_HOJA + '".');
      return [];
    }

    const filas = sheet.getDataRange().getValues();
    filas.shift(); // quitar encabezados

    return filas
      .filter(fila => fila[COL_NOMBRE - 1])
      .map(fila => ({
        fechaRegistro:   fila[COL_FECHA_REGISTRO - 1] instanceof Date ? fila[COL_FECHA_REGISTRO - 1].toISOString() : fila[COL_FECHA_REGISTRO - 1],
        nombre:           fila[COL_NOMBRE - 1],
        fechaPago:        fila[COL_FECHA_PAGO - 1] instanceof Date ? Utilities.formatDate(fila[COL_FECHA_PAGO - 1], Session.getScriptTimeZone(), 'yyyy-MM-dd') : fila[COL_FECHA_PAGO - 1],
        conceptoPago:     fila[COL_CONCEPTO_PAGO - 1],
        tipoPago:         fila[COL_TIPO_PAGO - 1],
        moneda:           fila[COL_MONEDA - 1],
        titular:          fila[COL_TITULAR - 1],
        comprobanteUrl:   fila[COL_ARCHIVO - 1],
        referencia:       fila[COL_REFERENCIA - 1],
        monto:            fila[COL_MONTO - 1],
        beneficiario:     fila[COL_BENEFICIARIO - 1],
        correo:           fila[COL_CORREO - 1],
        telefono:         fila[COL_TELEFONO - 1],
        rifUrl:           fila[COL_RIF - 1],
        vendedor:         fila[COL_VENDEDOR - 1],
        empresa:          fila[COL_EMPRESA - 1] // NUEVO: Columna R, usada por el filtro del panel admin
      }));
  } catch (err) {
    // Un fallo aquí no debe tumbar el panel admin: se registra y se
    // devuelve una lista vacía para que la UI lo maneje con normalidad.
    console.error('❌ Error en obtenerPagos: ' + err.message);
    return [];
  }
}

/**
 * NUEVO: Devuelve la lista de vendedores para poblar el <select> del
 * formulario público. Lee la hoja "VENDEDORES", columna B, filas 2-50.
 */
function obtenerVendedores() {
  try {
    const hoja = SpreadsheetApp.openById(SHEET_ID_VENDEDORES).getSheetByName(NOMBRE_HOJA_VENDEDORES);
    if (!hoja) {
      console.error('❌ obtenerVendedores: no se encontró la hoja "' + NOMBRE_HOJA_VENDEDORES + '".');
      return [];
    }

    const numFilas = FILA_FIN_VENDEDORES - FILA_INICIO_VENDEDORES + 1;
    const valores = hoja.getRange(FILA_INICIO_VENDEDORES, COL_VENDEDOR_LISTA, numFilas, 1).getValues();

    return valores
      .map(fila => String(fila[0] || '').trim())
      .filter(v => v.length > 0);
  } catch (err) {
    console.error('❌ Error en obtenerVendedores: ' + err.message);
    return [];
  }
}

/** Utilidad para incluir parciales HTML si separas el CSS/JS */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/* ============================================================================
 * OCR: núcleo compartido + entrada por trigger (Google Form nativo, opcional)
 * ========================================================================== */

/**
 * Núcleo del OCR: procesa una fila específica de la hoja PAGOS.
 * Lo llaman tanto procesarFormulario() (Web App, automático) como
 * alEnviarFormulario() (trigger de un Google Form nativo, opcional).
 */
function procesarOCRFila(hoja, fila) {
  if (!hoja || !fila || fila < 2) {
    console.error('❌ procesarOCRFila: parámetros inválidos (hoja o número de fila).');
    return;
  }

  console.log('📍 Procesando OCR de la fila: ' + fila);

  const valorCelda = hoja.getRange(fila, COL_ARCHIVO).getValue();
  console.log('🔗 Enlace detectado: ' + valorCelda);

  if (!valorCelda) {
    console.log('❌ La celda del archivo está vacía. Abortando OCR.');
    return;
  }

  const fileId = extraerIdDesdeUrl(valorCelda);
  if (!fileId) {
    console.log('❌ No se pudo extraer el ID del enlace.');
    return;
  }

  console.log('✅ ID extraído: ' + fileId + '. Enviando a Cloud Vision...');

  const archivo = DriveApp.getFileById(fileId);

  // Se pide UNA sola vez texto + posición de cada palabra (bounding box).
  // El texto (datosOCR.texto) se sigue usando exactamente igual que antes
  // para fecha/seriales/monto. Las posiciones (datosOCR.palabras) se usan
  // además para la extracción de Referencia "por posición".
  let datosOCR;
  try {
    datosOCR = extraerDatosConVision(archivo);
  } catch (errVision) {
    // La imagen puede estar borrosa, dañada o inaccesible: no detenemos el script.
    console.error('❌ Error al ejecutar OCR con Vision: ' + errVision.message);
    hoja.getRange(fila, COL_REFERENCIA).setValue('ERROR OCR');
    return;
  }
  const textoExtraido = datosOCR.texto;
  console.log('📝 TEXTO COMPLETO DEL RECIBO:\n' + textoExtraido);

  // --- validar/ajustar la Fecha de pago (columna C) contra la fecha
  // detectada en el comprobante. Fail-open: nunca interrumpe lo que sigue. ---
  validarFechaPagoConOCR_(hoja, fila, textoExtraido);

  // --- Leer el Tipo de pago (columna D) para decidir la rama a ejecutar ---
  const tipoPagoRaw = hoja.getRange(fila, COL_TIPO_PAGO).getValue();
  const tipoPagoUpper = (tipoPagoRaw || '').toString().trim().toUpperCase();

  if (esTipoPagoEfectivo(tipoPagoUpper)) {
    // ===================== CASO A: EFECTIVO =====================
    // Se escanean TODOS los seriales de billete presentes en la imagen
    // y se guardan concatenados por comas en la columna de Referencia (H).
    // Además, se calcula el monto total sumando las denominaciones detectadas
    // — EXCEPTO cuando el Tipo de pago es EXACTAMENTE "Efectivo": en ese caso
    // el Monto ya fue guardado en procesarFormulario() desde el campo manual
    // "montoManual", así que aquí NO se llama a extraerMontoEfectivo() ni se
    // sobrescribe la columna I.
    try {
      const seriales = extraerSerialesDeBilletes(textoExtraido);
      const serialesTexto = seriales.length > 0 ? seriales.join(', ') : 'No detectado';

      hoja.getRange(fila, COL_REFERENCIA).setValue(serialesTexto);

      if (requiereMontoManual(tipoPagoUpper)) {
        console.log('ℹ️ Tipo de pago "Efectivo" (exacto): se omite extraerMontoEfectivo(); el Monto ya viene del formulario (montoManual).');
      } else {
        const montoDetectado = extraerMontoEfectivo(textoExtraido, seriales.length);
        hoja.getRange(fila, COL_MONTO).setValue(montoDetectado);
        console.log(`✅ MONTO TOTAL DETECTADO (extraerMontoEfectivo): ${montoDetectado}`);
      }

      // Si el tipo de pago es "Efectivo" o "Bs", el Beneficiario se toma de
      // la columna F (Titular) en vez de 'No aplica'.
      if (debeUsarTitularComoBeneficiario(tipoPagoUpper)) {
        const titularEfectivo = hoja.getRange(fila, COL_TITULAR).getValue();
        hoja.getRange(fila, COL_BENEFICIARIO).setValue(titularEfectivo || 'No encontrado');
      } else {
        hoja.getRange(fila, COL_BENEFICIARIO).setValue('No aplica (pago en efectivo)');
      }

      console.log(`✅ SERIALES DETECTADOS (${seriales.length}): ${serialesTexto}`);
    } catch (errSeriales) {
      // Imagen borrosa o sin seriales legibles: se registra el error sin detener el script.
      console.error('❌ Error al extraer seriales de billetes: ' + errSeriales.message);
      hoja.getRange(fila, COL_REFERENCIA).setValue('ERROR AL LEER SERIALES');
      if (!requiereMontoManual(tipoPagoUpper)) {
        hoja.getRange(fila, COL_MONTO).setValue('ERROR AL LEER MONTO');
      }
    }

  } else {
    // ===================== CASO B: ZELLE / BINANCE / TRANSFERENCIA / PAGO MÓVIL =====================
    // La Referencia se busca primero "por posición" (usando las coordenadas
    // de cada palabra que ya devuelve Cloud Vision), y solo si eso no da
    // resultado se recurre al método original por texto plano.
    const referenciaDetectada = extraerReferenciaRobusta(datosOCR);
    const montoDetectado = extraerMonto(textoExtraido);

    // Si el tipo de pago es "Efectivo" o "Bs", el Beneficiario se toma
    // directamente de la columna F (Titular) en lugar de calcularlo con
    // extraerBeneficiario() sobre el texto OCR.
    const beneficiarioDetectado = debeUsarTitularComoBeneficiario(tipoPagoUpper)
      ? (hoja.getRange(fila, COL_TITULAR).getValue() || 'No encontrado')
      : extraerBeneficiario(textoExtraido);

    hoja.getRange(fila, COL_REFERENCIA).setValue(referenciaDetectada);
    hoja.getRange(fila, COL_MONTO).setValue(montoDetectado);
    hoja.getRange(fila, COL_BENEFICIARIO).setValue(beneficiarioDetectado);

    console.log(`✅ DATOS GUARDADOS -> Ref: ${referenciaDetectada} | Monto: ${montoDetectado} | Benef: ${beneficiarioDetectado}`);
  }
}

/**
 * Determina si el "Tipo de pago" corresponde a Efectivo/Divisas/Cash,
 * lo cual activa el escaneo de seriales de billetes en lugar del
 * flujo tradicional de Referencia/Monto/Beneficiario.
 * @param {string} tipoPagoUpper Valor de la columna D, ya en mayúsculas
 * @return {boolean}
 */
function esTipoPagoEfectivo(tipoPagoUpper) {
  return TIPOS_PAGO_EFECTIVO.some(t => tipoPagoUpper.indexOf(t) !== -1);
}

/**
 * Determina si el "Tipo de pago" (columna D) es "Efectivo" o "Bs". En ese
 * caso, el Beneficiario (columna J) NO se calcula mediante
 * extraerBeneficiario() sobre el texto OCR, sino que se toma directamente
 * de la columna F (Titular).
 * @param {string} tipoPagoUpper Valor de la columna D, ya en mayúsculas
 * @return {boolean}
 */
function debeUsarTitularComoBeneficiario(tipoPagoUpper) {
  return tipoPagoUpper.indexOf('EFECTIVO') !== -1 || tipoPagoUpper.indexOf('BS') !== -1;
}

/* ============================================================================
 * VALIDACIÓN DE FECHA DE PAGO (columna C) contra la fecha leída del OCR
 * ========================================================================== */

/**
 * Orquesta la validación de la fecha de pago para una fila ya procesada
 * por OCR. Compara la fecha ingresada en el formulario (columna C, tal como
 * quedó guardada por procesarFormulario) contra la fecha que aparece en el
 * texto del comprobante (textoExtraido de Cloud Vision).
 *
 * Reglas:
 *  - Si ambas fechas coinciden (mismo día/mes/año) -> se conserva la del formulario.
 *  - Si difieren -> prevalece la fecha detectada en el comprobante.
 *  - Si el OCR no encontró ninguna fecha -> se conserva la del formulario, sin tocar la celda.
 *
 * Es "fail-open": cualquier error se registra en consola y la función
 * simplemente no modifica la columna C, para no interrumpir el resto del
 * flujo de procesarOCRFila (referencia/monto/beneficiario siguen su curso).
 *
 * @param {Sheet} hoja Hoja "PAGOS"
 * @param {number} fila Fila recién procesada
 * @param {string} textoExtraido Texto ya obtenido por Cloud Vision en procesarOCRFila
 */
function validarFechaPagoConOCR_(hoja, fila, textoExtraido) {
  try {
    const valorActualCelda = hoja.getRange(fila, COL_FECHA_PAGO).getValue();
    const fechaFormularioDate = normalizarFechaFlexible_(valorActualCelda);
    const fechaSoporteDate = extraerFechaDeTexto_(textoExtraido);

    if (!fechaSoporteDate) {
      console.log('ℹ️ Validación de fecha: el comprobante no arrojó ninguna fecha reconocible. Se conserva la del formulario.');
      return;
    }

    if (!fechaFormularioDate) {
      console.log('⚠️ Validación de fecha: la celda C no tenía una fecha interpretable. Se usa la del comprobante.');
      hoja.getRange(fila, COL_FECHA_PAGO).setValue(fechaSoporteDate);
      console.log('✅ Fecha final (formato dd/mm/aaaa): ' + formatearFechaDDMMAAAA_(fechaSoporteDate));
      return;
    }

    const fechaFinalDate = sonMismaFecha_(fechaFormularioDate, fechaSoporteDate)
      ? fechaFormularioDate
      : fechaSoporteDate;

    hoja.getRange(fila, COL_FECHA_PAGO).setValue(fechaFinalDate);

    console.log(
      sonMismaFecha_(fechaFormularioDate, fechaSoporteDate)
        ? '✅ Fecha del formulario coincide con el comprobante.'
        : '⚠️ Fecha del formulario difiere del comprobante — se usa la fecha del comprobante.'
    );
    console.log('✅ Fecha final (formato dd/mm/aaaa): ' + formatearFechaDDMMAAAA_(fechaFinalDate));

  } catch (errFecha) {
    // Fail-open: un problema aquí nunca debe tumbar el OCR de referencia/monto/beneficiario.
    console.error('❌ Error al validar la fecha de pago con OCR: ' + errFecha.message);
  }
}

/**
 * Busca y normaliza una fecha dentro de un texto libre (resultado de OCR).
 * Soporta los formatos más comunes en comprobantes:
 *   - dd/mm/aaaa, dd-mm-aaaa, dd.mm.aaaa
 *   - aaaa/mm/dd, aaaa-mm-dd (ISO)
 *   - "5 de agosto de 2026", "05 Ago 2026" (nombre de mes en español)
 *
 * @param {string} texto
 * @return {Date|null}
 * @private
 */
function extraerFechaDeTexto_(texto) {
  if (!texto) return null;

  const meses = {
    'enero': 1, 'ene': 1, 'febrero': 2, 'feb': 2, 'marzo': 3, 'mar': 3,
    'abril': 4, 'abr': 4, 'mayo': 5, 'may': 5, 'junio': 6, 'jun': 6,
    'julio': 7, 'jul': 7, 'agosto': 8, 'ago': 8,
    'septiembre': 9, 'setiembre': 9, 'sep': 9, 'sept': 9,
    'octubre': 10, 'oct': 10, 'noviembre': 11, 'nov': 11, 'diciembre': 12, 'dic': 12
  };

  const regexNumericaYMD = /\b(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})\b/;
  const regexNumericaDMY = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/;
  const regexTextoMes = /\b(\d{1,2})\s*(?:de)?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s*(?:de|,)?\s*(\d{4})\b/;

  let match;

  match = texto.match(regexNumericaYMD);
  if (match) {
    const anio = parseInt(match[1], 10), mes = parseInt(match[2], 10), dia = parseInt(match[3], 10);
    const fecha = new Date(anio, mes - 1, dia);
    if (esFechaValida_(fecha, dia, mes, anio)) return fecha;
  }

  match = texto.match(regexNumericaDMY);
  if (match) {
    const dia = parseInt(match[1], 10), mes = parseInt(match[2], 10);
    let anio = parseInt(match[3], 10);
    if (anio < 100) anio += 2000;
    const fecha = new Date(anio, mes - 1, dia);
    if (esFechaValida_(fecha, dia, mes, anio)) return fecha;
  }

  match = texto.match(regexTextoMes);
  if (match) {
    const dia = parseInt(match[1], 10);
    const nombreMes = match[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const mes = meses[nombreMes];
    const anio = parseInt(match[3], 10);
    if (mes) {
      const fecha = new Date(anio, mes - 1, dia);
      if (esFechaValida_(fecha, dia, mes, anio)) return fecha;
    }
  }

  return null;
}

/**
 * Convierte el valor actual de la celda "Fecha pago" (puede llegar como
 * objeto Date -si Sheets ya la autoconvirtió- o como string crudo tipo
 * "2026-08-05") en un objeto Date normalizado.
 * @param {Date|string} valor
 * @return {Date|null}
 * @private
 */
function normalizarFechaFlexible_(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor;

  const intentoDirecto = new Date(valor);
  if (!isNaN(intentoDirecto.getTime())) return intentoDirecto;

  return extraerFechaDeTexto_(String(valor));
}

/** @private */
function esFechaValida_(fecha, dia, mes, anio) {
  return fecha.getFullYear() === anio && fecha.getMonth() === mes - 1 && fecha.getDate() === dia;
}

/** Compara dos fechas solo por día/mes/año (ignora horas). @private */
function sonMismaFecha_(fechaA, fechaB) {
  return fechaA.getFullYear() === fechaB.getFullYear() &&
         fechaA.getMonth() === fechaB.getMonth() &&
         fechaA.getDate() === fechaB.getDate();
}

/** Formatea una fecha en dd/mm/aaaa (con ceros a la izquierda). @private */
function formatearFechaDDMMAAAA_(fecha) {
  if (!fecha) return '';
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const aaaa = fecha.getFullYear();
  return `${dd}/${mm}/${aaaa}`;
}

/* ============================================================================
 * FUNCIONES DE EXTRACCIÓN (regex) y llamada a Vision API
 * ========================================================================== */

/**
 * Extrae el ID de archivo de Drive a partir de la URL guardada en la
 * columna "Comprobante" (columna G).
 * @param {string} valorCelda Valor crudo de la celda (URL de Drive)
 * @return {?string} ID del archivo, o null si no se pudo extraer
 */
function extraerIdDesdeUrl(valorCelda) {
  const texto = String(valorCelda);
  const match = texto.match(/[-\w]{25,}/);
  return match ? match[0] : null;
}

// ------------------------------------------------------------------
// Hace la llamada a Vision UNA sola vez y devuelve texto + posición de
// cada palabra (bounding box). Todo lo demás se construye sobre esto.
// ------------------------------------------------------------------
function extraerDatosConVision(archivoDrive) {
  if (!archivoDrive) {
    console.error('❌ extraerDatosConVision: no se recibió un archivo de Drive válido.');
    return { texto: 'Error OCR', palabras: [] };
  }

  let blob, base64;
  try {
    blob = archivoDrive.getBlob();
    base64 = Utilities.base64Encode(blob.getBytes());
  } catch (errBlob) {
    // Archivo corrupto, eliminado de Drive, o sin permisos de lectura.
    console.error('❌ Error al leer el archivo de Drive: ' + errBlob.message);
    return { texto: 'Error OCR', palabras: [] };
  }

  const url = 'https://vision.googleapis.com/v1/images:annotate';

  const payload = {
    requests: [
      {
        image: { content: base64 },
        features: [{ type: 'TEXT_DETECTION' }]
      }
    ]
  };

  const opciones = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let respuesta, json;
  try {
    respuesta = UrlFetchApp.fetch(url, opciones);
    json = JSON.parse(respuesta.getContentText());
  } catch (errFetch) {
    // Timeout, problema de red, o respuesta que no es JSON válido.
    console.error('❌ Error de red/parseo al llamar a Cloud Vision: ' + errFetch.message);
    return { texto: 'Error OCR', palabras: [] };
  }

  const codigo = respuesta.getResponseCode();

  if (codigo !== 200) {
    Logger.log('Error de Vision API (' + codigo + '): ' + respuesta.getContentText());
    return { texto: 'Error OCR', palabras: [] };
  }

  const resp = json.responses && json.responses[0];

  if (!resp || !resp.fullTextAnnotation) {
    return { texto: 'No se detectó texto', palabras: [] };
  }

  const texto = resp.fullTextAnnotation.text;

  // textAnnotations[0] = bloque de texto completo (se ignora aquí).
  // Desde el índice 1 en adelante, cada entrada es UNA palabra con su
  // boundingPoly (4 vértices) -> de ahí sacamos la posición real en la imagen.
  const palabras = [];
  const anotaciones = resp.textAnnotations || [];

  for (let i = 1; i < anotaciones.length; i++) {
    const anot = anotaciones[i];
    const vertices = anot.boundingPoly && anot.boundingPoly.vertices;
    if (!vertices || vertices.length === 0) continue;

    const xs = vertices.map(v => v.x || 0);
    const ys = vertices.map(v => v.y || 0);

    palabras.push({
      texto: anot.description,
      xMin: Math.min(...xs),
      xMax: Math.max(...xs),
      yMin: Math.min(...ys),
      yMax: Math.max(...ys),
      xCentro: (Math.min(...xs) + Math.max(...xs)) / 2,
      yCentro: (Math.min(...ys) + Math.max(...ys)) / 2
    });
  }

  return { texto, palabras };
}

// ------------------------------------------------------------------
// COMPATIBILIDAD: se mantiene igual que antes para no romper nada que
// ya la esté llamando. Internamente reusa extraerDatosConVision.
// ------------------------------------------------------------------
function extraerTextoConVision(archivoDrive) {
  return extraerDatosConVision(archivoDrive).texto;
}

// ------------------------------------------------------------------
// Agrupa las palabras por "banda" horizontal = un billete físico.
// Asume billetes apilados/extendidos en fila (variación vertical entre
// billetes >> variación vertical entre palabras del mismo billete).
// ------------------------------------------------------------------
function agruparPalabrasPorBanda(palabras) {
  if (!palabras || palabras.length === 0) return [];

  const alturas = palabras.map(p => p.yMax - p.yMin).sort((a, b) => a - b);
  const alturaMediana = alturas[Math.floor(alturas.length / 2)] || 20;

  // Margen de tolerancia entre palabras del MISMO billete. Generoso a
  // propósito: es preferible fundir dos billetes en una banda (raro, se
  // corrige por el emparejamiento de más abajo) que partir uno en dos.
  const TOLERANCIA = alturaMediana * 3;

  const ordenadas = [...palabras].sort((a, b) => a.yCentro - b.yCentro);

  const bandas = [];
  let bandaActual = [ordenadas[0]];
  let yMaxBandaActual = ordenadas[0].yMax;

  for (let i = 1; i < ordenadas.length; i++) {
    const palabra = ordenadas[i];
    if (palabra.yMin - yMaxBandaActual <= TOLERANCIA) {
      bandaActual.push(palabra);
      yMaxBandaActual = Math.max(yMaxBandaActual, palabra.yMax);
    } else {
      bandas.push(bandaActual);
      bandaActual = [palabra];
      yMaxBandaActual = palabra.yMax;
    }
  }
  bandas.push(bandaActual);

  return bandas.map(banda => {
    const ordenPorX = [...banda].sort((a, b) => a.xCentro - b.xCentro);
    return {
      texto: ordenPorX.map(p => p.texto).join(' '),
      yCentro: banda.reduce((s, p) => s + p.yCentro, 0) / banda.length
    };
  });
}

// ------------------------------------------------------------------
// Cuenta cada billete individualmente:
// ------------------------------------------------------------------

function contarBilletesIndividualmente(archivoDrive) {
  const datos = extraerDatosConVision(archivoDrive);

  if (!datos.palabras || datos.palabras.length === 0) {
    // Sin posiciones (error OCR, o Vision no devolvió textAnnotations):
    // cae de vuelta al método anterior, sobre texto completo.
    const seriales = extraerSerialesDeBilletes(datos.texto);
    const monto = extraerMontoEfectivo(datos.texto, seriales.length);
    return { billetes: [], total: monto, seriales, metodo: 'texto_completo_sin_posicion' };
  }

  const bandas = agruparPalabrasPorBanda(datos.palabras);

  const bandasProcesadas = bandas.map(banda => {
    const seriales = extraerSerialesDeBilletes(banda.texto);
    const denominacion = extraerMontoEfectivo(banda.texto); // función original, SIN CAMBIOS, aplicada por banda
    return {
      yCentro: banda.yCentro,
      seriales,
      denominacion: typeof denominacion === 'number' ? denominacion : null
    };
  });

  const bandasConDenominacion = bandasProcesadas.filter(b => b.denominacion !== null);
  const billetesPorSerial = new Map(); // serial -> { denominacion, inferida }

  bandasProcesadas.forEach(banda => {
    if (banda.seriales.length === 0) return; // banda sin serial = no es un billete contable

    let denominacionFinal = banda.denominacion;
    let inferida = false;

    if (denominacionFinal === null && bandasConDenominacion.length > 0) {
      let masCercana = bandasConDenominacion[0];
      let distMin = Math.abs(banda.yCentro - masCercana.yCentro);
      for (const candidata of bandasConDenominacion) {
        const dist = Math.abs(banda.yCentro - candidata.yCentro);
        if (dist < distMin) { distMin = dist; masCercana = candidata; }
      }
      denominacionFinal = masCercana.denominacion;
      inferida = true;
    }

    banda.seriales.forEach(serial => {
      // Si el serial ya fue registrado por otra banda (posible solape), no se duplica.
      if (!billetesPorSerial.has(serial)) {
        billetesPorSerial.set(serial, { denominacion: denominacionFinal, denominacionInferida: inferida });
      }
    });
  });

  // --- RECONCILIACIÓN: recuperar seriales perdidos por el bandeo por posición ---
  // Se extraen los seriales sobre el TEXTO COMPLETO (sin dividir en bandas) como
  // fuente de verdad adicional. Si el conteo por bandas encontró menos seriales
  // que el texto completo, se agregan los faltantes con la denominación más
  // frecuente detectada (moda) entre las bandas que sí tuvieron denominación.
  const serialesTextoCompleto = extraerSerialesDeBilletes(datos.texto);

  if (serialesTextoCompleto.length > billetesPorSerial.size) {
    // Calcular la denominación más frecuente (moda) como mejor estimación
    // para los billetes que el bandeo no logró ubicar.
    let denominacionModa = null;
    if (bandasConDenominacion.length > 0) {
      const conteoPorDenominacion = {};
      bandasConDenominacion.forEach(b => {
        conteoPorDenominacion[b.denominacion] = (conteoPorDenominacion[b.denominacion] || 0) + 1;
      });
      denominacionModa = Number(
        Object.entries(conteoPorDenominacion).sort((a, b) => b[1] - a[1])[0][0]
      );
    } else if (billetesPorSerial.size > 0) {
      // Si ninguna banda tuvo denominación propia, usar la que ya se infirió antes.
      const valores = [...billetesPorSerial.values()].map(b => b.denominacion).filter(v => v !== null);
      if (valores.length > 0) denominacionModa = valores[0];
    }

    serialesTextoCompleto.forEach(serial => {
      if (!billetesPorSerial.has(serial)) {
        billetesPorSerial.set(serial, {
          denominacion: denominacionModa,
          denominacionInferida: true,
          recuperadoPorReconciliacion: true
        });
      }
    });

    console.log(`⚠️ Reconciliación aplicada: el bandeo por posición encontró ${billetesPorSerial.size - (serialesTextoCompleto.length - billetesPorSerial.size)} seriales, pero el texto completo tenía ${serialesTextoCompleto.length}. Se recuperaron los faltantes.`);
  }

  const billetes = [...billetesPorSerial.entries()].map(([serial, info]) => ({
    serial,
    denominacion: info.denominacion,
    denominacionInferida: info.denominacionInferida,
    recuperadoPorReconciliacion: info.recuperadoPorReconciliacion || false
  }));

  const total = billetes.reduce((sum, b) => sum + (b.denominacion || 0), 0);

  console.log(`💵 ${billetes.length} billete(s) contados individualmente | Total: $${total}`);
  billetes.forEach(b => {
    let etiqueta = '';
    if (b.recuperadoPorReconciliacion) etiqueta = ' (recuperado por reconciliación, denominación inferida por moda)';
    else if (b.denominacionInferida) etiqueta = ' (denominación inferida por cercanía)';
    console.log(`   Serial ${b.serial} -> $${b.denominacion}${etiqueta}`);
  });

  return { billetes, total, metodo: 'bandas_por_posicion' };
}



/* ============================================================================
 * FUNCIONES DE EXTRACCIÓN REFERENCIA
 * ========================================================================== */

/**
 * Extrae la Referencia usando la POSICIÓN de cada palabra en la imagen
 * (bounding boxes que ya devuelve Cloud Vision), en vez de depender del
 * orden en que el texto plano quedó armado.
 *
 * Por qué esto resuelve el problema de la marca de agua: cuando
 * "www.bancamiga.com" queda superpuesta sobre "Referencia: 2510087091",
 * Vision las reporta como palabras/tokens SEPARADOS, cada uno con su propia
 * caja — nunca se mezclan letra por letra dentro de un mismo token. Así que
 * en vez de parsear una cadena de texto donde el orden de lectura pudo
 * revolverse, buscamos literalmente qué palabras están "a la derecha de
 * Referencia, en su misma fila" y descartamos por CONTENIDO las que
 * pertenezcan a la marca de agua (www / bancamiga / .com / redes sociales),
 * quedándonos solo con las que sí son parte del número.
 *
 * @param {{texto: string, palabras: Array}} datosOCR resultado de extraerDatosConVision()
 * @return {?string} Referencia detectada, o null si no se pudo (para que el
 *         llamador recurra al método por texto plano como respaldo).
 */
function extraerReferenciaPorPosicion(datosOCR) {
  if (!datosOCR || !datosOCR.palabras || datosOCR.palabras.length === 0) return null;

  const palabras = datosOCR.palabras;

  // Patrón de etiqueta: cualquier palabra que EMPIECE como "Referencia",
  // "Ref", "Confirmation", etc. (sin dos puntos, Vision los separa aparte).
  const PATRON_ETIQUETA = /^(REFERENCIA|REF\.?|CONFIRMATION|TRANSACTION)$/i;
  const idxLabel = palabras.findIndex(p => PATRON_ETIQUETA.test(p.texto.replace(/[:.,]/g, '')));
  if (idxLabel === -1) return null;

  const labelWord = palabras[idxLabel];
  const alturaLabel = Math.max(labelWord.yMax - labelWord.yMin, 1);
  // Tolerancia vertical generosa (misma "fila" del recibo, aunque el OCR
  // recorte cada palabra con un poquito de variación en Y).
  const TOLERANCIA_Y = alturaLabel * 0.8;

  // Candidatas: misma fila (Y parecido) y a la derecha del label en X.
  const candidatas = palabras.filter(p =>
    p !== labelWord &&
    Math.abs(p.yCentro - labelWord.yCentro) <= TOLERANCIA_Y &&
    p.xCentro > labelWord.xCentro
  );

  if (candidatas.length === 0) return null;

  // Descartar por CONTENIDO cualquier palabra que sea parte de la marca de
  // agua / redes sociales / web del banco, sin importar en qué posición del
  // texto plano hubiera caído.
  const PATRON_RUIDO = /WWW|BANCAMIGA|\.COM|TUBANCA|INSTAGRAM|FACEBOOK|TIKTOK/i;
  const limpias = candidatas.filter(p => !PATRON_RUIDO.test(p.texto));

  if (limpias.length === 0) return null;

  limpias.sort((a, b) => a.xCentro - b.xCentro);

  // Caso normal: la referencia suele venir como un solo token ya completo.
  for (const p of limpias) {
    const limpio = p.texto.replace(/[^A-Z0-9]/gi, '');
    if (/^[A-Z0-9]{6,20}$/i.test(limpio) && /\d/.test(limpio)) {
      return limpio.toUpperCase();
    }
  }

  // Respaldo: si Vision partió el número en varios tokens pequeños
  // (ej. "251" "0087" "091"), se concatenan en orden de X.
  const unido = limpias.map(p => p.texto).join('').replace(/[^A-Z0-9]/gi, '');
  if (/\d{6,}/.test(unido)) return unido.toUpperCase();

  return null;
}

/**
 * Punto de entrada único para obtener la Referencia. Intenta primero el
 * método por posición (más confiable ante marcas de agua superpuestas) y,
 * si no da resultado, cae al método original por texto plano — así ningún
 * comprobante se queda sin intentar todos los caminos disponibles.
 * @param {{texto: string, palabras: Array}} datosOCR resultado de extraerDatosConVision()
 * @return {string} Referencia detectada, o 'No encontrada'
 */
function extraerReferenciaRobusta(datosOCR) {
  try {
    const porPosicion = extraerReferenciaPorPosicion(datosOCR);
    if (porPosicion) {
      console.log('✅ Referencia obtenida por POSICIÓN (bounding boxes): ' + porPosicion);
      return porPosicion;
    }
  } catch (errPos) {
    // Fail-open: si el método por posición falla por lo que sea, se cae al
    // método por texto plano sin interrumpir el flujo.
    console.error('⚠️ Error en extraerReferenciaPorPosicion, se usa el método por texto: ' + errPos.message);
  }

  const porTexto = extraerReferencia(datosOCR.texto);
  console.log('ℹ️ Referencia obtenida por TEXTO PLANO (respaldo): ' + porTexto);
  return porTexto;
}

/**
 * Extrae el número de referencia/transacción de un comprobante (Zelle,
 * Binance, transferencia bancaria, pago móvil) a partir del texto OCR.
 * @param {string} texto Texto completo devuelto por Cloud Vision
 * @return {string} Referencia detectada, o 'No encontrada'
 */
function extraerReferencia(texto) {
  const lineasRaw = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // 1. Etiquetas conocidas (Zelle, transferencias, pago móvil, etc.)
  const ETIQUETAS = [
    'ID DE ORDEN',
    'N[UÚ]MERO DE TRANSACCI[OÓ]N',
    'TRANSACTION\\s*NUMBER',
    'N[UÚ]MERO DE REFERENCIA',
    'N[UÚ]MERO DE CONFIRMACI[OÓ]N',
    'NRO\\.?\\s*DE\\s*REFERENCIA',
    'N[°º]\\s*DE\\s*REFERENCIA',
    'REFERENCIA BANCARIA',
    'REFERENCIA',
    'REF\\.?\\s*[:#]',
    'CONF(?:IRMATION)?\\s*(?:NUMBER|#|:)',
    'TRANSACTION\\s*ID',
    'PAYMENT ID'
  ];
  const etiquetaRegex = new RegExp('^(?:' + ETIQUETAS.join('|') + ')\\s*:?\\s*(.*)$', 'i');

  // 2. Palabras que NUNCA son una referencia, aunque pasen los regex de formato
  const PALABRAS_PROHIBIDAS = new Set([
    'ESTADO', 'ENTREGADO', 'ACEPTADO', 'PENDIENTE', 'COMPLETADO', 'CANCELADO',
    'RECHAZADO', 'PROCESANDO', 'DISPONIBLE', 'MENSAJE', 'DESTINATARIO',
    'CHECKING', 'SAVINGS', 'TOTAL', 'PAGA', 'ENVIA', 'ENVIADA', 'ENVIADO',
    'RECIBIDO', 'CONCEPTO', 'IMPORTE', 'MONTO', 'FECHA', 'HORA', 'BANCO',
    'CUENTA', 'DINERO', 'INSTANTES', 'CANCELAR', 'DETALLES', 'RESUMEN'
  ]);

  // 2b. Líneas de contexto que jamás deben aportar un candidato a referencia
  // (sello del cajero, C.I. del depositante, número de cuenta, teléfono de
  // atención al cliente, redes sociales / web del banco).
  const CONTEXTO_PROHIBIDO = /C\.?\s*I\.?\s*DEL\s*DEPOSIT|DEPOSITANTE|FIRMA|SELLO\s*DEL\s*CAJERO|CAJERO|^CAJA\b|TITULAR|TUBANCA|WWW\.|\.COM|@|INSTAGRAM|FACEBOOK|TIKTOK|S[IÍ]GUENOS|REDES\s*SOCIALES|^0500\b|N[UÚ]MERO\s*DE\s*CUENTA/i;

  const lineas = lineasRaw.map(l => ({
    texto: l,
    prohibida: CONTEXTO_PROHIBIDO.test(l)
  }));

  const esInvalido = (v) => {
    if (!v) return true;
    const vUpper = v.toUpperCase();
    if (PALABRAS_PROHIBIDAS.has(vUpper)) return true;
    if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(v)) return true;
    if (/^[a-z]{3}\s*\d{1,2},?\s*\d{4}/i.test(v)) return true;
    if (/^[VJEG]-?\d{5,9}$/i.test(v)) return true;
    if (/^\*+\d+$/.test(v)) return true;
    if (/\(\.\.\.\d+\)/.test(v)) return true;
    if (/^0\d{3}-?\d{7}$/.test(v)) return true;
    if (/^\d{1,2}:\d{2}/.test(v)) return true;
    // Patrón típico de sello de cajero, ej. "CA1983", "CA2190" (2 letras + 3-4
    // dígitos cortos, normalmente pegado a "C.I. del Depositante")
    if (/^[A-Z]{2}\d{3,4}$/i.test(v)) return true;
    // FIX: los números de cuenta venezolanos tienen exactamente 20 dígitos.
    // Antes se rechazaba cualquier número de 16+ dígitos, lo que también
    // descartaba IDs de orden de Binance (18-19 dígitos) que SÍ son
    // referencias válidas. Solo se descartan los de 20 dígitos o más.
    if (/^\d{20,}$/.test(v)) return true;
    return false;
  };

  const pareceReferencia = (v) =>
    /\d/.test(v) && /^[A-Z0-9][A-Z0-9\-]{4,20}$/i.test(v) && !esInvalido(v);

  const limpiar = (v) => v.replace(/[^A-Z0-9]/gi, '');
  const BINANCE_REGEX = /\b\d{18}\b/;
  // FIX: variante amplia para capturar IDs de Binance de 17-19 dígitos
  // cuando no viene precedido por la etiqueta "ID DE ORDEN" (ver PASO 0b).
  const BINANCE_REGEX_AMPLIO = /\b\d{17,19}\b/;

  // --- PASO 0: patrones bancarios inconfundibles primero ---
  const PATRONES_CONOCIDOS = /\b(?:JPM[A-Z0-9]{9}|WFCT[A-Z0-9]{8}|BOFA[A-Z0-9]{8,10})\b/i;
  const matchConocido = texto.match(PATRONES_CONOCIDOS);
  if (matchConocido) return limpiar(matchConocido[0]);

  // --- PASO 0b: comprobantes tipo Binance sin etiqueta visible de
  // "ID DE ORDEN" (p. ej. pantallas de "Añadir alias" / "Cuenta de fondos").
  // Si aparece contexto claro de Binance y un número largo de 17-19 dígitos
  // que NO esté en una línea prohibida, se toma como referencia.
  const CONTEXTO_BINANCE = /CUENTA DE FONDOS|A[ÑN]ADIR ALIAS|USDT|BINANCE/i;
  if (CONTEXTO_BINANCE.test(texto)) {
    for (const l of lineas) {
      if (l.prohibida) continue;
      const m = l.texto.match(BINANCE_REGEX_AMPLIO);
      if (m) return m[0];
    }
  }

  // --- PASO 1: búsqueda por etiqueta ---
  const VENTANA = 4;

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].texto;
    const m = l.match(etiquetaRegex);

    const esBinance = /^ID DE ORDEN/i.test(l);
    if (esBinance) {
      for (let j = i; j <= i + 2 && j < lineas.length; j++) {
        const match18 = lineas[j].texto.match(BINANCE_REGEX);
        if (match18) return match18[0];
      }
      const globalMatch18 = texto.match(BINANCE_REGEX);
      if (globalMatch18) return globalMatch18[0];
      continue;
    }

    if (!m) continue;

    // Si la propia línea de la etiqueta viene con señales de marca de agua
    // superpuesta, se descarta esta ocurrencia por completo (sin inventar
    // nada) y se sigue buscando otra aparición limpia de "Referencia".
    const LINEA_CORRUPTA = /WWW\.|\.COM|@/i;
    if (LINEA_CORRUPTA.test(l)) continue;

    const mismaLinea = m[1].trim();

    if (mismaLinea) {
      const partes = mismaLinea.split(/\s+/);
      const candidato = partes[partes.length - 1];
      if (pareceReferencia(candidato)) return limpiar(candidato);
    }

    for (let j = i + 1; j <= i + VENTANA && j < lineas.length; j++) {
      if (lineas[j].prohibida) continue;

      const candidato = lineas[j].texto.trim();
      const primerElemento = candidato.split(/\s+/)[0];
      if (pareceReferencia(primerElemento) && !etiquetaRegex.test(candidato)) {
        return limpiar(primerElemento);
      }
    }
  }

  // --- PASO 2: fallback global (respetando líneas prohibidas) ---
  const idxReferencia = lineas.findIndex(l => /REFERENCIA/i.test(l.texto));
  const lineasDesdeReferencia = idxReferencia >= 0 ? lineas.slice(idxReferencia) : lineas;

  const lineasValidas = lineasDesdeReferencia.filter(l => !l.prohibida).map(l => l.texto).join('\n');
  const candidatosGlobales = lineasValidas.match(/\b[A-Z0-9]{6,20}\b/gi) || [];

  for (const c of candidatosGlobales) {
    if (!esInvalido(c) && /[A-Z]/i.test(c) && /[0-9]/.test(c)) {
      return limpiar(c);
    }
  }
  for (const c of candidatosGlobales) {
    if (!esInvalido(c) && /^[0-9]+$/.test(c)) {
      return limpiar(c);
    }
  }
  return 'No encontrada';
}


/* ============================================================================
 * FUNCIONES DE EXTRACCIÓN DE SERIALES DE BILLETES (CASO A: EFECTIVO)
 * ========================================================================== */


function extraerSerialesDeBilletes(texto) {
  if (!texto) return [];

  // Colapsa espacios/tabs (no saltos de línea) para no unir seriales de renglones distintos
  const textoLimpio = texto.replace(/[^\S\n]+/g, ' ');

  // Letra de Banco de la Reserva Federal: siempre es la última letra del prefijo
  const LETRAS_BANCO = 'ABCDEFGHIJKL';

  // Texto de denominación que jamás debe tratarse como serial
  const DENOMINACIONES_TEXTO = /^(ONE|TWO|FIVE|TEN|TWENTY|FIFTY|HUNDRED|DOLLAR|DOLLARS)$/i;

  // Permite hasta 2 espacios entre prefijo/dígitos/sufijo: el OCR de Vision
  // frecuentemente "rompe" el serial en 2-3 tokens (ej. "IC 23917378 A")
  const REGEX_SERIAL = /\b([A-Z]{1,2})\s{0,2}(\d{7,8})\s{0,2}([A-Z])?\b/g;

  const esSerialValido = (prefijo, digitos, sufijo) => {
    if (digitos.length < 7) return false;
    const letraBanco = prefijo[prefijo.length - 1];
    if (LETRAS_BANCO.indexOf(letraBanco) === -1) return false;
    if (DENOMINACIONES_TEXTO.test(prefijo + digitos + (sufijo || ''))) return false;
    // Descarta placeholders obvios (todos los dígitos iguales, ej. "00000000")
    if (/^(\d)\1+$/.test(digitos)) return false;
    return true;
  };

  const vistos = new Set();
  const resultado = [];
  let match;

  while ((match = REGEX_SERIAL.exec(textoLimpio)) !== null) {
    const [, prefijo, digitos, sufijo] = match;
    if (!esSerialValido(prefijo, digitos, sufijo)) continue;

    const candidato = (prefijo + digitos + (sufijo || '')).toUpperCase();
    if (!vistos.has(candidato)) {
      vistos.add(candidato);
      resultado.push(candidato);
    }
  }

  return resultado;
}
/* ============================================================================
 * FUNCIONES DE EXTRACCIÓN MONTO
 * ========================================================================== */
function extraerMonto(texto) {
  const textoLimpio = texto.replace(/\r?\n/g, ' ');

  const patronAmericano = /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d+\.\d{2}/;
  const matchAmerik = textoLimpio.match(patronAmericano);
  if (matchAmerik) return matchAmerik[0].trim();

  const patronesRespaldo = [
    /\$\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})/i,
    /\b\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\b/,
    /\b\d+\s?(?:USDT|USD|BS\.?)\b/i
  ];

  for (let patron of patronesRespaldo) {
    const match = textoLimpio.match(patron);
    if (match) return match[0].trim();
  }

  return 'No encontrado';
}
/* ============================================================================
 * FUNCIÓN DE EXTRACCIÓN DE MONTO PARA PAGOS EN EFECTIVO (billetes fotografiados)
 * ========================================================================== */

function extraerMontoEfectivo(texto, cantidadBilletes = 1) {
  if (!texto) return null;
  const t = texto.toUpperCase();
  let denominacion = null;

  // Detectar la denominación basada en el texto clásico impreso en los dólares
  if (t.includes('HUNDRED') || t.includes('100')) denominacion = 100;
  else if (t.includes('FIFTY') || t.includes('50')) denominacion = 50;
  else if (t.includes('TWENTY') || t.includes('20')) denominacion = 20;
  else if (t.includes('TEN') || /\b10\b/.test(t)) denominacion = 10;
  else if (t.includes('FIVE') || /\b5\b/.test(t)) denominacion = 5;
  else if (t.includes('TWO DOLLAR') || /\b2\b/.test(t)) denominacion = 2;
  else if (t.includes('ONE DOLLAR') || /\b1\b/.test(t)) denominacion = 1;

  // Si no se logra detectar nada legible, asumimos 0
  if (denominacion === null) return 0;

  // Si la función fue llamada desde procesarOCRFila con la cantidad de seriales detectados,
  // multiplicamos la denominación encontrada por la cantidad de billetes.
  if (cantidadBilletes && cantidadBilletes > 0) {
    return denominacion * cantidadBilletes;
  }

  // Si fue llamada desde contarBilletesIndividualmente (por banda),
  // solo devolvemos la denominación de ese billete específico.
  return denominacion;
}




/* ============================================================================
 * FUNCIONES DE EXTRACCIÓN BENEFICIARIO
 * ========================================================================== */

function extraerBeneficiario(texto) {
  const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);

  const limpiar = (valor) => valor.replace(/[.:]+$/, '').trim();

  // Etiquetas ordenadas por prioridad (nombre legal/registrado primero)
  const etiquetas = [
    /^Inscrito\(?a?\)?\s+como[\s:]*(.*)$/i,
    /^(?:BENEFICIARIO|Nombre\s+del?\s+titular)[\s:]*(.*)$/i,
    /^(?:TO|AS|ALIAS|ENVIADA\s+A|Enviado\s+a)[\s:]*(.*)$/i,
    /^A:\s*(.*)$/i, // "A:" con dos puntos, evita falsos positivos con la letra "A" suelta
  ];

  for (const patron of etiquetas) {
    for (let i = 0; i < lineas.length; i++) {
      const m = lineas[i].match(patron);
      if (m) {
        const valor = (m[1] || '').trim();
        if (valor.length > 2) return limpiar(valor);

        // Si la etiqueta está sola en su línea, el valor puede venir en la siguiente
        if (lineas[i + 1] && lineas[i + 1].length > 2) {
          return limpiar(lineas[i + 1]);
        }
      }
    }
  }

  // Frases embebidas: "Enviaste $X a Y", "Dinero enviado a Y", "sent to Y"
  const patronesTexto = [
    /Enviaste\s+\$?[\d.,]+\s+a\s+([^\n.]+?)\.?\s*$/im,
    /Dinero enviado a\s+([^\n]+)/i,
    /(?:sent to|payment of.*?to)\s+([^\n]+)/i,
  ];

  for (const patron of patronesTexto) {
    const m = texto.match(patron);
    if (m && m[1]) return limpiar(m[1]);
  }

  return 'No encontrado';
}
/* ============================================================================
 * FUNCIÓN DE PRUEBA MANUAL
 * ========================================================================== */

function pruebaManualPorFila() {
  const FILA_DE_PRUEBA = 53; // ajusta la fila a probar
  const hoja = SpreadsheetApp.openById(SHEET_ID).getSheetByName(NOMBRE_HOJA);
  procesarOCRFila(hoja, FILA_DE_PRUEBA);
}


/**========================================================================== 
 * NUEVO: punto de entrada para el frontend alojado en Vercel.
 * Recibe { fn, args, pin } y ejecuta SOLO funciones de una lista blanca.
 ========================================================================== 
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