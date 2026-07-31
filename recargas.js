/* =========================================================
   NOVASTREAM.VIP — recargas.js (v5)
   ✅ CONECTADO A FIREBASE · compatible con las reglas RTDB v5

   ─────────────────────────────────────────────────────────
   QUÉ HACE
   ─────────────────────────────────────────────────────────
   1. Protege la página: sin sesión → login.html.
      Si el usuario es admin lo manda a su panel.
   2. Lee el saldo en vivo desde usuarios/{uid}/saldoUsd.
   3. Lee los datos de pago desde configuracion/metodosPago
      (lectura pública). Si el admin no los configuró, usa los
      valores por defecto de este archivo.
   4. Sube el comprobante a Storage: comprobantes/{uid}/archivo.
      Si Storage está bloqueado, guarda una miniatura comprimida
      directo en la base (para que el flujo nunca se rompa).
   5. Crea la solicitud en /recargas con el formato EXACTO que
      exigen las reglas:
         clienteId === auth.uid
         estado === "pendiente"
         montoUsd > 0
   6. Lee el historial con query obligatoria:
         recargas.orderByChild("clienteId").equalTo(uid)
      (leer el nodo completo daría PERMISSION_DENIED)

   ─────────────────────────────────────────────────────────
   IMPORTANTE
   ─────────────────────────────────────────────────────────
   El cliente NO puede aprobar su propia recarga: las reglas
   solo le permiten crearla en estado "pendiente". El saldo lo
   acredita el administrador desde su panel.
   ========================================================= */

/* =========================
   CONFIG
========================= */

const NR_FB_CONFIG = {
  apiKey: "AIzaSyAZW6nWtyDrhvyvLw0JwP_Mhgoa-Vk3Tl4",
  authDomain: "nova-stream-13070.firebaseapp.com",
  databaseURL: "https://nova-stream-13070-default-rtdb.firebaseio.com",
  projectId: "nova-stream-13070",
  storageBucket: "nova-stream-13070.firebasestorage.app",
  messagingSenderId: "248510774791",
  appId: "1:248510774791:web:354748958103298e1234a2",
  measurementId: "G-C6DCXQKKHV"
};

const NR_LOGIN_URL = "login.html";
const NR_ADMIN_URL = "novaadmin.html";

const NR_TIPO_CAMBIO = 3.40;
const NR_MIN_PEN = 3.40;
const NR_MIN_USD = 1;
const NR_MAX_MB = 3;

/* Datos de pago por defecto. El admin puede sobrescribirlos
   escribiendo en configuracion/metodosPago (lectura pública). */
const NR_METODOS_DEFAULT = {
  Yape: {
    orden: 1,
    moneda: "PEN",
    titulo: "Datos de pago — Yape",
    titular: "Jorge Garcia",
    datoLabel: "Número Yape",
    dato: "931627729",
    qr: "img/qr.jpg",
    icono: "S/",
    iconoClase: "rgMetodoIconoYape",
    subtitulo: "Pago en soles (PEN)"
  },
  Binance: {
    orden: 2,
    moneda: "USD",
    titulo: "Datos de pago — Binance Pay",
    titular: "El Lex dred rasmus",
    datoLabel: "AUID Binance Pay",
    dato: "1139572110",
    qr: "img/qrbin.jpg",
    icono: "$",
    iconoClase: "rgMetodoIconoBinance",
    subtitulo: "Pago en dólares (USD)"
  }
};

/* =========================
   ESTADO
========================= */

let nrAuth = null, nrDb = null, nrStorage = null;
let nrUid = null;
let nrPerfil = { nombre: "Cliente", correo: "", usuario: "", saldoUsd: 0 };

let nrMetodos = JSON.parse(JSON.stringify(NR_METODOS_DEFAULT));
let nrMetodoSel = "Yape";
let nrHistorial = {};
let nrEnviando = false;
let nrArchivo = null;
let nrRefPerfil = null;

/* =========================================================
   HELPERS
========================================================= */

function nrEl(id){ return document.getElementById(id); }
function num(v){ return Number(v || 0); }
function red(v){ return Number(num(v).toFixed(2)); }
function fmtUSD(v){ return "$" + num(v).toFixed(2); }
function fmtPEN(v){ return "S/ " + num(v).toFixed(2); }
function usdToPen(v){ return num(v) * NR_TIPO_CAMBIO; }

function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function toast(msg){
  const el = nrEl("toastAviso");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("visible"), 2800);
}

function msg(texto, tipo){
  const box = nrEl("mensajeRecarga");
  if (!box) return;
  if (!texto){ box.className = "rgMensaje"; box.textContent = ""; return; }
  box.className = "rgMensaje show " + (tipo || "info");
  box.textContent = texto;
}

function fechaTexto(v){
  const d = new Date(typeof v === "number" ? v : String(v));
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("es-PE", { day:"2-digit", month:"2-digit", year:"2-digit" }) +
         " " + d.toLocaleTimeString("es-PE", { hour:"2-digit", minute:"2-digit" });
}

function soloDecimales(input){
  if (!input) return;
  let v = String(input.value || "").replace(/,/g, ".").replace(/[^0-9.]/g, "");
  v = v.replace(/(\..*)\./g, "$1");
  input.value = v;
}

/* =========================================================
   FIREBASE + GUARDIA DE SESIÓN
========================================================= */

function nrInit(){
  if (typeof firebase === "undefined"){
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#fff;font-family:sans-serif">No se pudo cargar el sistema. Revisa tu conexión.</div>';
    return;
  }

  if (!firebase.apps.length) firebase.initializeApp(NR_FB_CONFIG);
  nrAuth = firebase.auth();
  nrDb   = firebase.database();
  try { nrStorage = firebase.storage(); } catch(e){ nrStorage = null; }

  /* Datos de pago: lectura pública, se puede leer sin sesión */
  nrDb.ref("configuracion/metodosPago").on("value", (s) => {
    const d = s.val();
    if (d && typeof d === "object" && Object.keys(d).length){
      /* Se mezcla con los defaults: si el admin solo define
         el número, el resto (icono, moneda) sigue funcionando. */
      Object.keys(d).forEach(k => {
        nrMetodos[k] = Object.assign({}, NR_METODOS_DEFAULT[k] || {}, d[k]);
      });
    }
    renderMetodos();
    aplicarMetodo(nrMetodoSel);
  }, () => { renderMetodos(); aplicarMetodo(nrMetodoSel); });

  nrAuth.onAuthStateChanged(async (user) => {
    if (nrRefPerfil){ try{ nrRefPerfil.off(); }catch(e){} nrRefPerfil = null; }

    if (!user){ window.location.replace(NR_LOGIN_URL); return; }

    /* Verificación de rol y estado */
    let d = {};
    try {
      const snap = await nrDb.ref("usuarios/" + user.uid).get();
      d = snap.val() || {};
    } catch(e){
      toast("No pudimos verificar tu cuenta.");
      return;
    }

    if (String(d.estado || "activo").toLowerCase() === "bloqueado"){
      await nrAuth.signOut();
      window.location.replace(NR_LOGIN_URL);
      return;
    }

    if (String(d.rol || "cliente").toLowerCase() === "admin"){
      window.location.replace(NR_ADMIN_URL);
      return;
    }

    nrUid = user.uid;

    /* Perfil en vivo */
    nrRefPerfil = nrDb.ref("usuarios/" + nrUid);
    nrRefPerfil.on("value", (s) => {
      const p = s.val() || {};
      if (String(p.estado || "activo").toLowerCase() === "bloqueado"){
        nrAuth.signOut().finally(() => window.location.replace(NR_LOGIN_URL));
        return;
      }
      nrPerfil = {
        nombre:  p.nombre || user.email || "Cliente",
        correo:  p.correo || user.email || "",
        usuario: p.usuarioLower || p.usuario || "",
        saldoUsd: num(p.saldoUsd)
      };
      pintarPerfil();
    });

    /* Historial propio · query OBLIGATORIA por clienteId */
    nrDb.ref("recargas").orderByChild("clienteId").equalTo(nrUid)
      .on("value", (s) => {
        nrHistorial = s.val() || {};
        renderHistorial();
      }, (err) => {
        console.error(err);
        nrHistorial = {};
        renderHistorial();
      });

    /* Todo listo: se oculta el loader */
    const boot = nrEl("rgBooting");
    if (boot) boot.classList.add("off");
  });
}

function pintarPerfil(){
  const s = nrPerfil.saldoUsd;
  const u = nrEl("saldoUsuario");     if (u) u.textContent = fmtUSD(s);
  const p = nrEl("saldoUsuarioPen");  if (p) p.textContent = fmtPEN(usdToPen(s));

  const dn = nrEl("drawerNombre");    if (dn) dn.textContent = nrPerfil.nombre;
  const ds = nrEl("drawerSaldo");     if (ds) ds.textContent = fmtUSD(s) + " · " + fmtPEN(usdToPen(s));
  const da = nrEl("drawerAvatar");    if (da) da.textContent = String(nrPerfil.nombre || "N").trim().charAt(0).toUpperCase();
}

/* =========================================================
   MÉTODOS DE PAGO
========================================================= */

function renderMetodos(){
  const cont = nrEl("rgMetodoSelector");
  if (!cont) return;

  const claves = Object.keys(nrMetodos)
    .filter(k => nrMetodos[k] && nrMetodos[k].activo !== false)
    .sort((a,b) => num(nrMetodos[a].orden) - num(nrMetodos[b].orden));

  if (!claves.length){
    cont.innerHTML = '<div class="rgEmptyState">No hay métodos de pago disponibles.</div>';
    return;
  }

  if (!claves.includes(nrMetodoSel)) nrMetodoSel = claves[0];

  cont.innerHTML = claves.map(k => {
    const m = nrMetodos[k];
    return '<button type="button" class="rgMetodoCard' + (k === nrMetodoSel ? " activo" : "") + '" data-metodo="' + esc(k) + '">' +
             '<span class="rgMetodoIcono ' + esc(m.iconoClase || "") + '">' + esc(m.icono || "$") + '</span>' +
             '<span class="rgMetodoInfo">' +
               '<strong>' + esc(k) + '</strong>' +
               '<small>' + esc(m.subtitulo || (m.moneda === "USD" ? "Pago en dólares (USD)" : "Pago en soles (PEN)")) + '</small>' +
             '</span>' +
             '<span class="rgMetodoCheck">✓</span>' +
           '</button>';
  }).join("");

  cont.querySelectorAll(".rgMetodoCard").forEach(btn => {
    btn.addEventListener("click", () => {
      nrMetodoSel = btn.dataset.metodo;
      const mo = nrEl("monto"); if (mo) mo.value = "";
      const cb = nrEl("conversionBox"); if (cb) cb.style.display = "none";
      renderMetodos();
      aplicarMetodo(nrMetodoSel);
    });
  });
}

function aplicarMetodo(clave){
  const m = nrMetodos[clave];
  if (!m) return;

  const esUSD = m.moneda === "USD";
  const minimo = esUSD ? NR_MIN_USD : NR_MIN_PEN;

  const pref = nrEl("montoPrefijo");
  if (pref) pref.textContent = esUSD ? "$" : "S/";

  const inp = nrEl("monto");
  if (inp) inp.placeholder = "Mínimo: " + minimo.toFixed(2);

  const info = nrEl("montoMinimoInfo");
  if (info) info.innerHTML = "Monto mínimo: <strong>" + (esUSD ? "$" : "S/ ") + minimo.toFixed(2) + "</strong>";

  const tc = nrEl("tipoCambioTexto");
  if (tc) tc.textContent = fmtPEN(NR_TIPO_CAMBIO);

  const t = nrEl("datosPagoTitulo");   if (t) t.textContent = m.titulo || ("Datos de pago — " + clave);
  const ti = nrEl("datoPagoTitular");  if (ti) ti.textContent = m.titular || "-";
  const dl = nrEl("datoPagoLabel");    if (dl) dl.textContent = m.datoLabel || "Número";
  const dv = nrEl("datoPagoValor");    if (dv) dv.textContent = m.dato || "Pendiente de configurar";

  const btnCopy = nrEl("btnCopiarDato");
  if (btnCopy) btnCopy.setAttribute("data-copy", m.dato || "");

  const qr = nrEl("qrPlaceholder");
  if (qr){
    qr.innerHTML = m.qr
      ? '<img src="' + esc(m.qr) + '" alt="QR ' + esc(clave) + '" onerror="this.parentElement.innerHTML=\'<span>QR no disponible</span>\'">'
      : '<span>QR pendiente de configurar</span>';
  }

  actualizarConversion();
}

function actualizarConversion(){
  const inp = nrEl("monto");
  const box = nrEl("conversionBox");
  const txt = nrEl("conversionTexto");
  if (!inp || !box || !txt) return;

  const m = nrMetodos[nrMetodoSel] || {};
  const monto = num(inp.value);

  if (monto <= 0){ box.style.display = "none"; return; }

  const usd = m.moneda === "USD" ? monto : (monto / NR_TIPO_CAMBIO);
  txt.textContent = "Se acreditará " + fmtUSD(usd) + " a tu saldo";
  box.style.display = "flex";
}

/* =========================================================
   COMPROBANTE
========================================================= */

function validarArchivo(file){
  const tipos = ["image/jpeg","image/png","image/webp"];
  if (!tipos.includes(file.type)){
    msg("Solo se permiten imágenes JPG, PNG o WEBP.", "error");
    return false;
  }
  if (file.size > NR_MAX_MB * 1024 * 1024){
    msg("El comprobante no debe superar los " + NR_MAX_MB + " MB.", "error");
    return false;
  }
  return true;
}

function mostrarPreview(file){
  const wrap = nrEl("previewWrap");
  const img  = nrEl("previewComprobante");
  if (!wrap || !img) return;

  const fr = new FileReader();
  fr.onload = e => { img.src = e.target.result; wrap.style.display = "block"; };
  fr.readAsDataURL(file);
}

/* Miniatura comprimida: plan B si Storage está bloqueado.
   Se limita a ~900px y calidad 0.72 → suele quedar bajo 120 KB. */
function comprimirImagen(file, maxLado){
  maxLado = maxLado || 900;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("No se pudo leer el archivo."));
    fr.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error("Imagen inválida."));
      img.onload = () => {
        let w = img.width, h = img.height;
        const k = Math.min(1, maxLado / Math.max(w, h));
        w = Math.round(w * k); h = Math.round(h * k);

        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#0e0f14";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.72));
      };
      img.src = e.target.result;
    };
    fr.readAsDataURL(file);
  });
}

async function subirComprobante(file){
  const ts = Date.now();
  const limpio = String(file.name || "comprobante.jpg").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-40);
  const ruta = "comprobantes/" + nrUid + "/" + ts + "_" + limpio;

  if (nrStorage){
    try {
      const ref = nrStorage.ref(ruta);
      await ref.put(file);
      const url = await ref.getDownloadURL();
      return { url, path: ruta };
    } catch (e){
      console.warn("Storage no disponible, se usa miniatura embebida:", e.message);
    }
  }

  const dataUrl = await comprimirImagen(file, 900);
  return { url: dataUrl, path: "" };
}

/* =========================================================
   ENVÍO DE LA SOLICITUD
========================================================= */

async function enviarSolicitud(e){
  if (e) e.preventDefault();
  if (nrEnviando || !nrUid) return;

  const inpMonto = nrEl("monto");
  const inpOper  = nrEl("operacion");
  const inpFile  = nrEl("comprobante");
  const btn      = nrEl("btnEnviar");

  soloDecimales(inpMonto);
  msg("");

  const m = nrMetodos[nrMetodoSel] || {};
  const esUSD = m.moneda === "USD";
  const minimo = esUSD ? NR_MIN_USD : NR_MIN_PEN;
  const monto = num(inpMonto.value);

  if (!monto || monto < minimo){
    msg("El monto mínimo de recarga es " + (esUSD ? "$" + NR_MIN_USD.toFixed(2) : "S/ " + NR_MIN_PEN.toFixed(2)) + ".", "error");
    return;
  }

  const operacion = String(inpOper.value || "").trim();
  if (operacion.length < 4){
    msg("Ingresa un número de operación válido (mínimo 4 caracteres).", "error");
    return;
  }

  const file = inpFile.files[0];
  if (!file){ msg("Debes adjuntar tu comprobante de pago.", "error"); return; }
  if (!validarArchivo(file)) return;

  nrEnviando = true;
  if (btn){ btn.disabled = true; btn.textContent = "Subiendo comprobante..."; }

  try {
    const comp = await subirComprobante(file);

    if (btn) btn.textContent = "Registrando solicitud...";

    const montoUsd = esUSD ? red(monto) : red(monto / NR_TIPO_CAMBIO);
    const montoPen = esUSD ? red(monto * NR_TIPO_CAMBIO) : red(monto);

    if (montoUsd <= 0) throw new Error("El monto convertido no es válido.");

    /* Formato EXACTO que exigen las reglas:
       clienteId === auth.uid · estado 'pendiente' · montoUsd > 0 */
    await nrDb.ref("recargas").push({
      clienteId:      nrUid,
      clienteNombre:  nrPerfil.nombre,
      clienteCorreo:  nrPerfil.correo,
      usuario:        nrPerfil.usuario,
      montoUsd:       montoUsd,
      montoPen:       montoPen,
      tipoCambio:     NR_TIPO_CAMBIO,
      metodoPago:     nrMetodoSel,
      operacion:      operacion,
      comprobanteURL: comp.url,
      comprobantePath: comp.path,
      estado:         "pendiente",
      fecha:          Date.now()
    });

    msg("✅ Solicitud enviada. Quedará pendiente hasta que el administrador valide tu comprobante.", "success");
    toast("Recarga registrada · " + fmtUSD(montoUsd) + " (pendiente)");

    nrEl("formRecarga").reset();
    nrEl("previewWrap").style.display = "none";
    nrEl("conversionBox").style.display = "none";

  } catch (err){
    console.error(err);
    const t = String(err.message || "");
    if (/permission/i.test(t)){
      msg("El servidor rechazó la solicitud. Verifica el monto e intenta de nuevo.", "error");
    } else {
      msg("No se pudo enviar la solicitud: " + t, "error");
    }
  } finally {
    nrEnviando = false;
    if (btn){ btn.disabled = false; btn.textContent = "Enviar solicitud"; }
  }
}

/* =========================================================
   HISTORIAL
========================================================= */

function textoEstado(e){
  const s = String(e || "pendiente").toLowerCase();
  if (s === "aprobada") return "Aprobada";
  if (s === "rechazada") return "Rechazada";
  return "Pendiente";
}

function claseEstado(e){
  const s = String(e || "pendiente").toLowerCase();
  if (s === "aprobada") return "approved";
  if (s === "rechazada") return "rejected";
  return "pending";
}

function renderHistorial(){
  const body = nrEl("historialBody");
  if (!body) return;

  const ids = Object.keys(nrHistorial)
    .filter(id => nrHistorial[id] && typeof nrHistorial[id] === "object")
    .sort((a,b) => num(nrHistorial[b].fecha) - num(nrHistorial[a].fecha));

  /* Resumen */
  let aprobado = 0, pendientes = 0;
  ids.forEach(id => {
    const r = nrHistorial[id];
    const est = String(r.estado || "").toLowerCase();
    if (est === "aprobada") aprobado += num(r.montoAprobadoUsd !== undefined ? r.montoAprobadoUsd : r.montoUsd);
    if (est === "pendiente") pendientes++;
  });

  const ta = nrEl("rgTotalAprobado");  if (ta) ta.textContent = fmtUSD(aprobado);
  const tp = nrEl("rgTotalPendientes"); if (tp) tp.textContent = String(pendientes);

  if (!ids.length){
    body.innerHTML = '<tr><td colspan="5" class="rgEmptyState">Aún no registras solicitudes de recarga.</td></tr>';
    return;
  }

  body.innerHTML = ids.map(id => {
    const r = nrHistorial[id];
    const met = nrMetodos[r.metodoPago] || {};
    const esUSD = met.moneda === "USD";

    /* Monto pagado en la moneda original */
    const montoOriginal = esUSD ? fmtUSD(r.montoUsd) : fmtPEN(r.montoPen !== undefined ? r.montoPen : usdToPen(r.montoUsd));
    const usdFinal = r.montoAprobadoUsd !== undefined ? r.montoAprobadoUsd : r.montoUsd;

    const nota = r.observacionAdmin
      ? '<br><small style="color:#ff8082">' + esc(r.observacionAdmin) + '</small>'
      : "";

    return '<tr>' +
      '<td>' + esc(montoOriginal) + '</td>' +
      '<td><strong>' + esc(fmtUSD(usdFinal)) + '</strong></td>' +
      '<td>' + esc(r.metodoPago || "-") + '</td>' +
      '<td><span class="rgBadge ' + claseEstado(r.estado) + '">' + esc(textoEstado(r.estado)) + '</span>' + nota + '</td>' +
      '<td>' + esc(fechaTexto(r.fechaAprobacion || r.fechaRechazo || r.fecha)) + '</td>' +
    '</tr>';
  }).join("");
}

/* =========================================================
   COPIAR
========================================================= */

async function copiar(texto, boton){
  if (!texto) return;
  try {
    await navigator.clipboard.writeText(texto);
    const t = boton.textContent;
    boton.textContent = "Copiado";
    setTimeout(() => boton.textContent = t, 1400);
  } catch(e){
    toast("No se pudo copiar. Cópialo manualmente.");
  }
}

/* =========================================================
   NAVBAR
========================================================= */

function ajustarAlturaNav(){
  const nav = nrEl("nsNav");
  if (!nav) return;
  document.documentElement.style.setProperty("--nav-height", nav.offsetHeight + "px");
}

window.addEventListener("load", ajustarAlturaNav);
window.addEventListener("resize", ajustarAlturaNav);

/* =========================================================
   INIT
   El menú/drawer se registra PRIMERO y aislado: pase lo que
   pase con Firebase, el botón hamburguesa siempre responde.
========================================================= */

document.addEventListener("DOMContentLoaded", () => {

  /* 1) MENÚ / DRAWER — aislado */
  try {
    const btnMenu  = nrEl("btnMenuMovil");
    const overlay  = nrEl("nsDrawerOverlay");
    const btnClose = nrEl("btnCerrarDrawer");
    const salir    = nrEl("linkSalirDrawer");

    if (btnMenu && overlay)  btnMenu.addEventListener("click", () => overlay.classList.add("activo"));
    if (btnClose && overlay) btnClose.addEventListener("click", () => overlay.classList.remove("activo"));
    if (overlay) overlay.addEventListener("click", e => { if (e.target.id === "nsDrawerOverlay") overlay.classList.remove("activo"); });

    if (salir){
      salir.addEventListener("click", async e => {
        e.preventDefault();
        if (overlay) overlay.classList.remove("activo");
        try { if (nrAuth) await nrAuth.signOut(); } catch(err){}
        window.location.replace(NR_LOGIN_URL);
      });
    }

    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && overlay) overlay.classList.remove("activo");
    });
  } catch(err){ console.error("Drawer:", err); }

  /* 2) Navbar */
  try { ajustarAlturaNav(); } catch(err){}

  /* 3) Métodos de pago (se pintan con los defaults al instante) */
  try { renderMetodos(); aplicarMetodo(nrMetodoSel); } catch(err){ console.error(err); }

  /* 4) Formulario */
  try {
    const inpMonto = nrEl("monto");
    if (inpMonto){
      inpMonto.addEventListener("input", function(){ soloDecimales(this); actualizarConversion(); });
    }

    const inpFile = nrEl("comprobante");
    if (inpFile){
      inpFile.addEventListener("change", function(){
        msg("");
        const f = this.files[0];
        if (!f){ nrEl("previewWrap").style.display = "none"; return; }
        if (!validarArchivo(f)){ this.value = ""; nrEl("previewWrap").style.display = "none"; return; }
        mostrarPreview(f);
      });
    }

    const form = nrEl("formRecarga");
    if (form) form.addEventListener("submit", enviarSolicitud);

    const btnCopy = nrEl("btnCopiarDato");
    if (btnCopy) btnCopy.addEventListener("click", function(){ copiar(this.getAttribute("data-copy"), this); });
  } catch(err){ console.error("Formulario:", err); }

  /* 5) Firebase */
  nrInit();
});