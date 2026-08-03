/* =========================================================
   NOVASTREAM.VIP — novapro.js (v7)
   PANEL PROVEEDOR · adaptado a los IDs reales de novapro.html
   y 100% compatible con las reglas RTDB v5.

   ─────────────────────────────────────────────────────────
   CAMBIOS EN ESTA VERSIÓN (v7)
   ─────────────────────────────────────────────────────────
   · Se quitó el campo "Categoría general" del formulario de
     producto (ya no se guarda ni se usa el campo `categoria`).
   · El campo "Plataforma" ahora SOLO sugiere las categorías
     creadas por el administrador en /categorias. Ya no se
     autocompleta con las plataformas que ya usaron otros
     productos del catálogo. Si el admin todavía no creó
     ninguna categoría, el campo no sugiere nada.

   ─────────────────────────────────────────────────────────
   MODELO DE NEGOCIO
   ─────────────────────────────────────────────────────────
   · Cada venta acredita el 100% del precio al proveedor.
   · La plataforma NO cobra nada en la venta.
   · La comisión del 20% se cobra SOLO al retirar:
         Solicitas $100 → comisión $20 → recibes $80
   · Retención: las ventas de las últimas 24 h todavía no son
     retirables (protección ante reembolsos).

   ─────────────────────────────────────────────────────────
   LO QUE CONDICIONA ESTE ARCHIVO (reglas)
   ─────────────────────────────────────────────────────────
   · El proveedor NO puede leer nodos completos. Todas las
     lecturas globales usan .orderByChild('proveedorId')
     .equalTo(uid). Leer el nodo entero = permission_denied.
   · El proveedor NO puede modificar su propio saldoUsd:
     solo el admin lo mueve al aprobar recargas o retiros.
   · Los reembolsos: el proveedor puede ACEPTAR o RECHAZAR la
     solicitud (cambiar su estado y dejar un motivo de rechazo),
     pero el AJUSTE DE SALDO real (descontarle al proveedor y
     devolverle al cliente) lo sigue haciendo el admin — el
     proveedor nunca escribe saldoUsd directamente. Ver
     resolverReembolso() más abajo. Esto requiere que las reglas
     de /reembolsos/{id} permitan al proveedor dueño (proveedorId
     === auth.uid) actualizar SOLO estado/motivoRechazo/
     fechaResolucion/resueltoPor mientras estado actual sea
     "pendiente".
   · /cuentas se lee producto por producto (nunca completo).
   · Las imágenes se guardan comprimidas en la base (dataURL),
     así el flujo nunca depende de las reglas de Storage.
========================================================= */

/* =========================
   CONFIG
========================= */

const firebaseConfig = {
  apiKey: "AIzaSyCwMr1Ie2DmAePzI0X4qsSR5jE70OKbRkA",
  authDomain: "novastream-f3e15.firebaseapp.com",
  databaseURL: "https://novastream-f3e15-default-rtdb.firebaseio.com",
  projectId: "novastream-f3e15",
  storageBucket: "novastream-f3e15.firebasestorage.app",
  messagingSenderId: "356156093772",
  appId: "1:356156093772:web:58fb86ad38d8560fc50be9",
  measurementId: "G-FVSMQBXNDX"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db   = firebase.database();

/* Debe coincidir con NVA_COMISION_RETIRO del panel admin */
const NP_COMISION_RETIRO = 0.20;
const NP_TIPO_CAMBIO     = 3.40;
const NP_MIN_RETIRO      = 5;                     // USD
const NP_RETENCION_MS    = 24 * 60 * 60 * 1000;   // 24 h
const NP_DIAS_AVISO      = 5;                     // aviso de vencimiento

const NP_URL_LOGIN    = "login.html";
const NP_URL_CATALOGO = "catalogo.html";
const NP_URL_ADMIN    = "novaadmin.html";

/* Niveles según el total histórico generado */
const NP_NIVELES = [
  { min: 0,    max: 40,   nombre: "🆕 Proveedor Básico",  clase: "" },
  { min: 40,   max: 150,  nombre: "🥉 Proveedor Bronce",  clase: "" },
  { min: 150,  max: 500,  nombre: "🥈 Proveedor Plata",   clase: "" },
  { min: 500,  max: 1500, nombre: "🥇 Proveedor Oro",     clase: "lvl-top" },
  { min: 1500, max: null, nombre: "💎 Proveedor Diamante",clase: "lvl-top" }
];

/* =========================
   ESTADO
========================= */

let npUid = null;
let npPerfil  = { nombre:"Proveedor", usuario:"", correo:"", saldoUsd:0, estado:"activo" };
let npPublico = {};

let npCategorias   = {};
let npProductos    = {};
let npCuentas      = {};   // { productoId: { cuentaId: {...} } }
let npVentas       = {};
let npRetiros      = {};
let npMovimientos  = {};
let npReembolsos   = {};
let npRenovaciones = {};
let npTodosProductos   = {};   // para el modal de tienda (lectura pública)
let npTodosProveedores = {};

let npCuentasRefs   = {};
let npEditandoProd  = null;
let npNuevoProdId   = null;
let npImagenProducto = "";
let npCuentaEditPid = null;
let npPanelIniciado = false;

/* Estado local del modal de vencimientos: { "pid|cid": true/false } */
let npRenovoLocal = {};

/* =========================================================
   UTILIDADES
========================================================= */

function $(id){ return document.getElementById(id); }
function num(v){ return Number(v || 0); }
function red(v){ return Number(num(v).toFixed(2)); }
function usd(v){ return "$" + num(v).toFixed(2); }
function pen(v){ return "S/ " + (num(v) * NP_TIPO_CAMBIO).toFixed(2); }

function esc(t){
  return String(t == null ? "" : t)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function escJS(v){ return String(v == null ? "" : v).replace(/\\/g,"\\\\").replace(/'/g,"\\'"); }

function norm(v){
  return String(v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
}

function ts(v){
  if (typeof v === "number") return v;
  const ms = new Date(v || "").getTime();
  return isNaN(ms) ? 0 : ms;
}

function fechaCorta(v){
  if (!v) return "-";
  const d = new Date(typeof v === "number" ? v : String(v));
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("es-PE", { day:"2-digit", month:"2-digit", year:"2-digit" });
}
function fechaLarga(v){
  if (!v) return "-";
  const d = new Date(typeof v === "number" ? v : String(v));
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("es-PE", { day:"2-digit", month:"2-digit", year:"2-digit" }) +
         " " + d.toLocaleTimeString("es-PE", { hour:"2-digit", minute:"2-digit" });
}

function esHoy(v){
  const d = new Date(typeof v === "number" ? v : String(v));
  if (isNaN(d.getTime())) return false;
  const h = new Date();
  return d.getFullYear()===h.getFullYear() && d.getMonth()===h.getMonth() && d.getDate()===h.getDate();
}

function estadoDe(e, fb="pendiente"){ return String(e || fb).toLowerCase().trim(); }

function setTxt(id, v){ const el = $(id); if (el) el.textContent = v; }

function badge(t){
  const s = norm(t);
  let cls = "info";
  if (/aprob|activ|entregad|disponible|acept|complet/.test(s)) cls = "ok";
  else if (/pend/.test(s)) cls = "warn";
  else if (/rechaz|bloque|agotad|cancel/.test(s)) cls = "bad";
  return '<span class="npBadge ' + cls + '">' + esc(t) + '</span>';
}

/* =========================================================
   NOTIFICACIONES
========================================================= */

function notificar(titulo, mensaje, tipo){
  const wrap = $("npNotifyWrap");
  if (!wrap) { console.log(titulo, mensaje); return; }

  const iconos = { success:"✓", error:"✕", warning:"!", info:"i" };
  const t = tipo || "info";

  const item = document.createElement("div");
  item.className = "npNotifyItem " + t;
  item.innerHTML =
    '<div class="npNotifyIcon">' + (iconos[t] || "i") + '</div>' +
    '<div class="npNotifyContent"><strong>' + esc(titulo) + '</strong><p>' + esc(mensaje || "") + '</p></div>' +
    '<button class="npNotifyClose" type="button">✕</button>';

  item.querySelector(".npNotifyClose").addEventListener("click", () => item.remove());
  wrap.appendChild(item);
  setTimeout(() => item.remove(), 5200);
}

const ok    = (m, t) => notificar(t || "Listo", m, "success");
const err   = (m, t) => notificar(t || "Error", m, "error");
const avisa = (m, t) => notificar(t || "Atención", m, "warning");
const info  = (m, t) => notificar(t || "Información", m, "info");

/* =========================================================
   CONFIRMACIÓN (promesa)
========================================================= */

function confirmar(titulo, mensaje, icono){
  return new Promise((resolve) => {
    const ov = $("npConfirmOverlay");
    if (!ov) { resolve(window.confirm(titulo + "\n\n" + mensaje)); return; }

    $("npConfirmIcon").textContent = icono || "?";
    $("npConfirmTitle").textContent = titulo;
    $("npConfirmMessage").textContent = mensaje;

    const btnOk = $("npConfirmAccept");
    const btnNo = $("npConfirmCancel");

    /* Se clonan los botones para eliminar listeners previos */
    const nOk = btnOk.cloneNode(true);
    const nNo = btnNo.cloneNode(true);
    btnOk.parentNode.replaceChild(nOk, btnOk);
    btnNo.parentNode.replaceChild(nNo, btnNo);

    const cerrar = (r) => { ov.classList.remove("show"); resolve(r); };
    nOk.addEventListener("click", () => cerrar(true));
    nNo.addEventListener("click", () => cerrar(false));

    ov.classList.add("show");
  });
}

/* =========================================================
   NAVEGACIÓN
========================================================= */

const NP_TITULOS = {
  resumen:      ["Resumen", "Tu billetera, tus ventas y el estado de tu negocio, de un vistazo."],
  productos:    ["Productos / Cuentas", "Publica tus servicios y administra el stock disponible."],
  ventas:       ["Mis ventas", "Cada venta se acredita al 100% en tu saldo."],
  retiros:      ["Retiros", "Solicita tu dinero. Comisión fija del 20% al retirar."],
  reembolsos:   ["Reembolsos", "Solicitudes de devolución que afectan tus ventas."],
  renovaciones: ["Renovaciones", "Confirma las extensiones de acceso que piden tus clientes."]
};

function irASeccion(seccion){
  document.querySelectorAll(".npMenuBtn[data-section]").forEach(b => {
    b.classList.toggle("activo", b.dataset.section === seccion);
  });
  document.querySelectorAll(".npSection").forEach(s => {
    s.classList.toggle("activa", s.id === "section-" + seccion);
  });

  const t = NP_TITULOS[seccion];
  if (t) { setTxt("npPageTitle", t[0]); setTxt("npPageSubtitle", t[1]); }

  cerrarMenuMovil();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function abrirMenuMovil(){
  const s = $("npSidebar"), o = $("npOverlayMovil");
  if (s) s.classList.add("show");
  if (o) o.classList.add("show");
}
function cerrarMenuMovil(){
  const s = $("npSidebar"), o = $("npOverlayMovil");
  if (s) s.classList.remove("show");
  if (o) o.classList.remove("show");
}

/* Modales */
function abrirModal(id){ const m = $(id); if (m) m.classList.add("show"); }
function cerrarModal(id){ const m = $(id); if (m) m.classList.remove("show"); }

function abrirModalSoporte(){ prepararFormSoporte(); abrirModal("npModalSoporte"); }
function cerrarModalSoporte(){ cerrarModal("npModalSoporte"); }
function abrirModalTienda(){ cargarTiendaPublica(); abrirModal("npModalTienda"); }
function cerrarModalTienda(){ cerrarModal("npModalTienda"); }
function abrirModalVencimientos(){ renderVencimientosModal(); abrirModal("npModalVencimientos"); }
function cerrarModalVencimientos(){ cerrarModal("npModalVencimientos"); }
function cerrarModalEditarCuenta(){ cerrarModal("npModalEditarCuenta"); npCuentaEditPid = null; }

/* =========================================================
   AUTENTICACIÓN + GUARDIA DE ROL
========================================================= */

auth.onAuthStateChanged(async (user) => {
  if (!user) { window.location.replace(NP_URL_LOGIN); return; }

  let perfil = {};
  try {
    const snap = await db.ref("usuarios/" + user.uid).get();
    perfil = snap.val() || {};
  } catch (e) {
    err("No se pudo verificar tu cuenta. Revisa tu conexión.");
    return;
  }

  if (String(perfil.estado || "activo").toLowerCase() === "bloqueado") {
    await auth.signOut();
    window.location.replace(NP_URL_LOGIN);
    return;
  }

  const rol = String(perfil.rol || "cliente").toLowerCase();
  if (rol === "admin")     { window.location.replace(NP_URL_ADMIN);    return; }
  if (rol !== "proveedor") { window.location.replace(NP_URL_CATALOGO); return; }

  npUid = user.uid;
  aplicarPerfil(perfil);

  if (!npPanelIniciado) { npPanelIniciado = true; iniciarPanel(); }
});

function aplicarPerfil(p){
  npPerfil = {
    nombre:   p.nombre || p.nombreCompleto || "Proveedor",
    usuario:  p.usuario || "",
    correo:   p.correo || p.email || "",
    saldoUsd: num(p.saldoUsd),
    estado:   String(p.estado || "activo").toLowerCase()
  };

  setTxt("npPerfilNombre", npPerfil.nombre);
  setTxt("npPerfilCorreo", npPerfil.correo || "-");
  pintarSaldos();
}

function cerrarSesionProveedor(){
  auth.signOut().finally(() => window.location.replace(NP_URL_LOGIN));
}

/* =========================================================
   CARGA DE DATOS (siempre con query por proveedorId)
========================================================= */

function iniciarPanel(){
  prepararFormularios();

  /* Perfil propio: lectura directa permitida */
  db.ref("usuarios/" + npUid).on("value", (s) => {
    const d = s.val();
    if (!d) return;
    if (String(d.estado||"activo").toLowerCase() === "bloqueado") { cerrarSesionProveedor(); return; }
    aplicarPerfil(d);
  }, (e) => console.error("perfil:", e.message));

  /* Ficha pública propia */
  db.ref("proveedoresPublicos/" + npUid).on("value", (s) => {
    npPublico = s.val() || {};
    prepararFormSoporte();
  }, () => { npPublico = {}; });

  /* Categorías (lectura pública) → datalist de plataformas.
     Esta es la MISMA lista que crea el administrador desde su
     panel en /categorias. El proveedor ya no puede escribir
     plataformas "libres" que no existan ahí. */
  db.ref("categorias").on("value", (s) => {
    npCategorias = s.val() || {};
    renderDatalistPlataformas();
  }, () => { npCategorias = {}; });

  /* Productos propios */
  db.ref("productos").orderByChild("proveedorId").equalTo(npUid).on("value", (s) => {
    npProductos = s.val() || {};
    console.log("✅ productos propios:", Object.keys(npProductos).length);
    sincronizarListenersCuentas();
    renderTablaProductos();
    renderSelectProductoCuentas();
    renderResumen();
  }, (e) => {
    npProductos = {};
    renderTablaProductos();
    err("No se pudieron leer tus productos: " + e.message);
  });

  /* Ventas propias */
  db.ref("ventas").orderByChild("proveedorId").equalTo(npUid).on("value", (s) => {
    npVentas = s.val() || {};
    console.log("✅ ventas:", Object.keys(npVentas).length);
    renderTablaVentas();
    renderResumen();
    renderRetiroCalculo();
  }, (e) => { npVentas = {}; renderTablaVentas(); console.error("ventas:", e.message); });

  /* Retiros propios */
  db.ref("retirosProveedores").orderByChild("proveedorId").equalTo(npUid).on("value", (s) => {
    npRetiros = s.val() || {};
    console.log("✅ retiros:", Object.keys(npRetiros).length);
    renderTablaRetiros();
    renderResumen();
    renderRetiroCalculo();
  }, (e) => { npRetiros = {}; renderTablaRetiros(); console.error("retiros:", e.message); });

  /* Movimientos de saldo: nodo propio */
  db.ref("movimientosSaldo/" + npUid).limitToLast(60).on("value", (s) => {
    npMovimientos = s.val() || {};
    renderMovimientos();
  }, () => { npMovimientos = {}; renderMovimientos(); });

  /* Reembolsos que me afectan (el proveedor ACEPTA/RECHAZA;
     el ajuste de saldo lo termina de aplicar el admin) */
  db.ref("reembolsos").orderByChild("proveedorId").equalTo(npUid).on("value", (s) => {
    npReembolsos = s.val() || {};
    renderReembolsos();
  }, () => { npReembolsos = {}; renderReembolsos(); });

  /* Renovaciones de mis productos */
  db.ref("renovaciones").orderByChild("proveedorId").equalTo(npUid).on("value", (s) => {
    npRenovaciones = s.val() || {};
    renderRenovaciones();
  }, () => { npRenovaciones = {}; renderRenovaciones(); });

  generarNuevoIdProducto();
}

/* Cuentas: un listener por producto propio */
function sincronizarListenersCuentas(){
  const ids = Object.keys(npProductos);

  ids.forEach((pid) => {
    if (npCuentasRefs[pid]) return;
    const ref = db.ref("cuentas/" + pid);
    npCuentasRefs[pid] = ref;
    ref.on("value", (s) => {
      npCuentas[pid] = s.val() || {};
      renderTablaProductos();
      renderCuentasProducto();
      renderResumen();
      renderAvisoVencimientos();
    }, () => { npCuentas[pid] = {}; });
  });

  Object.keys(npCuentasRefs).forEach((pid) => {
    if (ids.includes(pid)) return;
    try { npCuentasRefs[pid].off(); } catch(e){}
    delete npCuentasRefs[pid];
    delete npCuentas[pid];
  });
}

/* =========================================================
   HELPERS DE NEGOCIO
========================================================= */

function esIlimitado(p){ return !!p && p.stockIlimitado === true; }

function stockReal(pid){
  const c = npCuentas[pid] || {};
  return Object.values(c).filter(x => estadoDe(x.estado, "disponible") === "disponible").length;
}

function montoVenta(v){
  if (v.montoProveedorUsd !== undefined) return num(v.montoProveedorUsd);
  return num(v.precioUsd);
}

function comisionDe(m){ return red(num(m) * NP_COMISION_RETIRO); }
function netoDe(m){ return red(num(m) - comisionDe(m)); }

/* Saldo congelado: ventas de las últimas 24 h */
function saldoCongelado(){
  const limite = Date.now() - NP_RETENCION_MS;
  let total = 0;
  Object.values(npVentas).forEach(v => { if (ts(v.fecha) >= limite) total += montoVenta(v); });
  return red(total);
}

function retirosPendientesMonto(){
  let t = 0;
  Object.values(npRetiros).forEach(r => { if (estadoDe(r.estado) === "pendiente") t += num(r.montoUsd); });
  return red(t);
}

/* Lo que realmente puede pedir hoy */
function saldoDisponible(){
  const d = red(npPerfil.saldoUsd - saldoCongelado() - retirosPendientesMonto());
  return d > 0 ? d : 0;
}

function totalGenerado(){
  let t = 0;
  Object.values(npVentas).forEach(v => { t += montoVenta(v); });
  return red(t);
}

function nivelActual(generado){
  for (let i = NP_NIVELES.length - 1; i >= 0; i--) {
    if (generado >= NP_NIVELES[i].min) return NP_NIVELES[i];
  }
  return NP_NIVELES[0];
}

function pintarSaldos(){
  const s = npPerfil.saldoUsd;
  const disp = saldoDisponible();
  const cong = saldoCongelado();

  setTxt("npSaldoUsd", usd(s));
  setTxt("npSaldoPen", "≈ " + pen(s));
  setTxt("npHeroSaldoUsd", usd(s));
  setTxt("npHeroSaldoPen", "≈ " + pen(s));
  setTxt("npHeroSaldoDisponible", usd(disp));
  setTxt("npHeroSaldoCongelado", usd(cong));

  setTxt("npStatSaldoRetiros", usd(disp));
  setTxt("npStatSaldoCongelado", usd(cong));
  setTxt("npStatSaldoReembolsos", usd(s));
  setTxt("npStatSaldoRenovaciones", usd(s));
  setTxt("npRetiroDisponibleTexto", usd(disp));

  /* Aviso de congelado en la sección Retiros */
  const noticia = $("npRetencionNoticeRetiros");
  if (noticia) {
    noticia.style.display = cong > 0 ? "flex" : "none";
    setTxt("npRetencionTextoMonto", usd(cong));
  }
}

/* =========================================================
   RESUMEN
========================================================= */

function renderResumen(){
  let vHoy = 0, vTot = 0, gen = 0;

  Object.values(npVentas).forEach(v => {
    vTot++;
    gen += montoVenta(v);
    if (esHoy(v.fecha)) vHoy++;
  });

  gen = red(gen);

  setTxt("npStatVentasHoy", String(vHoy));
  setTxt("npStatVentasTotales", String(vTot));
  setTxt("npStatTotalGenerado", usd(gen));
  setTxt("npStatVentasHoy2", String(vHoy));
  setTxt("npStatVentasTotales2", String(vTot));

  const pend = Object.values(npRetiros).filter(r => estadoDe(r.estado) === "pendiente").length;
  setTxt("npStatRetirosPend", String(pend));
  setTxt("npStatRetirosPend2", String(pend));

  /* Nivel */
  const nivel = nivelActual(gen);
  const chip1 = $("npNivelChip"), chip2 = $("npNivelChipHero");
  [chip1, chip2].forEach(c => {
    if (!c) return;
    c.textContent = nivel.nombre;
    c.classList.toggle("lvl-top", nivel.clase === "lvl-top");
  });

  const barra = $("npNivelProgresoBarra");
  if (nivel.max === null) {
    if (barra) barra.style.width = "100%";
    setTxt("npNivelProgresoTexto", usd(gen) + " generados · nivel máximo");
  } else {
    const rango = nivel.max - nivel.min;
    const avance = Math.min(100, Math.max(0, ((gen - nivel.min) / rango) * 100));
    if (barra) barra.style.width = avance.toFixed(1) + "%";
    setTxt("npNivelProgresoTexto", usd(gen) + " de " + usd(nivel.max) + " generados");
  }

  pintarSaldos();
  renderAvisoVencimientos();

  /* Badges del menú */
  const bR = $("npBadgeReembolsos");
  const nR = Object.values(npReembolsos).filter(r => estadoDe(r.estado) === "pendiente").length;
  if (bR) { bR.textContent = String(nR); bR.classList.toggle("visible", nR > 0); }

  const bN = $("npBadgeRenovaciones");
  const nN = Object.values(npRenovaciones).filter(r => estadoDe(r.estado) === "pendiente").length;
  if (bN) { bN.textContent = String(nN); bN.classList.toggle("visible", nN > 0); }

  setTxt("npStatReembolsosPend", String(nR));
  setTxt("npStatRenovacionesPend", String(nN));
}

function renderMovimientos(){
  const cont = $("npMovimientos");
  if (!cont) return;

  const ids = Object.keys(npMovimientos)
    .sort((a,b) => ts(npMovimientos[b].fecha) - ts(npMovimientos[a].fecha))
    .slice(0, 12);

  if (!ids.length) {
    cont.innerHTML = '<div class="npEmpty">Aún no hay movimientos registrados.</div>';
    return;
  }

  cont.innerHTML = ids.map(id => {
    const m = npMovimientos[id];
    const suma = m.signo === "+";
    const iconos = { venta:"💰", retiro:"🏦", reembolso:"↩️", ajuste:"⚙️", recarga:"💳" };
    return '<div class="npMov' + (suma ? "" : " neg") + '">' +
      '<div class="npMovIcon">' + (iconos[m.tipo] || "•") + '</div>' +
      '<div class="npMovInfo">' +
        '<strong>' + esc(m.tipo || "movimiento") + '</strong>' +
        '<span>' + esc(m.detalle || "-") + ' · ' + esc(fechaLarga(m.fecha)) + '</span>' +
      '</div>' +
      '<div class="npMovMonto">' + (suma ? "+" : "-") + usd(m.montoUsd) + '</div>' +
    '</div>';
  }).join("");
}

/* =========================================================
   AVISO DE VENCIMIENTOS
========================================================= */

/* Devuelve las cuentas vendidas que vencen dentro de NP_DIAS_AVISO */
function cuentasPorVencer(){
  const lista = [];
  const ahora = Date.now();
  const dia = 24 * 60 * 60 * 1000;

  Object.keys(npProductos).forEach(pid => {
    const p = npProductos[pid];
    const dur = num(p.duracionDias);
    if (dur <= 0) return;

    const cuentas = npCuentas[pid] || {};
    Object.keys(cuentas).forEach(cid => {
      const c = cuentas[cid];
      if (estadoDe(c.estado, "disponible") !== "usada") return;
      if (!c.fechaVenta) return;

      const vence = ts(c.fechaVenta) + dur * dia;
      const dias = Math.ceil((vence - ahora) / dia);

      if (dias <= NP_DIAS_AVISO) {
        lista.push({
          pid, cid,
          producto: p.nombre || pid,
          correo: c.correo || "-",
          clave: c.clave || "",
          perfil: c.perfil || "",
          comprador: c.compradorNombre || "Cliente",
          vence, dias,
          renovado: c.renovado === true
        });
      }
    });
  });

  return lista.sort((a,b) => a.vence - b.vence);
}

function renderAvisoVencimientos(){
  const lista = cuentasPorVencer();
  const box  = $("npAvisoVencimientos");
  if (!box) return;

  const icono = $("npAvisoVencIcono");

  if (!lista.length) {
    box.classList.add("npAvisoOk");
    if (icono) icono.textContent = "✓";
    setTxt("npAvisoVencTitulo", "Todo al día");
    setTxt("npAvisoVencSubtitulo", "No tienes cuentas entregadas por vencer en los próximos días.");
    return;
  }

  const criticas = lista.filter(x => x.dias <= 1).length;
  box.classList.remove("npAvisoOk");
  if (icono) icono.textContent = "!";
  setTxt("npAvisoVencTitulo", lista.length + " cuenta(s) por vencer");
  setTxt("npAvisoVencSubtitulo",
    (criticas ? criticas + " vencen hoy o mañana. " : "") +
    "Toca aquí para marcar quién renovó y cambiar la contraseña.");
}

function renderVencimientosModal(){
  const cont = $("npListaVencimientos");
  if (!cont) return;

  const lista = cuentasPorVencer();

  if (!lista.length) {
    cont.innerHTML = '<div class="npEmpty">No hay cuentas por vencer.</div>';
    return;
  }

  /* Se agrupan por producto + correo: así una cuenta compartida
     con varios perfiles se ve como un solo bloque. */
  const grupos = {};
  lista.forEach(x => {
    const k = x.pid + "||" + x.correo;
    if (!grupos[k]) grupos[k] = { pid: x.pid, producto: x.producto, correo: x.correo, items: [] };
    grupos[k].items.push(x);
  });

  cont.innerHTML = Object.keys(grupos).map(k => {
    const g = grupos[k];
    const gid = "g_" + Math.abs(k.split("").reduce((a,c)=>a+c.charCodeAt(0),0)) + "_" + g.items.length;

    const clientes = g.items.map(x => {
      const key = x.pid + "|" + x.cid;
      const marcado = npRenovoLocal[key] !== undefined ? npRenovoLocal[key] : x.renovado;
      const clase = x.dias <= 1 ? "critico" : "pronto";
      const txtDias = x.dias < 0 ? "vencida" : (x.dias === 0 ? "vence hoy" : "en " + x.dias + " día(s)");

      return '<div class="npVencCliente">' +
        '<div class="npVencClienteInfo">' +
          '<strong>' + esc(x.comprador) + (x.perfil ? " · " + esc(x.perfil) : "") + '</strong>' +
          '<span class="npVencDiasBadge ' + clase + '">' + esc(txtDias) + ' · ' + esc(fechaCorta(x.vence)) + '</span>' +
        '</div>' +
        '<div class="npVencRenovadoToggle">' +
          '<button type="button" class="npVencRenovadoBtn si' + (marcado ? " on" : "") + '" ' +
            'onclick="marcarRenovo(\'' + escJS(x.pid) + '\',\'' + escJS(x.cid) + '\',true)">Renovó</button>' +
          '<button type="button" class="npVencRenovadoBtn no' + (!marcado ? " on" : "") + '" ' +
            'onclick="marcarRenovo(\'' + escJS(x.pid) + '\',\'' + escJS(x.cid) + '\',false)">No</button>' +
        '</div>' +
      '</div>';
    }).join("");

    return '<div class="npVencGrupo">' +
      '<div class="npVencGrupoHead">' +
        '<div><h4>' + esc(g.producto) + '</h4><p>' + esc(g.correo) + '</p></div>' +
      '</div>' +
      '<div class="npVencClientesLista">' + clientes + '</div>' +
      '<div class="npVencAplicarRow">' +
        '<input type="text" class="npMiniInput" id="clave_' + gid + '" placeholder="Nueva contraseña para los que renovaron">' +
        '<button type="button" class="npBtn npBtnCyan" ' +
          'onclick="aplicarClaveVencimiento(\'' + escJS(g.pid) + '\',\'' + escJS(g.correo) + '\',\'clave_' + gid + '\')">Aplicar</button>' +
      '</div>' +
    '</div>';
  }).join("");
}

function marcarRenovo(pid, cid, valor){
  npRenovoLocal[pid + "|" + cid] = !!valor;
  db.ref("cuentas/" + pid + "/" + cid + "/renovado").set(!!valor)
    .then(() => renderVencimientosModal())
    .catch(e => err("No se pudo guardar: " + e.message));
}

async function aplicarClaveVencimiento(pid, correo, inputId){
  const input = $(inputId);
  const nueva = input ? String(input.value || "").trim() : "";

  if (nueva.length < 4) { avisa("Escribe una contraseña de al menos 4 caracteres."); return; }

  const cuentas = npCuentas[pid] || {};
  const objetivo = Object.keys(cuentas).filter(cid => {
    const c = cuentas[cid];
    if ((c.correo || "") !== correo) return false;
    const key = pid + "|" + cid;
    const marcado = npRenovoLocal[key] !== undefined ? npRenovoLocal[key] : (c.renovado === true);
    return marcado;
  });

  if (!objetivo.length) { avisa("Marca primero quién renovó (botón «Renovó»)."); return; }

  const seguro = await confirmar(
    "Cambiar contraseña",
    "Se aplicará la nueva contraseña a " + objetivo.length + " cuenta(s) del correo " + correo +
    ". Solo se actualizan las marcadas como «Renovó».",
    "🔑"
  );
  if (!seguro) return;

  const updates = {};
  const ahora = Date.now();
  objetivo.forEach(cid => {
    updates["cuentas/" + pid + "/" + cid + "/clave"] = nueva;
    updates["cuentas/" + pid + "/" + cid + "/fechaVenta"] = ahora;   // reinicia la vigencia
    updates["cuentas/" + pid + "/" + cid + "/renovado"] = false;
    updates["cuentas/" + pid + "/" + cid + "/avisoAtendido"] = true;
  });

  try {
    await db.ref().update(updates);
    if (input) input.value = "";
    objetivo.forEach(cid => { delete npRenovoLocal[pid + "|" + cid]; });
    ok("Contraseña aplicada a " + objetivo.length + " cuenta(s) y vigencia reiniciada.");
    renderVencimientosModal();
  } catch (e) {
    err("No se pudo aplicar: " + e.message);
  }
}

/* =========================================================
   PRODUCTOS
========================================================= */

function generarNuevoIdProducto(){
  npNuevoProdId = db.ref("productos").push().key;
  setTxt("npProdIdTexto", npNuevoProdId);
}

/* Solo se muestran las categorías creadas por el administrador
   en su panel (/categorias). Ya no se agregan automáticamente
   las plataformas que otros productos hayan usado antes, para
   evitar que se creen categorías "sueltas" fuera de control. */
function renderDatalistPlataformas(){
  const sel = $("prodPlataformaSelect");
  if (!sel) return;

  const cats = Object.values(npCategorias || {})
    .filter(c => c && c.nombre)
    .sort((a,b) => {
      const oa = Number(a.orden) || 9999;
      const ob = Number(b.orden) || 9999;
      if (oa !== ob) return oa - ob;
      return norm(a.nombre).localeCompare(norm(b.nombre));
    });

  const actual = String((($("prodPlataforma")||{}).value) || "");

  sel.innerHTML = '<option value="">Selecciona una categoría...</option>' +
    cats.map(c => '<option value="' + esc(c.nombre) + '">' + esc(c.nombre) + '</option>').join("") +
    '<option value="__nueva__">➕ Escribir una nueva categoría</option>';

  /* Si el producto en edición usa una plataforma que ya es categoría
     oficial, la seleccionamos sola; si no, abrimos el modo "nueva". */
  if (actual) {
    const existe = cats.some(c => norm(c.nombre) === norm(actual));
    sel.value = existe ? actual : "__nueva__";
    togglePlataformaInput(sel.value === "__nueva__");
  }
}

function togglePlataformaInput(mostrar){
  const inp = $("prodPlataforma");
  if (inp) inp.style.display = mostrar ? "" : "none";
}

function conectarSelectPlataforma(){
  const sel = $("prodPlataformaSelect");
  const inp = $("prodPlataforma");
  if (!sel || !inp || sel.dataset.listo) return;

  sel.addEventListener("change", () => {
    if (sel.value === "__nueva__") {
      togglePlataformaInput(true);
      inp.value = "";
      inp.focus();
    } else {
      togglePlataformaInput(false);
      inp.value = sel.value;
    }
  });

  sel.dataset.listo = "1";
}

function comprimirImagen(file, lado){
  lado = lado || 500;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("No se pudo leer el archivo."));
    fr.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("El archivo no es una imagen válida."));
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = lado; cv.height = lado;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#0e0f14"; ctx.fillRect(0,0,lado,lado);
        const k = Math.max(lado/img.width, lado/img.height);
        const w = img.width*k, h = img.height*k;
        ctx.drawImage(img, (lado-w)/2, (lado-h)/2, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.82));
      };
      img.src = e.target.result;
    };
    fr.readAsDataURL(file);
  });
}

async function manejarImagenProducto(file){
  if (!file) return;
  if (!/^image\//.test(file.type)) { avisa("El archivo debe ser una imagen JPG, PNG o WEBP."); return; }
  if (file.size > 6*1024*1024)     { avisa("La imagen no debe superar los 6 MB."); return; }

  try {
    npImagenProducto = await comprimirImagen(file, 500);
    const prev = $("npImgPreview");
    if (prev) prev.innerHTML = '<img src="' + npImagenProducto + '" alt="">';
    setTxt("npImgNombreArchivo", file.name);
    const q = $("npBtnQuitarImagen"); if (q) q.style.display = "";
  } catch (e) { err(e.message); }
}

function quitarImagenProducto(){
  npImagenProducto = "";
  const prev = $("npImgPreview");
  if (prev) prev.innerHTML = "🖼️";
  setTxt("npImgNombreArchivo", "Ningún archivo seleccionado");
  const inp = $("prodImagenArchivo"); if (inp) inp.value = "";
  const q = $("npBtnQuitarImagen"); if (q) q.style.display = "none";
}

function actualizarFxPrecio(){
  const v = num($("prodPrecio") ? $("prodPrecio").value : 0);
  setTxt("npFxTextoPrecio", pen(v));
}

/* Duración: select fijo o fecha personalizada */
function actualizarDuracion(){
  const sel  = $("prodDuracion");
  const wrap = $("npDuracionPersonalizadaWrap");
  const hid  = $("prodDuracionDiasCalculado");
  if (!sel) return;

  if (sel.value === "personalizado") {
    if (wrap) wrap.classList.add("show");
    const f = $("prodDuracionFecha");
    const fecha = f ? f.value : "";

    if (!fecha) {
      setTxt("npDuracionEquivalenciaTexto", "Selecciona una fecha (mínimo 7 días).");
      if (hid) hid.value = "";
      return;
    }

    const dias = Math.ceil((new Date(fecha + "T23:59:59").getTime() - Date.now()) / (24*60*60*1000));
    if (dias < 7) {
      setTxt("npDuracionEquivalenciaTexto", "⚠ La fecha debe estar al menos 7 días adelante.");
      if (hid) hid.value = "";
      return;
    }

    setTxt("npDuracionEquivalenciaTexto", "Equivale a " + dias + " días de vigencia.");
    if (hid) hid.value = String(dias);
  } else {
    if (wrap) wrap.classList.remove("show");
    if (hid) hid.value = sel.value;
  }
}

function duracionElegida(){
  const hid = $("prodDuracionDiasCalculado");
  if (hid && hid.value) return parseInt(hid.value, 10);
  const sel = $("prodDuracion");
  if (sel && sel.value !== "personalizado") return parseInt(sel.value, 10);
  return 0;
}

/* Toggles genéricos (modo entrega, reembolso, renovable, soporte) */
function conectarToggle(grupoId, dataAttr, hiddenId, onCambio){
  const grupo = $(grupoId);
  if (!grupo || grupo.dataset.listo) return;

  grupo.addEventListener("click", (e) => {
    const btn = e.target.closest(".npToggleBtn");
    if (!btn) return;
    grupo.querySelectorAll(".npToggleBtn").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    const hid = $(hiddenId);
    if (hid) hid.value = btn.dataset[dataAttr];
    if (onCambio) onCambio(btn.dataset[dataAttr]);
  });

  grupo.dataset.listo = "1";
}

function setToggle(grupoId, dataAttr, hiddenId, valor){
  const grupo = $(grupoId);
  if (!grupo) return;
  grupo.querySelectorAll(".npToggleBtn").forEach(b => {
    b.classList.toggle("on", b.dataset[dataAttr] === valor);
  });
  const hid = $(hiddenId);
  if (hid) hid.value = valor;
}

function limpiarFormProducto(){
  npEditandoProd = null;
  npImagenProducto = "";

  ["prodNombre","prodPlataforma","prodPrecio","prodDescripcion","prodReglas"].forEach(id => {
    const el = $(id); if (el) el.value = "";
  });

  const selPlat = $("prodPlataformaSelect");
  if (selPlat) selPlat.value = "";
  togglePlataformaInput(false);

  const dur = $("prodDuracion");     if (dur) dur.value = "30";
  const df  = $("prodDuracionFecha");if (df)  df.value  = "";

  setToggle("npGrupoModoEntrega", "modo", "prodModoEntrega", "automatico");
  setToggle("npGrupoReembolso", "reembolso", "prodAplicaReembolso", "si");
  setToggle("npGrupoEsRenovable", "renovable", "prodEsRenovable", "si");

  quitarImagenProducto();
  actualizarDuracion();
  actualizarFxPrecio();

  setTxt("npTituloFormProducto", "Crear producto");
  setTxt("npBtnGuardarProducto", "Guardar producto");
  const c = $("npBtnCancelarEdicionProducto"); if (c) c.style.display = "none";

  generarNuevoIdProducto();
}

async function guardarProducto(event){
  if (event) event.preventDefault();

  const nombre      = String(($("prodNombre")||{}).value || "").trim();
  const plataforma  = String(($("prodPlataforma")||{}).value || "").trim();
  const precio      = red(($("prodPrecio")||{}).value);
  const modoEntrega = String(($("prodModoEntrega")||{}).value || "automatico");
  const reembolso   = String(($("prodAplicaReembolso")||{}).value || "si");
  const esRenovable = String(($("prodEsRenovable")||{}).value || "si");
  const descripcion = String(($("prodDescripcion")||{}).value || "").trim();
  const reglas      = String(($("prodReglas")||{}).value || "").trim();
  const dias        = duracionElegida();

  if (!nombre)       { avisa("Escribe el nombre del producto."); return; }
  if (!plataforma)   { avisa("Indica la plataforma (así se agrupa en el catálogo)."); return; }
  if (!(precio > 0)) { avisa("El precio debe ser mayor a 0."); return; }
  if (!dias)         { avisa("Selecciona una duración válida."); return; }
  if (!npEditandoProd && !npImagenProducto) { avisa("Sube una imagen para el producto."); return; }

  const btn = $("npBtnGuardarProducto");
  if (btn) { btn.disabled = true; btn.textContent = "Guardando..."; }

  try {
    const editando = !!npEditandoProd;
    const id = editando ? npEditandoProd : npNuevoProdId;
    const ant = editando ? (npProductos[id] || {}) : {};
    const ilimitado = editando ? (ant.stockIlimitado === true) : false;

    const data = {
      proveedorId:     npUid,                                    // ⚠ obligatorio por reglas
      proveedorNombre: npPublico.nombre || npPerfil.nombre,
      nombre:          nombre,
      plataforma:      plataforma,
      precioUsd:       precio,
      duracionDias:    ilimitado ? 0 : dias,
      stockIlimitado:  ilimitado,
      descripcion:     descripcion || "Sin descripción disponible.",
      reglas:          reglas,
      imagen:          npImagenProducto || ant.imagen || "",
      modoEntrega:     modoEntrega,
      aplicaReembolso: reembolso,
      esRenovable:     esRenovable === "si",
      activo:          ant.activo !== undefined ? ant.activo !== false : true,
      stock:           ilimitado ? 0 : stockReal(id),
      fechaCreacion:   editando ? (num(ant.fechaCreacion) || Date.now()) : Date.now()
    };

    const updates = {};
    updates["productos/" + id] = data;
    if (!ilimitado) updates["stock/" + id] = data.stock;

    await db.ref().update(updates);

    ok(editando ? "Producto actualizado correctamente."
                : "Producto publicado. Ahora carga su stock en la pestaña «Cuentas».");
    limpiarFormProducto();
  } catch (e) {
    err("No se pudo guardar: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = npEditandoProd ? "Guardar cambios" : "Guardar producto"; }
  }
}

function editarProducto(id){
  const p = npProductos[id];
  if (!p) return;

  npEditandoProd = id;
  npImagenProducto = "";

  setTxt("npProdIdTexto", id);
  $("prodNombre").value      = p.nombre || "";
  $("prodPlataforma").value  = p.plataforma || "";
  renderDatalistPlataformas();
  $("prodPrecio").value      = num(p.precioUsd).toFixed(2);
  $("prodDescripcion").value = p.descripcion || "";
  $("prodReglas").value      = p.reglas || "";

  setToggle("npGrupoModoEntrega", "modo", "prodModoEntrega", p.modoEntrega || "automatico");
  setToggle("npGrupoReembolso", "reembolso", "prodAplicaReembolso", p.aplicaReembolso || "si");
  setToggle("npGrupoEsRenovable", "renovable", "prodEsRenovable", p.esRenovable === false ? "no" : "si");

  /* Duración: si coincide con una opción del select la usamos, si no → personalizada */
  const dias = String(num(p.duracionDias));
  const sel = $("prodDuracion");
  const existe = Array.from(sel.options).some(o => o.value === dias);
  if (existe) { sel.value = dias; }
  else {
    sel.value = "personalizado";
    const f = new Date(Date.now() + num(p.duracionDias) * 24*60*60*1000);
    $("prodDuracionFecha").value = f.toISOString().slice(0,10);
  }
  actualizarDuracion();
  actualizarFxPrecio();

  const prev = $("npImgPreview");
  if (prev) prev.innerHTML = p.imagen ? '<img src="' + esc(p.imagen) + '" alt="">' : "🖼️";
  setTxt("npImgNombreArchivo", p.imagen ? "Imagen actual (opcional cambiarla)" : "Ningún archivo seleccionado");

  setTxt("npTituloFormProducto", "Editar producto");
  setTxt("npBtnGuardarProducto", "Guardar cambios");
  const c = $("npBtnCancelarEdicionProducto"); if (c) c.style.display = "";

  irASeccion("productos");
  cambiarSubpanel("npPanelProductos");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toggleActivoProducto(id){
  const p = npProductos[id];
  if (!p) return;
  const nuevo = p.activo === false;

  db.ref("productos/" + id + "/activo").set(nuevo)
    .then(() => ok(nuevo ? "Producto activado y visible en el catálogo." : "Producto pausado."))
    .catch(e => err("No se pudo cambiar el estado: " + e.message));
}

async function eliminarProducto(id){
  const p = npProductos[id] || {};
  const cuentas = npCuentas[id] || {};
  const vendidas = Object.values(cuentas).filter(c => estadoDe(c.estado,"disponible") !== "disponible").length;

  const seguro = await confirmar(
    "Eliminar producto",
    "Se borrará «" + (p.nombre || id) + "» y sus cuentas disponibles." +
    (vendidas ? " Las " + vendidas + " cuenta(s) ya vendida(s) se conservan para tus clientes." : ""),
    "🗑️"
  );
  if (!seguro) return;

  const updates = {};
  updates["productos/" + id] = null;
  updates["stock/" + id] = null;
  Object.keys(cuentas).forEach(cid => {
    if (estadoDe(cuentas[cid].estado, "disponible") === "disponible") {
      updates["cuentas/" + id + "/" + cid] = null;
    }
  });

  try { await db.ref().update(updates); ok("Producto eliminado."); }
  catch (e) { err("No se pudo eliminar: " + e.message); }
}

function renderTablaProductos(){
  const tbody = $("npTablaProductos");
  if (!tbody) return;

  const ids = Object.keys(npProductos)
    .sort((a,b) => norm(npProductos[a].nombre).localeCompare(norm(npProductos[b].nombre)));

  if (!ids.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="npTdEmpty"><div class="npEmpty">Aún no tienes productos registrados.</div></td></tr>';
    return;
  }

  tbody.innerHTML = ids.map(id => {
    const p = npProductos[id];
    const ilim = esIlimitado(p);
    const s = ilim ? "∞" : stockReal(id);
    const activo = p.activo !== false;
    const estado = activo ? (ilim || s > 0 ? "Activo" : "Agotado") : "Pausado";
    const renovable = p.esRenovable === false ? "No" : "Sí";

    return '<tr>' +
      '<td class="txt"><strong>' + esc(p.nombre || id) + '</strong></td>' +
      '<td style="font-size:10.5px;">' + esc(id.slice(0,12)) + '…</td>' +
      '<td class="txt">' + esc(p.plataforma || "-") + '</td>' +
      '<td class="txt">' + renovable + '</td>' +
      '<td class="txt">' + (p.modoEntrega === "manual" ? "Manual" : "Automático") + '</td>' +
      '<td class="txt">' + (p.aplicaReembolso === "no" ? "No" : "Sí") + '</td>' +
      '<td>' + usd(p.precioUsd) + '<br><span style="font-size:10px;opacity:.6;">' + pen(p.precioUsd) + '</span></td>' +
      '<td><strong>' + s + '</strong></td>' +
      '<td>' + badge(estado) + '</td>' +
      '<td><div class="npActionRow">' +
        '<button class="npBtnMini edit" onclick="editarProducto(\'' + escJS(id) + '\')">Editar</button>' +
        '<button class="npBtnMini toggle" onclick="toggleActivoProducto(\'' + escJS(id) + '\')">' + (activo ? "Pausar" : "Activar") + '</button>' +
        '<button class="npBtnMini del" onclick="eliminarProducto(\'' + escJS(id) + '\')">Borrar</button>' +
      '</div></td>' +
    '</tr>';
  }).join("");
}

/* =========================================================
   CUENTAS (STOCK)
========================================================= */

function renderSelectProductoCuentas(){
  const sel = $("npCuentaProducto");
  if (!sel) return;

  const actual = sel.value;
  const ids = Object.keys(npProductos)
    .filter(id => !esIlimitado(npProductos[id]))
    .sort((a,b) => norm(npProductos[a].nombre).localeCompare(norm(npProductos[b].nombre)));

  sel.innerHTML = '<option value="">Selecciona producto</option>' +
    ids.map(id => '<option value="' + esc(id) + '">' +
      esc(npProductos[id].nombre) + (npProductos[id].plataforma ? " · " + esc(npProductos[id].plataforma) : "") +
    '</option>').join("");

  if (actual && ids.includes(actual)) sel.value = actual;
  renderCuentasProducto();
}

/* Parser flexible: acepta "Correo: x Contraseña: y Perfil: z PIN: n"
   y también "x | y | z | n" o separado por tabs/comas. */
function parsearLineaCuenta(linea){
  const original = String(linea || "").trim();
  if (!original) return null;

  const buscar = (etiquetas) => {
    for (const et of etiquetas) {
      const re = new RegExp(et + "\\s*[:=]\\s*([^\\s|;,]+)", "i");
      const m = original.match(re);
      if (m) return m[1].trim();
    }
    return "";
  };

  let correo = buscar(["correo","email","usuario","user","cuenta"]);
  let clave  = buscar(["contrase[nñ]a","clave","password","pass","pwd"]);
  let perfil = buscar(["perfil","profile"]);
  let pin    = buscar(["pin","c[oó]digo"]);

  /* Si no encontró etiquetas, se asume separación por | ; , o tab */
  if (!correo && !clave) {
    const partes = original.split(/[|;,\t]+/).map(x => x.trim()).filter(Boolean);
    correo = partes[0] || "";
    clave  = partes[1] || "";
    perfil = partes[2] || "";
    pin    = partes[3] || "";
  }

  if (!correo && !clave) return null;
  return { correo, clave, perfil, pin };
}

async function cargarCuentasMasivo(event){
  if (event) event.preventDefault();

  const pid = String(($("npCuentaProducto")||{}).value || "").trim();
  if (!pid || !npProductos[pid]) { avisa("Selecciona primero el producto al que pertenece el stock."); return; }

  const texto = String(($("npCuentasMasivasTexto")||{}).value || "").trim();
  if (!texto) { avisa("Pega al menos una línea con los datos de la cuenta."); return; }

  const filas = texto.split(/\r?\n/).map(parsearLineaCuenta).filter(Boolean);
  if (!filas.length) { avisa("No se pudo interpretar ninguna línea. Revisa el formato."); return; }

  try {
    const updates = {};
    const ahora = Date.now();

    filas.forEach(f => {
      const cid = db.ref("cuentas/" + pid).push().key;
      updates["cuentas/" + pid + "/" + cid] = {
        correo: f.correo,
        clave: f.clave,
        perfil: f.perfil,
        pin: f.pin,
        estado: "disponible",
        fechaCreacion: ahora
      };
    });

    const nuevoStock = stockReal(pid) + filas.length;
    updates["productos/" + pid + "/stock"] = nuevoStock;
    updates["stock/" + pid] = nuevoStock;

    await db.ref().update(updates);

    const ta = $("npCuentasMasivasTexto"); if (ta) ta.value = "";
    ok(filas.length + " cuenta(s) agregada(s). Stock del producto: " + nuevoStock + ".");
  } catch (e) {
    err("No se pudo cargar el stock: " + e.message);
  }
}

function renderCuentasProducto(){
  const pid = String(($("npCuentaProducto")||{}).value || "").trim();
  const tbDisp = $("npTablaCuentasDisponibles");
  const tbUsad = $("npTablaCuentasUsadas");
  const selCorreo = $("npCorreoCambioClave");

  setTxt("npMiniProductoActivo", pid && npProductos[pid] ? npProductos[pid].nombre : "-");

  if (!pid) {
    if (tbDisp) tbDisp.innerHTML = '<tr><td colspan="7" class="npTdEmpty"><div class="npEmpty">Selecciona un producto para ver su stock.</div></td></tr>';
    if (tbUsad) tbUsad.innerHTML = '<tr><td colspan="6" class="npTdEmpty"><div class="npEmpty">Selecciona un producto para ver su historial.</div></td></tr>';
    if (selCorreo) selCorreo.innerHTML = '<option value="">Selecciona producto primero</option>';
    setTxt("npMiniTotalCuentas","0"); setTxt("npMiniDisponibles","0"); setTxt("npMiniUsadas","0");
    return;
  }

  const cuentas = npCuentas[pid] || {};
  const ids = Object.keys(cuentas);
  const disp = ids.filter(cid => estadoDe(cuentas[cid].estado,"disponible") === "disponible");
  const usad = ids.filter(cid => estadoDe(cuentas[cid].estado,"disponible") !== "disponible");

  setTxt("npMiniTotalCuentas", String(ids.length));
  setTxt("npMiniDisponibles", String(disp.length));
  setTxt("npMiniUsadas", String(usad.length));

  /* ---- Disponibles ---- */
  if (tbDisp) {
    if (!disp.length) {
      tbDisp.innerHTML = '<tr><td colspan="7" class="npTdEmpty"><div class="npEmpty">No hay cuentas disponibles todavía.</div></td></tr>';
    } else {
      disp.sort((a,b) => ts(cuentas[b].fechaCreacion) - ts(cuentas[a].fechaCreacion));
      tbDisp.innerHTML = disp.map(cid => {
        const c = cuentas[cid];
        return '<tr>' +
          '<td>' + esc(c.correo || "-") + '</td>' +
          '<td>' + esc(c.clave || "-") + '</td>' +
          '<td>' + esc(c.perfil || "-") + '</td>' +
          '<td>' + esc(c.pin || "-") + '</td>' +
          '<td>' + badge("Disponible") + '</td>' +
          '<td>' + esc(fechaCorta(c.fechaCreacion)) + '</td>' +
          '<td><div class="npActionRow">' +
            '<button class="npBtnMini edit" onclick="abrirModalEditarCuenta(\'' + escJS(pid) + '\',\'' + escJS(cid) + '\')">Editar</button>' +
            '<button class="npBtnMini del" onclick="eliminarCuenta(\'' + escJS(pid) + '\',\'' + escJS(cid) + '\')">Borrar</button>' +
          '</div></td>' +
        '</tr>';
      }).join("");
    }
  }

  /* ---- Usadas ---- */
  if (tbUsad) {
    if (!usad.length) {
      tbUsad.innerHTML = '<tr><td colspan="6" class="npTdEmpty"><div class="npEmpty">No hay cuentas usadas todavía.</div></td></tr>';
    } else {
      usad.sort((a,b) => ts(cuentas[b].fechaVenta) - ts(cuentas[a].fechaVenta));
      const dur = num(npProductos[pid].duracionDias);

      tbUsad.innerHTML = usad.map(cid => {
        const c = cuentas[cid];
        const vence = c.fechaVenta && dur > 0 ? ts(c.fechaVenta) + dur*24*60*60*1000 : 0;
        const expirada = vence && vence < Date.now();

        return '<tr>' +
          '<td>' + esc(c.correo || "-") + '</td>' +
          '<td>' + esc(c.perfil || "-") + '</td>' +
          '<td class="txt">' + esc(c.compradorNombre || "-") + '</td>' +
          '<td>' + esc(fechaCorta(c.fechaVenta)) + '</td>' +
          '<td>' + (vence ? esc(fechaCorta(vence)) : "-") + '</td>' +
          '<td>' + badge(expirada ? "Expirada" : "Activa") + '</td>' +
        '</tr>';
      }).join("");
    }
  }

  /* ---- Select de correos para cambio de clave ---- */
  if (selCorreo) {
    const correos = {};
    ids.forEach(cid => {
      const co = cuentas[cid].correo || "";
      if (!co) return;
      if (!correos[co]) correos[co] = { total:0, usadas:0 };
      correos[co].total++;
      if (estadoDe(cuentas[cid].estado,"disponible") !== "disponible") correos[co].usadas++;
    });

    const claves = Object.keys(correos).sort();
    selCorreo.innerHTML = claves.length
      ? '<option value="">Selecciona un correo</option>' + claves.map(co =>
          '<option value="' + esc(co) + '">' + esc(co) + ' · ' + correos[co].total + ' cuenta(s)</option>').join("")
      : '<option value="">Este producto no tiene cuentas cargadas</option>';
  }
}

function abrirModalEditarCuenta(pid, cid){
  const c = (npCuentas[pid] || {})[cid];
  if (!c) return;

  npCuentaEditPid = pid;
  $("ecCuentaId").value    = cid;
  $("ecCorreo").value      = c.correo || "";
  $("ecClave").value       = c.clave || "";
  $("ecPerfil").value      = c.perfil || "";
  $("ecPin").value         = c.pin || "";
  $("ecObservacion").value = c.observacion || "";

  abrirModal("npModalEditarCuenta");
}

async function guardarCuentaEditada(event){
  if (event) event.preventDefault();

  const pid = npCuentaEditPid;
  const cid = String(($("ecCuentaId")||{}).value || "");
  if (!pid || !cid) return;

  const correo = String(($("ecCorreo")||{}).value || "").trim();
  if (!correo) { avisa("El correo no puede quedar vacío."); return; }

  try {
    await db.ref("cuentas/" + pid + "/" + cid).update({
      correo: correo,
      clave: String(($("ecClave")||{}).value || "").trim(),
      perfil: String(($("ecPerfil")||{}).value || "").trim(),
      pin: String(($("ecPin")||{}).value || "").trim(),
      observacion: String(($("ecObservacion")||{}).value || "").trim()
    });
    ok("Cuenta actualizada.");
    cerrarModalEditarCuenta();
  } catch (e) {
    err("No se pudo guardar: " + e.message);
  }
}

async function eliminarCuenta(pid, cid){
  const c = (npCuentas[pid] || {})[cid] || {};
  if (estadoDe(c.estado,"disponible") !== "disponible") {
    avisa("No puedes borrar una cuenta ya entregada a un cliente.");
    return;
  }

  const seguro = await confirmar("Eliminar cuenta", "Se quitará esta unidad del stock disponible.", "🗑️");
  if (!seguro) return;

  const nuevoStock = Math.max(0, stockReal(pid) - 1);
  const updates = {};
  updates["cuentas/" + pid + "/" + cid] = null;
  updates["productos/" + pid + "/stock"] = nuevoStock;
  updates["stock/" + pid] = nuevoStock;

  try { await db.ref().update(updates); ok("Cuenta eliminada. Stock: " + nuevoStock + "."); }
  catch (e) { err("No se pudo eliminar: " + e.message); }
}

async function borrarCantidadCuentas(){
  const pid = String(($("npCuentaProducto")||{}).value || "").trim();
  if (!pid) { avisa("Selecciona primero un producto."); return; }

  const cant = parseInt(($("npCantidadBorrar")||{}).value || "0", 10);
  if (!cant || cant < 1) { avisa("Indica cuántas cuentas quieres borrar."); return; }

  const cuentas = npCuentas[pid] || {};
  const disp = Object.keys(cuentas)
    .filter(cid => estadoDe(cuentas[cid].estado,"disponible") === "disponible")
    .sort((a,b) => ts(cuentas[a].fechaCreacion) - ts(cuentas[b].fechaCreacion));

  if (!disp.length) { avisa("No hay cuentas disponibles para borrar."); return; }

  const aBorrar = disp.slice(0, Math.min(cant, disp.length));

  const seguro = await confirmar(
    "Borrar " + aBorrar.length + " cuenta(s)",
    "Se eliminarán las más antiguas del stock disponible. Las vendidas no se tocan.",
    "🗑️"
  );
  if (!seguro) return;

  const nuevoStock = Math.max(0, stockReal(pid) - aBorrar.length);
  const updates = {};
  aBorrar.forEach(cid => { updates["cuentas/" + pid + "/" + cid] = null; });
  updates["productos/" + pid + "/stock"] = nuevoStock;
  updates["stock/" + pid] = nuevoStock;

  try {
    await db.ref().update(updates);
    const inp = $("npCantidadBorrar"); if (inp) inp.value = "";
    ok(aBorrar.length + " cuenta(s) eliminada(s). Stock: " + nuevoStock + ".");
  } catch (e) { err("No se pudo eliminar: " + e.message); }
}

/* ---- Cambio de clave por correo ---- */
async function cambiarClavePorCorreo(event){
  if (event) event.preventDefault();

  const pid = String(($("npCuentaProducto")||{}).value || "").trim();
  const correo = String(($("npCorreoCambioClave")||{}).value || "").trim();
  const nueva = String(($("npNuevaClavePorCorreo")||{}).value || "").trim();

  if (!pid)    { avisa("Selecciona primero un producto."); return; }
  if (!correo) { avisa("Elige el correo al que aplicar el cambio."); return; }
  if (nueva.length < 4) { avisa("La contraseña debe tener al menos 4 caracteres."); return; }

  const cuentas = npCuentas[pid] || {};
  const objetivo = Object.keys(cuentas).filter(cid => (cuentas[cid].correo || "") === correo);

  if (!objetivo.length) { avisa("No se encontraron cuentas con ese correo."); return; }

  const seguro = await confirmar(
    "Cambiar contraseña",
    "Se aplicará la nueva contraseña a las " + objetivo.length + " cuenta(s) del correo " + correo + ".",
    "🔑"
  );
  if (!seguro) return;

  const updates = {};
  objetivo.forEach(cid => { updates["cuentas/" + pid + "/" + cid + "/clave"] = nueva; });

  try {
    await db.ref().update(updates);

    /* Resumen visual de lo aplicado */
    const wrap = $("npCorreoResultadoWrap");
    const box  = $("npCorreoResultadoBox");
    if (wrap && box) {
      const chips = objetivo.map(cid => {
        const c = cuentas[cid];
        const usada = estadoDe(c.estado,"disponible") !== "disponible";
        return '<span class="npCorreoCuentaChip ' + (usada ? "usada" : "disponible") + '">' +
          esc(c.perfil || "sin perfil") + (usada ? " · " + esc(c.compradorNombre || "vendida") : " · libre") +
        '</span>';
      }).join("");

      box.innerHTML = '<strong>✓ Contraseña actualizada en ' + objetivo.length + ' cuenta(s)</strong><br>' +
                      'Correo: <strong>' + esc(correo) + '</strong><br>' + chips;
      wrap.style.display = "";
    }

    const inp = $("npNuevaClavePorCorreo"); if (inp) inp.value = "";
    ok("Contraseña aplicada a " + objetivo.length + " cuenta(s).");
  } catch (e) {
    err("No se pudo aplicar: " + e.message);
  }
}

/* =========================================================
   VENTAS
========================================================= */

function renderTablaVentas(){
  const tbody = $("npTablaVentas");
  if (!tbody) return;

  const ids = Object.keys(npVentas).sort((a,b) => ts(npVentas[b].fecha) - ts(npVentas[a].fecha));

  if (!ids.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="npTdEmpty"><div class="npEmpty">Todavía no hay ventas registradas.</div></td></tr>';
    return;
  }

  const limite = Date.now() - NP_RETENCION_MS;

  tbody.innerHTML = ids.map(id => {
    const v = npVentas[id];
    const m = montoVenta(v);
    const congelada = ts(v.fecha) >= limite;

    return '<tr>' +
      '<td class="txt"><strong>' + esc(v.productoNombre || v.productoId || "-") + '</strong></td>' +
      '<td class="txt">' + esc(v.clienteNombre || "-") + '</td>' +
      '<td>' + esc(fechaLarga(v.fecha)) + '</td>' +
      '<td>' + badge(v.estado || "entregada") + '</td>' +
      '<td>' + usd(m) + '</td>' +
      '<td style="color:#8ff5e0;">$0.00</td>' +
      '<td><strong style="color:#bdfff6;">' + usd(m) + '</strong></td>' +
      '<td>' + (congelada
        ? '<span class="npBadge warn">Congelado 24h</span>'
        : '<span class="npBadge ok">Retirable</span>') + '</td>' +
    '</tr>';
  }).join("");
}

/* =========================================================
   RETIROS
========================================================= */

function renderRetiroCalculo(){
  const input = $("retiroMonto");
  const monto = red(input ? input.value : 0);
  const com = comisionDe(monto);
  const neto = red(monto - com);

  setTxt("npFxTextoRetiro", pen(monto));
  setTxt("npRetiroLineaMonto", usd(monto));
  setTxt("npRetiroLineaMontoPen", "≈ " + pen(monto));
  setTxt("npRetiroLineaComision", "-" + usd(com));
  setTxt("npRetiroLineaComisionPen", "≈ " + pen(com));
  setTxt("npRetiroLineaNeto", usd(neto));
  setTxt("npRetiroLineaNetoPen", "≈ " + pen(neto));

  pintarSaldos();
}

async function solicitarRetiro(event){
  if (event) event.preventDefault();

  const input = $("retiroMonto");
  const monto = red(input ? input.value : 0);
  const metodo = String(($("retiroMetodo")||{}).value || "").trim();
  const dato = String(($("retiroDatoPago")||{}).value || "").trim();
  const disponible = saldoDisponible();

  if (!(monto > 0))          { avisa("Ingresa un monto válido."); return; }
  if (monto < NP_MIN_RETIRO) { avisa("El retiro mínimo es " + usd(NP_MIN_RETIRO) + "."); return; }
  if (monto > disponible)    {
    avisa("Solo tienes " + usd(disponible) + " disponibles. Hay " + usd(saldoCongelado()) + " congelados por la ventana de 24 h.");
    return;
  }
  if (!metodo)       { avisa("Elige el método de pago."); return; }
  if (dato.length < 6) { avisa("Escribe el número o dato de pago completo."); return; }

  const com = comisionDe(monto);
  const neto = red(monto - com);

  const seguro = await confirmar(
    "Confirmar retiro",
    "Solicitas " + usd(monto) + ". Se descuenta la comisión del 20% (" + usd(com) + ") " +
    "y recibirás " + usd(neto) + " (" + pen(neto) + ") por " + metodo + " a: " + dato,
    "🏦"
  );
  if (!seguro) return;

  try {
    /* Estructura EXACTA que exigen las reglas:
       comisionUsd ≥ 20% · netoUsd ≤ 80% · estado 'pendiente' · proveedorId propio */
    await db.ref("retirosProveedores").push({
      proveedorId:        npUid,
      proveedorNombre:    npPublico.nombre || npPerfil.nombre,
      montoUsd:           monto,
      comisionPorcentaje: NP_COMISION_RETIRO * 100,
      comisionUsd:        com,
      netoUsd:            neto,
      netoPen:            red(neto * NP_TIPO_CAMBIO),
      metodo:             metodo,
      datoPago:           dato,
      estado:             "pendiente",
      fechaSolicitud:     Date.now()
    });

    if (input) input.value = "";
    renderRetiroCalculo();
    ok("Solicitud enviada. Recibirás " + usd(neto) + " cuando el administrador la apruebe.", "Retiro solicitado");
  } catch (e) {
    err("No se pudo enviar la solicitud: " + e.message);
  }
}

async function cancelarRetiro(id){
  const r = npRetiros[id];
  if (!r || estadoDe(r.estado) !== "pendiente") { avisa("Solo puedes cancelar retiros pendientes."); return; }

  const seguro = await confirmar("Cancelar retiro", "Se eliminará esta solicitud de " + usd(r.montoUsd) + ".", "✕");
  if (!seguro) return;

  db.ref("retirosProveedores/" + id).remove()
    .then(() => ok("Solicitud cancelada."))
    .catch(e => err("No se pudo cancelar: " + e.message));
}

function renderTablaRetiros(){
  const tbody = $("npTablaRetiros");
  if (!tbody) return;

  const ids = Object.keys(npRetiros).sort((a,b) => ts(npRetiros[b].fechaSolicitud) - ts(npRetiros[a].fechaSolicitud));

  if (!ids.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="npTdEmpty"><div class="npEmpty">Aún no has enviado solicitudes.</div></td></tr>';
    return;
  }

  tbody.innerHTML = ids.map(id => {
    const r = npRetiros[id];
    const estado = estadoDe(r.estado);
    const monto = num(r.montoUsd);
    const com = r.comisionUsd !== undefined ? num(r.comisionUsd) : comisionDe(monto);
    const neto = r.netoUsd !== undefined ? num(r.netoUsd) : red(monto - com);

    const extra = estado === "pendiente"
      ? '<br><button class="npBtnMini del" style="margin-top:5px;" onclick="cancelarRetiro(\'' + escJS(id) + '\')">Cancelar</button>'
      : (r.motivoRechazo ? '<br><span style="font-size:10px;color:#ffb8c1;">' + esc(r.motivoRechazo) + '</span>' : "");

    return '<tr>' +
      '<td>' + esc(fechaLarga(r.fechaSolicitud)) + '</td>' +
      '<td>' + usd(monto) + '</td>' +
      '<td style="color:#ffb8c1;">-' + usd(com) + '</td>' +
      '<td><strong style="color:#f3a53c;">' + usd(neto) + '</strong></td>' +
      '<td>' + pen(neto) + '</td>' +
      '<td class="txt">' + esc(r.metodo || "-") + '<br><span style="font-size:10px;opacity:.65;">' + esc(r.datoPago || "") + '</span></td>' +
      '<td>' + badge(estado) + extra + '</td>' +
    '</tr>';
  }).join("");
}

/* =========================================================
   REEMBOLSOS
   El proveedor ve el motivo del cliente y puede ACEPTAR o
   RECHAZAR (con su propio motivo). El ajuste de saldo real
   (descontar al proveedor / devolver al cliente) lo termina
   de aplicar el administrador — el proveedor nunca escribe
   saldoUsd directamente.

   ⚠️ IMPORTANTE: para que resolverReembolso() funcione hace
   falta que las reglas de Firebase permitan, en
   /reembolsos/{id}, que el proveedor dueño (proveedorId ===
   auth.uid) actualice SOLO estado/motivoRechazo/
   fechaResolucion/resueltoPor mientras el estado actual sea
   "pendiente". Si las reglas actuales dicen que reembolsos es
   de solo lectura para el proveedor, hay que ampliarlas.
========================================================= */

function renderReembolsos(){
  const cont = $("npListaReembolsos");
  if (!cont) return;

  const ids = Object.keys(npReembolsos).sort((a,b) => ts(npReembolsos[b].fecha) - ts(npReembolsos[a].fecha));

  if (!ids.length) {
    cont.innerHTML = '<div class="npEmpty">No hay solicitudes de reembolso por ahora.</div>';
    return;
  }

  cont.innerHTML = ids.map(id => {
    const r = npReembolsos[id];
    const estado = estadoDe(r.estado);

    const acciones = estado === "pendiente"
      ? '<div class="npVencAplicarRow" style="grid-template-columns:1fr;margin-top:10px;">' +
          '<textarea class="npMiniInput" id="reembRechazoMotivo_' + esc(id) + '" rows="2" ' +
            'placeholder="Motivo del rechazo (solo si vas a rechazar, mínimo 8 caracteres)"></textarea>' +
        '</div>' +
        '<div class="npVencAplicarRow" style="grid-template-columns:1fr 1fr;margin-top:8px;">' +
          '<button class="npBtn npBtnCyan" onclick="resolverReembolso(\'' + escJS(id) + '\',\'aprobado\')">✓ Aceptar reembolso</button>' +
          '<button class="npBtn npBtnGhost" onclick="resolverReembolso(\'' + escJS(id) + '\',\'rechazado\')">✕ Rechazar</button>' +
        '</div>'
      : '';

    return '<div class="npVencGrupo">' +
      '<div class="npVencGrupoHead">' +
        '<div>' +
          '<h4>' + esc(r.productoNombre || r.productoId || "Producto") + '</h4>' +
          '<p>' + esc(r.clienteNombre || "Cliente") + ' · ' + esc(fechaLarga(r.fecha)) + '</p>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div style="font-family:var(--font-mono);font-size:17px;color:#ffb8c1;font-weight:800;">-' + usd(r.montoUsd) + '</div>' +
          badge(estado) +
        '</div>' +
      '</div>' +
      '<div class="npNotice" style="margin-top:8px;">' +
        '<strong>Motivo del cliente:</strong> ' + esc(r.motivo || "Sin especificar") +
        (estado === "pendiente"
          ? '<br><br>⏳ Revisa el motivo y decide si aceptas o rechazas esta solicitud.'
          : (estado === "aprobado"
              ? '<br><br>↩️ Reembolso aceptado. El administrador aplicará el ajuste de saldo correspondiente.'
              : '<br><br>✓ Reembolso rechazado. El cliente verá el motivo que escribiste.')) +
        (r.motivoRechazo ? '<br><span style="color:#ffb8c1;">Motivo del rechazo: ' + esc(r.motivoRechazo) + '</span>' : "") +
      '</div>' +
      acciones +
    '</div>';
  }).join("");
}

async function resolverReembolso(id, nuevoEstado){
  const r = npReembolsos[id];
  if (!r || estadoDe(r.estado) !== "pendiente") return;

  const aceptar = nuevoEstado === "aprobado";
  const inputMotivo = $("reembRechazoMotivo_" + id);
  const motivoRechazo = inputMotivo ? String(inputMotivo.value || "").trim().slice(0, 380) : "";

  if (!aceptar && motivoRechazo.length < 8) {
    avisa("Escribe el motivo del rechazo con un poco más de detalle (mínimo 8 caracteres).");
    if (inputMotivo) inputMotivo.focus();
    return;
  }

  const monto = red(num(r.montoUsd));
  let saldoReal = npPerfil.saldoUsd; // valor por defecto (caso rechazo, no se usa)

  /* ⭐ CORREGIDO: guardamos saldoReal fuera del if para reutilizarlo al escribir */
  if (aceptar) {
    try {
      const s = await db.ref("usuarios/" + npUid + "/saldoUsd").get();
      saldoReal = num(s.val());
    } catch (e) { err("No se pudo verificar tu saldo."); return; }

    if (saldoReal < monto) {
      avisa("Tu saldo actual (" + usd(saldoReal) + ") no alcanza para cubrir este reembolso de " + usd(monto) + ".");
      return;
    }
  }

  const seguro = await confirmar(
    aceptar ? "Aceptar reembolso" : "Rechazar reembolso",
    aceptar
      ? "Se descontará " + usd(monto) + " de tu saldo y se le devolverá a " + (r.clienteNombre || "el cliente") + ". Esta acción no se puede deshacer."
      : "El reembolso quedará marcado como rechazado y el cliente verá el motivo que escribiste.",
    aceptar ? "✓" : "✕"
  );
  if (!seguro) return;

  const ahora = Date.now();
  const updates = {};

  updates["reembolsos/" + id + "/estado"] = nuevoEstado;
  updates["reembolsos/" + id + "/fechaResolucion"] = ahora;
  updates["reembolsos/" + id + "/resueltoPor"] = "proveedor";
  if (!aceptar) updates["reembolsos/" + id + "/motivoRechazo"] = motivoRechazo;

  if (aceptar) {
    const movProvKey = db.ref("movimientosSaldo/" + npUid).push().key;
    /* ⭐ CORREGIDO: usa saldoReal (fresco), no npPerfil.saldoUsd (caché) */
    updates["usuarios/" + npUid + "/saldoUsd"] = red(saldoReal - monto);
    updates["movimientosSaldo/" + npUid + "/" + movProvKey] = {
      tipo: "reembolso",
      detalle: "Reembolso · " + (r.productoNombre || "producto") + " · " + (r.clienteNombre || "cliente"),
      montoUsd: monto,
      signo: "-",
      fecha: ahora
    };
  }

  try {
    await db.ref().update(updates);

    if (aceptar && r.clienteId) {
      try {
        await db.ref("usuarios/" + r.clienteId + "/saldoUsd").transaction(a => red(num(a) + monto));
        const movCliKey = db.ref("movimientosSaldo/" + r.clienteId).push().key;
        await db.ref("movimientosSaldo/" + r.clienteId + "/" + movCliKey).set({
          tipo: "reembolso",
          detalle: "Reembolso · " + (r.productoNombre || "producto"),
          montoUsd: monto,
          signo: "+",
          fecha: Date.now()
        });
      } catch (e) {
        console.error("No se pudo acreditar al cliente:", e);
        avisa("El reembolso se descontó de tu saldo, pero no se pudo acreditar al cliente automáticamente. Contacta a administración.");
      }
    }

    ok(aceptar
      ? "Reembolso aceptado. Se descontaron " + usd(monto) + " de tu saldo y se devolvieron al cliente."
      : "Reembolso rechazado.");
  } catch (e) {
    err("No se pudo procesar: " + e.message + " (revisa que las reglas de Firebase permitan esta actualización)");
  }
}
/* =========================================================
   RENOVACIONES
========================================================= */

function renderRenovaciones(){
  const cont = $("npListaRenovaciones");
  if (!cont) return;

  const ids = Object.keys(npRenovaciones).sort((a,b) => ts(npRenovaciones[b].fecha) - ts(npRenovaciones[a].fecha));

  if (!ids.length) {
    cont.innerHTML = '<div class="npEmpty">No hay solicitudes de renovación por ahora.</div>';
    return;
  }

  cont.innerHTML = ids.map(id => {
    const r = npRenovaciones[id];
    const estado = estadoDe(r.estado);

    const acciones = estado === "pendiente"
      ? '<div class="npVencAplicarRow" style="grid-template-columns:1fr 1fr;margin-top:10px;">' +
          '<button class="npBtn npBtnCyan" onclick="resolverRenovacion(\'' + escJS(id) + '\',\'aceptada\')">✓ Ya renové su acceso</button>' +
          '<button class="npBtn npBtnGhost" onclick="resolverRenovacion(\'' + escJS(id) + '\',\'cancelada\')">✕ No puedo renovar</button>' +
        '</div>'
      : '';

    return '<div class="npVencGrupo">' +
      '<div class="npVencGrupoHead">' +
        '<div>' +
          '<h4>' + esc(r.productoNombre || r.productoId || "Producto") + '</h4>' +
          '<p>' + esc(r.clienteNombre || "Cliente") + ' · ' + esc(fechaLarga(r.fecha)) + '</p>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div style="font-family:var(--font-mono);font-size:17px;color:#bdfff6;font-weight:800;">+' + usd(r.montoUsd) + '</div>' +
          badge(estado) +
        '</div>' +
      '</div>' +
      '<div class="npNotice" style="margin-top:8px;">' +
        'Pide extender <strong>' + num(r.duracionDias) + ' días</strong> más.' +
        (r.cuentaId ? '<br>Cuenta: <strong>' + esc(r.cuentaId.slice(0,10)) + '…</strong>' : "") +
        (estado === "pendiente"
          ? '<br><br>💰 El cliente ya pagó. El monto está acreditado en tu saldo. Solo confirma que extendiste su acceso.'
          : (estado === "aceptada"
              ? '<br><br>✓ Renovación confirmada.'
              : '<br><br>✕ Renovación cancelada. El administrador devolverá el saldo al cliente.')) +
      '</div>' +
      acciones +
    '</div>';
  }).join("");
}

async function resolverRenovacion(id, nuevoEstado){
  const r = npRenovaciones[id];
  if (!r || estadoDe(r.estado) !== "pendiente") return;

  const aceptar = nuevoEstado === "aceptada";

  const seguro = await confirmar(
    aceptar ? "Confirmar renovación" : "Cancelar renovación",
    aceptar
      ? "¿Ya extendiste el acceso de " + (r.clienteNombre || "el cliente") + " por " + num(r.duracionDias) + " días?"
      : "El administrador devolverá el saldo al cliente y se te descontará el monto acreditado.",
    aceptar ? "✓" : "✕"
  );
  if (!seguro) return;

  const updates = {};
  updates["renovaciones/" + id + "/estado"] = nuevoEstado;
  updates["renovaciones/" + id + "/fechaResolucion"] = Date.now();

  /* Si conocemos la cuenta, reiniciamos su vigencia */
  if (aceptar && r.productoId && r.cuentaId && npProductos[r.productoId]) {
    updates["cuentas/" + r.productoId + "/" + r.cuentaId + "/renovado"] = false;
    updates["cuentas/" + r.productoId + "/" + r.cuentaId + "/fechaVenta"] = Date.now();
    updates["cuentas/" + r.productoId + "/" + r.cuentaId + "/avisoAtendido"] = true;
  }

  try {
    await db.ref().update(updates);
    ok(aceptar ? "Renovación confirmada. Vigencia reiniciada." : "Renovación cancelada.");
  } catch (e) {
    err("No se pudo procesar: " + e.message);
  }
}

/* =========================================================
   SOPORTE WHATSAPP
========================================================= */

function prepararFormSoporte(){
  const inp = $("npSoporteNumero");
  if (inp && !inp.dataset.tocado) inp.value = npPublico.whatsappSoporte || "";
  setToggle("npGrupoSoporteActivo", "soporte", "npSoporteActivo",
            npPublico.soporteActivo === false ? "no" : "si");
}

async function guardarSoporte(event){
  if (event) event.preventDefault();

  const wsp = String(($("npSoporteNumero")||{}).value || "").replace(/\D/g, "");
  const activo = String(($("npSoporteActivo")||{}).value || "si") === "si";

  if (wsp && (wsp.length < 9 || wsp.length > 15)) {
    avisa("El número debe incluir el código de país. Ej: 51987654321");
    return;
  }

  try {
    await db.ref("proveedoresPublicos/" + npUid).update({
      nombre: npPublico.nombre || npPerfil.nombre,
      correo: npPerfil.correo,
      whatsappSoporte: wsp,
      soporteActivo: activo,
      actualizado: Date.now()
    });
    ok("Número de soporte guardado. Ya se muestra en el catálogo.");
    cerrarModalSoporte();
  } catch (e) {
    err("No se pudo guardar: " + e.message);
  }
}

/* =========================================================
   MODAL TIENDA (vista pública)
========================================================= */

function cargarTiendaPublica(){
  const grid = $("npTiendaGrid");
  if (grid) grid.innerHTML = '<div class="npEmpty">Cargando productos…</div>';

  Promise.all([
    db.ref("productos").get(),
    db.ref("proveedoresPublicos").get()
  ]).then(([sp, spp]) => {
    npTodosProductos   = sp.val() || {};
    npTodosProveedores = spp.val() || {};
    renderTienda();
  }).catch(() => {
    if (grid) grid.innerHTML = '<div class="npEmpty">No se pudo cargar el catálogo.</div>';
  });
}

function renderTienda(){
  const grid = $("npTiendaGrid");
  if (!grid) return;

  const fProd = norm(($("npBuscarTiendaProducto")||{}).value || "");
  const fProv = norm(($("npBuscarTiendaProveedor")||{}).value || "");

  let ids = Object.keys(npTodosProductos).filter(id => {
    const p = npTodosProductos[id];
    if (!p || p.activo === false || !p.nombre) return false;
    if (fProd && !norm(p.nombre + " " + (p.plataforma||"")).includes(fProd)) return false;
    if (fProv && !norm(p.proveedorNombre || "").includes(fProv)) return false;
    return true;
  });

  setTxt("npTextoResultadoTienda", "Mostrando " + ids.length + " producto(s) activo(s).");

  if (!ids.length) {
    grid.innerHTML = '<div class="npEmpty">No se encontraron productos con esos filtros.</div>';
    return;
  }

  ids.sort((a,b) => norm(npTodosProductos[a].nombre).localeCompare(norm(npTodosProductos[b].nombre)));

  grid.innerHTML = ids.map(id => {
    const p = npTodosProductos[id];
    const ilim = p.stockIlimitado === true;
    const stock = ilim ? "Ilimitado" : num(p.stock);
    const mio = p.proveedorId === npUid;
    const renovableBadge = p.esRenovable === false
      ? '<span class="npBadge bad" style="font-size:9px;">No renovable</span>'
      : '<span class="npBadge ok" style="font-size:9px;">Renovable</span>';

    return '<div class="npCard npTiendaCard" data-id="' + esc(id) + '">' +
      '<div class="npTiendaImg">' +
        (p.imagen ? '<img src="' + esc(p.imagen) + '" alt="" style="width:100%;height:100%;object-fit:cover;">' : "🖼️") +
      '</div>' +
      '<div class="npTiendaBody">' +
        '<h4>' + esc(p.nombre) + (mio ? ' <span class="npBadge info" style="font-size:9px;" data-html2canvas-ignore="true">Tuyo</span>' : "") + '</h4>' +
        '<div style="margin:-2px 0 2px;">' + renovableBadge + '</div>' +
        '<div class="npTiendaMeta">' +
          'Plataforma: <strong>' + esc(p.plataforma || "-") + '</strong><br>' +
          'Proveedor: <strong>' + esc(p.proveedorNombre || "NovaStream") + '</strong><br>' +
          'Stock: <strong>' + esc(String(stock)) + '</strong>' +
          (num(p.duracionDias) > 0 ? ' · ' + num(p.duracionDias) + ' días' : "") +
        '</div>' +
        '<div class="npTiendaPrecio">' +
          '<strong>' + usd(p.precioUsd) + '</strong><span>' + pen(p.precioUsd) + '</span>' +
        '</div>' +
        '<button type="button" class="npBtnMini edit npTiendaCapturaBtn" style="width:100%;margin-top:2px;" ' +
          'data-html2canvas-ignore="true" onclick="capturarProductoTienda(\'' + escJS(id) + '\')">📸 Captura de este producto</button>' +
      '</div>' +
    '</div>';
  }).join("");
}

/* Captura SOLO la tarjeta del producto indicado (no toda la tienda).
   El botón de captura y el badge "Tuyo" llevan data-html2canvas-ignore
   para no salir en la imagen final. */
async function capturarProductoTienda(id){
  const card = document.querySelector('.npTiendaCard[data-id="' + id + '"]');
  if (!card) { err("No se encontró la tarjeta del producto."); return; }

  if (typeof html2canvas !== "function") {
    err("No se pudo cargar la herramienta de captura.");
    return;
  }

  const btn = card.querySelector(".npTiendaCapturaBtn");
  const textoOriginal = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Generando..."; }

  try {
    const canvas = await html2canvas(card, {
      backgroundColor: "#0f1117",
      useCORS: true,
      scale: Math.min(2, window.devicePixelRatio || 1.5),
      ignoreElements: (el) => el.hasAttribute && el.hasAttribute("data-html2canvas-ignore")
    });

    const nombreArchivo = ((npTodosProductos[id] || {}).nombre || "producto")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

    const link = document.createElement("a");
    link.download = "novastream-" + nombreArchivo + "-" + Date.now() + ".png";
    link.href = canvas.toDataURL("image/png");
    link.click();

    ok("Captura guardada.");
  } catch (e) {
    err("No se pudo generar la captura: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal || "📸 Captura de este producto"; }
  }
}
/* =========================================================
   SUBPANELES (Productos / Cuentas)
========================================================= */

function cambiarSubpanel(panelId){
  document.querySelectorAll(".npSubToggleBtn[data-subpanel]").forEach(b => {
    b.classList.toggle("activo", b.dataset.subpanel === panelId);
  });
  document.querySelectorAll(".npSubPanel").forEach(p => {
    p.classList.toggle("activo", p.id === panelId);
  });
}

/* =========================================================
   AVISO DE SCROLL EN TABLAS (solo móvil)
========================================================= */

function inyectarAvisosScroll(){
  document.querySelectorAll(".npTableWrap").forEach(w => {
    if (w.dataset.hint) return;
    const hint = document.createElement("div");
    hint.className = "npScrollHint";
    hint.innerHTML = '<b>⇠</b> Desliza para ver todos los datos <b>⇢</b>';
    w.parentNode.insertBefore(hint, w);
    w.dataset.hint = "1";
  });
}

/* =========================================================
   ARRANQUE
========================================================= */

function prepararFormularios(){

  /* --- Menú lateral --- */
  document.querySelectorAll(".npMenuBtn[data-section]").forEach(b => {
    b.addEventListener("click", () => irASeccion(b.dataset.section));
  });

  const btnSop = $("npBtnSoporte");
  if (btnSop) btnSop.addEventListener("click", abrirModalSoporte);

  const btnSalir = $("npBtnCerrarSesion");
  if (btnSalir) btnSalir.addEventListener("click", async () => {
    const s = await confirmar("Cerrar sesión", "¿Deseas salir de tu panel de proveedor?", "🚪");
    if (s) cerrarSesionProveedor();
  });

  /* --- Subpaneles --- */
  document.querySelectorAll(".npSubToggleBtn[data-subpanel]").forEach(b => {
    b.addEventListener("click", () => cambiarSubpanel(b.dataset.subpanel));
  });

  /* --- Actualizar --- */
  const btnAct = $("npBtnActualizar");
  if (btnAct) btnAct.addEventListener("click", () => {
    renderTablaProductos(); renderCuentasProducto(); renderTablaVentas();
    renderTablaRetiros(); renderMovimientos(); renderReembolsos();
    renderRenovaciones(); renderResumen();
    info("Datos actualizados.");
  });

  /* --- Formulario producto --- */
  const fp = $("formProducto");
  if (fp) fp.addEventListener("submit", guardarProducto);

  const btnCancel = $("npBtnCancelarEdicionProducto");
  if (btnCancel) btnCancel.addEventListener("click", limpiarFormProducto);

  const precio = $("prodPrecio");
  if (precio) precio.addEventListener("input", actualizarFxPrecio);

  const dur = $("prodDuracion");
  if (dur) dur.addEventListener("change", actualizarDuracion);

  const durF = $("prodDuracionFecha");
  if (durF) durF.addEventListener("change", actualizarDuracion);

  conectarToggle("npGrupoModoEntrega", "modo", "prodModoEntrega", (v) => {
    setTxt("npModoEntregaHelp", v === "manual"
      ? "Manual: tú entregas el acceso al cliente por soporte."
      : "Automático: el cliente recibe el acceso al instante.");
  });
  conectarToggle("npGrupoReembolso", "reembolso", "prodAplicaReembolso");
  conectarToggle("npGrupoEsRenovable", "renovable", "prodEsRenovable");
  conectarToggle("npGrupoSoporteActivo", "soporte", "npSoporteActivo");
  conectarToggle("npGrupoModoEntrega", "modo", "prodModoEntrega", (v) => {
  setTxt("npModoEntregaHelp", v === "manual"
    ? "Manual: tú entregas el acceso al cliente por soporte."
    : "Automático: el cliente recibe el acceso al instante.");
});
conectarToggle("npGrupoReembolso", "reembolso", "prodAplicaReembolso");
conectarToggle("npGrupoEsRenovable", "renovable", "prodEsRenovable");
conectarToggle("npGrupoSoporteActivo", "soporte", "npSoporteActivo");
conectarSelectPlataforma();   // ⭐ AGREGAR ESTA LÍNEA
  /* --- Imagen --- */
  const btnImg = $("npBtnSubirImagen");
  const inpImg = $("prodImagenArchivo");
  if (btnImg && inpImg) btnImg.addEventListener("click", () => inpImg.click());
  if (inpImg) inpImg.addEventListener("change", (e) => manejarImagenProducto(e.target.files[0]));

  const btnQuitar = $("npBtnQuitarImagen");
  if (btnQuitar) btnQuitar.addEventListener("click", quitarImagenProducto);

  /* --- Cuentas --- */
  const selCta = $("npCuentaProducto");
  if (selCta) selCta.addEventListener("change", () => {
    renderCuentasProducto();
    const w = $("npCorreoResultadoWrap"); if (w) w.style.display = "none";
  });

  const fMasiva = $("formCargaMasiva");
  if (fMasiva) fMasiva.addEventListener("submit", cargarCuentasMasivo);

  const fClave = $("formCambioClavePorCorreo");
  if (fClave) fClave.addEventListener("submit", cambiarClavePorCorreo);

  const btnBorrarCant = $("npBtnBorrarCantidad");
  if (btnBorrarCant) btnBorrarCant.addEventListener("click", borrarCantidadCuentas);

  const fEdit = $("formEditarCuenta");
  if (fEdit) fEdit.addEventListener("submit", guardarCuentaEditada);

  /* --- Retiros --- */
  const fRet = $("formRetiro");
  if (fRet) fRet.addEventListener("submit", solicitarRetiro);

  const inpRet = $("retiroMonto");
  if (inpRet) inpRet.addEventListener("input", renderRetiroCalculo);

  const quick = $("npRetiroQuick");
  if (quick) quick.addEventListener("click", (e) => {
    const b = e.target.closest(".npQuickBtn");
    if (!b) return;
    const pct = num(b.dataset.porcentaje) / 100;
    const monto = red(saldoDisponible() * pct);
    if (inpRet) inpRet.value = monto > 0 ? monto.toFixed(2) : "";
    renderRetiroCalculo();
  });

  const grupoMetodo = $("npGrupoMetodoRetiro");
  if (grupoMetodo) grupoMetodo.addEventListener("click", (e) => {
    const b = e.target.closest(".npMetodoBtn");
    if (!b) return;
    grupoMetodo.querySelectorAll(".npMetodoBtn").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    const hid = $("retiroMetodo");
    if (hid) hid.value = b.dataset.metodo;
  });

  /* --- Soporte --- */
  const fSop = $("formSoporte");
  if (fSop) fSop.addEventListener("submit", guardarSoporte);

  const inpSop = $("npSoporteNumero");
  if (inpSop) inpSop.addEventListener("input", function(){ this.dataset.tocado = "1"; });

  /* --- Refrescar listas --- */
  const bR = $("npBtnRefrescarReembolsos");
  if (bR) bR.addEventListener("click", () => { renderReembolsos(); info("Reembolsos actualizados."); });

  const bN = $("npBtnRefrescarRenovaciones");
  if (bN) bN.addEventListener("click", () => { renderRenovaciones(); info("Renovaciones actualizadas."); });

  /* --- Tienda --- */
  ["npBuscarTiendaProducto","npBuscarTiendaProveedor"].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener("input", renderTienda);
  });

  const btnLimpiar = $("npBtnLimpiarTienda");
  if (btnLimpiar) btnLimpiar.addEventListener("click", () => {
    const a = $("npBuscarTiendaProducto"); if (a) a.value = "";
    const b = $("npBuscarTiendaProveedor"); if (b) b.value = "";
    renderTienda();
  });

  /* --- Cerrar modales al hacer clic fuera --- */
  ["npModalSoporte","npModalTienda","npModalVencimientos","npModalEditarCuenta"].forEach(id => {
    const m = $(id);
    if (m) m.addEventListener("mousedown", (e) => { if (e.target === m) m.classList.remove("show"); });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    ["npModalSoporte","npModalTienda","npModalVencimientos","npModalEditarCuenta","npConfirmOverlay"]
      .forEach(id => { const m = $(id); if (m) m.classList.remove("show"); });
    cerrarMenuMovil();
  });

  inyectarAvisosScroll();
  actualizarDuracion();
  actualizarFxPrecio();
}

/* =========================================================
   EXPONER FUNCIONES USADAS EN onclick DEL HTML
========================================================= */

window.irASeccion            = irASeccion;
window.abrirMenuMovil        = abrirMenuMovil;
window.cerrarMenuMovil       = cerrarMenuMovil;
window.abrirModalTienda      = abrirModalTienda;
window.cerrarModalTienda     = cerrarModalTienda;
window.abrirModalSoporte     = abrirModalSoporte;
window.cerrarModalSoporte    = cerrarModalSoporte;
window.abrirModalVencimientos  = abrirModalVencimientos;
window.cerrarModalVencimientos = cerrarModalVencimientos;
window.abrirModalEditarCuenta  = abrirModalEditarCuenta;
window.cerrarModalEditarCuenta = cerrarModalEditarCuenta;
window.editarProducto        = editarProducto;
window.toggleActivoProducto  = toggleActivoProducto;
window.eliminarProducto      = eliminarProducto;
window.eliminarCuenta        = eliminarCuenta;
window.cancelarRetiro        = cancelarRetiro;
window.resolverRenovacion    = resolverRenovacion;
window.resolverReembolso     = resolverReembolso;
window.marcarRenovo          = marcarRenovo;
window.aplicarClaveVencimiento = aplicarClaveVencimiento;
window.capturarProductoTienda  = capturarProductoTienda;
