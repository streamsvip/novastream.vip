/* =========================================================
   NOVASTREAM.VIP — novaadmin.js (v4)
   Panel Administrador

   ─────────────────────────────────────────────────────────
   ⚠️ CAMBIO IMPORTANTE EN ESTA VERSIÓN
   ─────────────────────────────────────────────────────────
   Se ELIMINÓ la lista ADMIN_EMAILS. Causaba un bug grave:
   el JavaScript te dejaba entrar por tu correo, pero las
   reglas de Firebase solo miran usuarios/{uid}/rol === 'admin'.
   Resultado: veías el panel pero TODAS las tablas salían
   vacías, porque cada lectura era rechazada en silencio.

   Ahora el único requisito es el real:
        usuarios/{tuUid}/rol === "admin"

   ── PRIMER ADMIN ──
   Firebase Console → Realtime Database → usuarios/{tuUid}
   y pon el campo   rol: "admin"
   (La consola omite las reglas, así que sí te deja.)

   ── MÁS ADMINS ──
   Desde este panel: Clientes → botón "👑 Admin".
   Como ya eres admin, las reglas te lo permiten.

   ─────────────────────────────────────────────────────────
   MODELO DE NEGOCIO
   ─────────────────────────────────────────────────────────
   1. El cliente recarga saldo  → usuarios/{uid}/saldoUsd
   2. El cliente compra         → el 100% del precio va al
                                  proveedor. Comisión de venta = 0.
   3. El proveedor pide retiro  → AQUÍ la plataforma cobra 20%.
                                  Se descuenta el monto COMPLETO del
                                  saldo del proveedor, se le paga el
                                  80% neto y el 20% es la ganancia.

   Por eso en el resumen:
     · "Volumen"  = dinero movido en ventas (no es ganancia).
     · "Comisión" = 20% de ese volumen → ganancia devengada.
     · "Comisión cobrada" = 20% de los retiros ya aprobados
       (lo que efectivamente entró a caja).
   ========================================================= */

/* =========================
   CONFIG
========================= */

const MC_FB_CONFIG = {
  apiKey: "AIzaSyCwMr1Ie2DmAePzI0X4qsSR5jE70OKbRkA",
  authDomain: "novastream-f3e15.firebaseapp.com",
  projectId: "novastream-f3e15",
  storageBucket: "novastream-f3e15.firebasestorage.app",
  messagingSenderId: "356156093772",
  appId: "1:356156093772:web:58fb86ad38d8560fc50be9",
  measurementId: "G-FVSMQBXNDX"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.database();

let storage = null;
try { storage = firebase.storage(); } catch (e) { storage = null; }

const NVA_COMISION_RETIRO = 0.20;
const NVA_TIPO_CAMBIO     = 3.40;
const LIMITE_REEMBOLSO_MS = 24 * 60 * 60 * 1000;

/* Se marca en true si algún nodo devuelve PERMISSION_DENIED */
let nvaSinPermisos = false;

/* =========================
   DOM BASE
========================= */

const loginSection = document.getElementById("loginSection");
const panelSection = document.getElementById("panelSection");
const loginMsg = document.getElementById("loginMsg");
const adminInfo = document.getElementById("adminInfo");
const loginBtn = document.getElementById("loginBtn");
const adminEmailInput = document.getElementById("adminEmail");
const adminPasswordInput = document.getElementById("adminPassword");
const toggleBtn = document.getElementById("toggleBtn");
const toggleTiempoActivoBtn = document.getElementById("toggleTiempoActivoBtn");

/* =========================
   CACHES
========================= */

let productosCache = {};
let stockCache = {};
let cuentasCache = {};
let cuentasRefs = {};
let categoriasCache = {};
let recargasCache = {};
let reembolsosCache = {};
let retirosCache = {};
let comisionesCache = {};
let usuariosCache = {};
let proveedoresPublicosCache = {};
let ventasCache = {};

let panelYaCargado = false;
let recargasInicializadas = false;
let recargasPendientesPrev = {};
let retirosInicializados = false;
let retirosPendientesPrev = {};

let categoriaImagenData = "";
let categoriaImagenNombre = "";

/* =========================
   FILTROS
========================= */

let filtroRecargas = "";
let filtroReembolsos = "";
let filtroRetiros = "";
let filtroStock = "";
let filtroVentas = "";
let filtroVentasHoy = "";
let filtroUsuarios = "";
let filtroProveedores = "";

/* =========================
   INACTIVIDAD
========================= */

const TIEMPO_INACTIVIDAD_ADMIN = 7 * 60 * 1000;
const TIEMPO_AVISO_ADMIN = 1 * 60 * 1000;

let adminTimeoutLogout = null;
let adminTimeoutAviso = null;
let adminControlIniciado = false;
let adminAvisoMostrado = false;

let tiempoActivoAdmin = localStorage.getItem("novastream_admin_tiempo_activo") === "true";

/* =========================================================
   UTILIDADES
========================================================= */

function textoSeguro(valor, fallback = "-") {
  if (valor === undefined || valor === null || valor === "") return fallback;
  return valor;
}

function escaparHTML(texto) {
  return String(texto ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escaparParaJS(valor) {
  return String(valor ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function safeDomKey(valor) {
  return String(valor ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function num(v) { return Number(v || 0); }
function redondear(v) { return Number(num(v).toFixed(2)); }
function fmtUsd(v) { return "$" + num(v).toFixed(2); }
function fmtPen(v) { return "S/ " + (num(v) * NVA_TIPO_CAMBIO).toFixed(2); }

function celdaMoneda(usd, clase = "") {
  return `
    <div class="nvaMoney ${clase}">
      <span class="nvaMoneyUsd">${fmtUsd(usd)}</span>
      <span class="nvaMoneyPen">≈ ${fmtPen(usd)}</span>
    </div>`;
}

function setTxt(id, valor) {
  const el = document.getElementById(id);
  if (el) el.textContent = valor;
}

function setMoneda(idUsd, idPen, usd, sufijoPen = "") {
  setTxt(idUsd, fmtUsd(usd));
  if (idPen) setTxt(idPen, "≈ " + fmtPen(usd) + (sufijoPen ? " · " + sufijoPen : ""));
}

function normalizarTexto(valor) {
  return String(valor || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function coincideFiltro(textoBase, filtro) {
  if (!filtro) return true;
  return normalizarTexto(textoBase).includes(normalizarTexto(filtro));
}

function formatearFecha(valor) {
  if (valor === undefined || valor === null || valor === "") return "-";
  const d = new Date(typeof valor === "number" ? valor : String(valor));
  if (isNaN(d.getTime())) return String(valor);
  return d.toLocaleString("es-PE", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

function formatearHora(valor) {
  const d = new Date(typeof valor === "number" ? valor : String(valor));
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
}

function ts(valor) {
  if (typeof valor === "number") return valor;
  const ms = new Date(valor || "").getTime();
  return isNaN(ms) ? 0 : ms;
}

function esHoy(valor) {
  const d = new Date(typeof valor === "number" ? valor : String(valor));
  if (isNaN(d.getTime())) return false;
  const ahora = new Date();
  return d.getFullYear() === ahora.getFullYear()
      && d.getMonth() === ahora.getMonth()
      && d.getDate() === ahora.getDate();
}

function esEsteMes(valor) {
  const d = new Date(typeof valor === "number" ? valor : String(valor));
  if (isNaN(d.getTime())) return false;
  const ahora = new Date();
  return d.getFullYear() === ahora.getFullYear() && d.getMonth() === ahora.getMonth();
}

function estadoNorm(estado, fallback = "pendiente") {
  return String(estado || fallback).toLowerCase().trim();
}

function nvaBadge(texto) {
  const t = String(texto || "").toLowerCase().trim();
  if (t.includes("desactiv") || t.includes("inactiv")) return `<span class="nvaBadge off">${escaparHTML(texto)}</span>`;
  if (t.includes("aprob") || t.includes("activ") || t.includes("complet") ||
      t.includes("entregad") || t.includes("disponible")) {
    return `<span class="nvaBadge ok">${escaparHTML(texto)}</span>`;
  }
  if (t.includes("pend")) return `<span class="nvaBadge warn">${escaparHTML(texto)}</span>`;
  if (t.includes("rechaz") || t.includes("bloque") || t.includes("agotad")) {
    return `<span class="nvaBadge bad">${escaparHTML(texto)}</span>`;
  }
  return `<span class="nvaBadge info">${escaparHTML(texto)}</span>`;
}

function permitirSoloNumerosDecimales(input) {
  if (!input) return;
  let valor = String(input.value || "").replace(/,/g, ".").replace(/[^0-9.]/g, "");
  valor = valor.replace(/(\..*)\./g, "$1");
  input.value = valor;
}

function prepararInputNumerico(input) {
  if (!input || input.dataset.numOk) return;
  input.setAttribute("type", "text");
  input.setAttribute("inputmode", "decimal");
  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", function () { permitirSoloNumerosDecimales(this); });
  input.dataset.numOk = "1";
}

/* =========================================================
   TOASTS Y MENSAJES
========================================================= */

function mostrarToast(texto, esError = false) {
  const stack = document.getElementById("nvaToastStack");
  if (!stack) return;

  const item = document.createElement("div");
  item.className = "nvaToastItem" + (esError ? " err" : "");
  item.textContent = texto;

  stack.appendChild(item);
  requestAnimationFrame(() => item.classList.add("show"));

  setTimeout(() => {
    item.classList.remove("show");
    setTimeout(() => item.remove(), 260);
  }, 4200);
}

function mostrarMensajeEn(id, texto, esError = false) {
  const el = document.getElementById(id);
  if (!el) { mostrarToast(texto, esError); return; }

  el.textContent = texto;
  el.style.color = esError ? "#ff9aa6" : "#7be3ac";

  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ""; }, 4200);
}

/* =========================================================
   AVISO DE PERMISOS
   Antes los errores se tragaban en silencio y las tablas
   quedaban vacías sin explicación. Ahora se muestra un
   banner con la solución exacta.
========================================================= */

function avisarSinPermisos(nodo, error) {
  console.error("❌ PERMISSION_DENIED en /" + nodo + " →", error && error.message);

  if (nvaSinPermisos) return;
  nvaSinPermisos = true;

  const cont = document.querySelector(".nvaContent");
  if (!cont) return;

  const uid = auth.currentUser ? auth.currentUser.uid : "TU_UID";

  const box = document.createElement("div");
  box.id = "nvaPermisosAviso";
  box.style.cssText =
    "padding:18px 20px;border-radius:16px;margin-bottom:20px;line-height:1.7;" +
    "background:linear-gradient(180deg,rgba(242,73,92,.14),rgba(242,73,92,.05));" +
    "border:1px solid rgba(242,73,92,.35);color:#ffdde1;font-size:13.5px;";

  box.innerHTML =
    '<strong style="display:block;font-size:15px;color:#fff;margin-bottom:8px;">' +
      '🔒 Tu cuenta no tiene rol de administrador en la base de datos' +
    '</strong>' +
    'Firebase está rechazando las lecturas. Por eso <b>Clientes</b>, <b>Retiros</b> y ' +
    '<b>Ventas</b> aparecen vacíos.' +
    '<div style="margin-top:12px;padding:12px 14px;border-radius:11px;' +
                'background:rgba(0,0,0,.30);font-family:var(--font-mono);font-size:12.5px;">' +
      '<b style="color:#5cf5d8;">Solución (1 minuto):</b><br>' +
      '1. Firebase Console → Realtime Database → Datos<br>' +
      '2. Abre <b>usuarios / ' + escaparHTML(uid) + '</b><br>' +
      '3. Pon el campo <b>rol</b> con el valor <b>admin</b><br>' +
      '4. Cierra sesión aquí y vuelve a entrar' +
    '</div>';

  cont.insertBefore(box, cont.firstChild);
}

/* =========================================================
   NAVEGACIÓN
========================================================= */

function irASeccion(targetId) {
  document.querySelectorAll(".nvaLink").forEach((link) => {
    link.classList.toggle("activo", link.dataset.target === targetId);
  });

  document.querySelectorAll(".nvaCard").forEach((card) => {
    card.classList.toggle("activo", card.id === targetId);
  });

  const dashboard = document.getElementById("dashboardResumen");
  if (dashboard) dashboard.classList.toggle("hiddenSection", targetId !== "dashboardResumen");

  cerrarSidebar();

  const contenido = document.querySelector(".nvaContent");
  if (contenido) contenido.scrollIntoView({ behavior: "smooth", block: "start" });
}

function abrirSidebar() { document.body.classList.add("nvaSideOpen"); }
function cerrarSidebar() { document.body.classList.remove("nvaSideOpen"); }

/* =========================================================
   LOGIN
========================================================= */

function togglePassword() {
  if (!adminPasswordInput || !toggleBtn) return;
  adminPasswordInput.type = adminPasswordInput.type === "password" ? "text" : "password";
  toggleBtn.textContent = adminPasswordInput.type === "password" ? "👁️" : "🙈";
}

if (adminEmailInput) adminEmailInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loginAdmin(); });
if (adminPasswordInput) adminPasswordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loginAdmin(); });

function setLoading(estado) {
  if (!loginBtn) return;
  loginBtn.disabled = estado;
  loginBtn.textContent = estado ? "Ingresando..." : "Iniciar sesión";
}

/* Verificación REAL: el único criterio válido es el rol en la base.
   Es exactamente lo mismo que evalúan las reglas de Firebase. */
async function esAdminAutorizado(user) {
  if (!user) return false;
  try {
    const snap = await db.ref("usuarios/" + user.uid + "/rol").get();
    return String(snap.val() || "").toLowerCase() === "admin";
  } catch (e) {
    console.error("No se pudo leer el rol:", e.message);
    return false;
  }
}

function loginAdmin() {
  const email = (adminEmailInput.value || "").trim().toLowerCase();
  const password = (adminPasswordInput.value || "").trim();

  loginMsg.textContent = "";

  if (!email || !password) {
    loginMsg.textContent = "Completa correo y contraseña.";
    return;
  }

  setLoading(true);

  auth.setPersistence(firebase.auth.Auth.Persistence.SESSION)
    .then(() => auth.signInWithEmailAndPassword(email, password))
    .then(async (cred) => {
      const autorizado = await esAdminAutorizado(cred.user);
      if (!autorizado) {
        const uid = cred.user.uid;
        await auth.signOut();
        throw new Error(
          "Esta cuenta no tiene rol de administrador.\n\n" +
          "Firebase Console → Realtime Database → usuarios/" + uid +
          "\ny pon el campo rol = admin"
        );
      }
    })
    .then(() => setLoading(false))
    .catch((error) => {
      setLoading(false);
      const c = String(error.code || "");

      if (c === "auth/user-not-found") loginMsg.textContent = "Ese correo no existe en Firebase Authentication.";
      else if (c.includes("wrong-password") || c.includes("invalid-credential") || c.includes("invalid-login")) {
        loginMsg.textContent = "Correo o contraseña incorrectos.";
      }
      else loginMsg.textContent = error.message || "No se pudo iniciar sesión.";
    });
}

function cerrarSesion() {
  limpiarAdminInactividad();
  auth.signOut()
    .then(() => window.location.replace("novaadmin.html"))
    .catch(() => window.location.replace("novaadmin.html"));
}

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    limpiarAdminInactividad();
    panelYaCargado = false;
    recargasInicializadas = false;
    retirosInicializados = false;

    loginSection.classList.remove("hidden");
    panelSection.classList.add("hidden");
    setLoading(false);
    return;
  }

  const autorizado = await esAdminAutorizado(user);

  if (!autorizado) {
    /* Se muestra el panel igual, pero con el banner explicativo:
       así entiendes qué pasa en vez de ver tablas vacías. */
    loginSection.classList.add("hidden");
    panelSection.classList.remove("hidden");
    adminInfo.textContent = user.email + " · SIN PERMISOS";
    pintarConstantes();
    avisarSinPermisos("usuarios", { message: "el campo rol no es 'admin'" });
    return;
  }

  loginSection.classList.add("hidden");
  panelSection.classList.remove("hidden");
  adminInfo.textContent = user.email;

  actualizarBotonTiempoActivo();
  pintarConstantes();

  if (!panelYaCargado) { cargarPanel(); panelYaCargado = true; }

  iniciarControlInactividad();
});

function pintarConstantes() {
  const pct = Math.round(NVA_COMISION_RETIRO * 100) + "%";
  setTxt("footComision", pct);
  setTxt("txtComisionResumen", pct);
  setTxt("fxChipValor", NVA_TIPO_CAMBIO.toFixed(2));
}

/* =========================================================
   INACTIVIDAD
========================================================= */

function actualizarBotonTiempoActivo() {
  if (!toggleTiempoActivoBtn) return;
  toggleTiempoActivoBtn.textContent = "Tiempo activo: " + (tiempoActivoAdmin ? "Activado" : "Desactivado");
}

function toggleTiempoActivo() {
  tiempoActivoAdmin = !tiempoActivoAdmin;
  localStorage.setItem("novastream_admin_tiempo_activo", tiempoActivoAdmin ? "true" : "false");
  actualizarBotonTiempoActivo();
  if (tiempoActivoAdmin) limpiarAdminInactividad(); else reiniciarAdminInactividad();
}

function limpiarAdminInactividad() {
  if (adminTimeoutLogout) clearTimeout(adminTimeoutLogout);
  if (adminTimeoutAviso) clearTimeout(adminTimeoutAviso);
  adminTimeoutLogout = null;
  adminTimeoutAviso = null;
}

function reiniciarAdminInactividad() {
  limpiarAdminInactividad();
  adminAvisoMostrado = false;
  if (tiempoActivoAdmin) return;

  adminTimeoutAviso = setTimeout(() => {
    if (adminAvisoMostrado) return;
    adminAvisoMostrado = true;
    mostrarToast("Panel inactivo. La sesión se cerrará en 1 minuto.", true);
  }, TIEMPO_INACTIVIDAD_ADMIN - TIEMPO_AVISO_ADMIN);

  adminTimeoutLogout = setTimeout(() => {
    limpiarAdminInactividad();
    auth.signOut().finally(() => window.location.replace("novaadmin.html"));
  }, TIEMPO_INACTIVIDAD_ADMIN);
}

function iniciarControlInactividad() {
  if (adminControlIniciado) { reiniciarAdminInactividad(); return; }

  ["mousemove","mousedown","click","scroll","keypress","touchstart","touchmove","keydown"]
    .forEach((ev) => document.addEventListener(ev, reiniciarAdminInactividad, true));

  window.addEventListener("focus", reiniciarAdminInactividad);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reiniciarAdminInactividad(); });

  adminControlIniciado = true;
  reiniciarAdminInactividad();
}

/* =========================================================
   BUSCADORES
========================================================= */

function conectarBuscador(inputId, onChange) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.busqOk) return;

  let debounce = null;
  input.addEventListener("input", function () {
    const valor = this.value || "";
    clearTimeout(debounce);
    debounce = setTimeout(() => onChange(valor), 150);
  });

  input.dataset.busqOk = "1";
}

function inicializarBuscadores() {
  conectarBuscador("buscarRecargas", (v) => { filtroRecargas = v; renderRecargas(); });
  conectarBuscador("buscarReembolsos", (v) => { filtroReembolsos = v; renderReembolsos(); });
  conectarBuscador("buscarRetiros", (v) => { filtroRetiros = v; renderRetiros(); });
  conectarBuscador("buscarStock", (v) => { filtroStock = v; renderStock(); });
  conectarBuscador("buscarVentas", (v) => { filtroVentas = v; renderVentas(); });
  conectarBuscador("buscarVentasHoy", (v) => { filtroVentasHoy = v; renderVentasHoy(); });
  conectarBuscador("buscarUsuarios", (v) => { filtroUsuarios = v; renderUsuarios(); });
  conectarBuscador("buscarProveedores", (v) => { filtroProveedores = v; renderProveedores(); });
}

/* =========================================================
   CARGA DEL PANEL
========================================================= */

function cargarPanel() {
  inicializarBuscadores();
  prepararUploadCategoria();

  cargarUsuarios();
  cargarProveedoresPublicos();
  cargarProductos();
  cargarStock();
  cargarRecargas();
  cargarCategorias();

  setTimeout(() => {
    cargarRetiros();
    cargarComisiones();
    cargarReembolsos();
  }, 500);

  setTimeout(() => {
    cargarVentas();
  }, 1200);
}

/* =========================================================
   HELPERS DE NEGOCIO
========================================================= */

function nombreUsuario(item = {}) {
  return item.nombre
      || item.nombreCompleto
      || [item.nombre || "", item.apellido || ""].join(" ").trim()
      || item.usuario
      || "-";
}

function saldoDe(item = {}) {
  if (item.saldoUsd !== undefined) return num(item.saldoUsd);
  return num(item.saldo);
}

function montoVenta(v = {}) {
  if (v.montoProveedorUsd !== undefined) return num(v.montoProveedorUsd);
  if (v.precioUsd !== undefined) return num(v.precioUsd);
  return num(v.monto || v.total);
}

function montoRecarga(r = {}) {
  if (r.montoAprobadoUsd !== undefined) return num(r.montoAprobadoUsd);
  if (r.montoUsd !== undefined) return num(r.montoUsd);
  return num(r.montoAprobado ?? r.monto);
}

function clienteDeRecarga(r = {}) {
  return String(r.clienteId || r.uidUsuario || r.uid || "").trim();
}

function comisionDe(montoUsd) { return redondear(num(montoUsd) * NVA_COMISION_RETIRO); }
function netoDe(montoUsd) { return redondear(num(montoUsd) - comisionDe(montoUsd)); }

function esProveedor(item = {}) { return String(item.rol || "").toLowerCase() === "proveedor"; }
function esAdminUser(item = {}) { return String(item.rol || "").toLowerCase() === "admin"; }

function contarPendientes(cache) {
  return Object.values(cache || {}).filter((it) =>
    it && typeof it === "object" && estadoNorm(it.estado) === "pendiente").length;
}

function stockRealDeCuentas(productoId) {
  const cuentas = cuentasCache[productoId] || {};
  return Object.values(cuentas).filter((c) => estadoNorm(c.estado, "disponible") === "disponible").length;
}

/* =========================================================
   DASHBOARD
========================================================= */

function renderDashboard() {
  setTxt("totalRecargas", contarPendientes(recargasCache));
  setTxt("totalReembolsos", contarPendientes(reembolsosCache));

  const retirosPend = Object.values(retirosCache || {}).filter((r) => estadoNorm(r.estado) === "pendiente");
  setTxt("totalRetirosProveedores", retirosPend.length);

  let porPagar = 0, comisionEnJuego = 0;
  retirosPend.forEach((r) => {
    const monto = num(r.montoUsd ?? r.monto);
    porPagar += (r.netoUsd !== undefined ? num(r.netoUsd) : netoDe(monto));
    comisionEnJuego += (r.comisionUsd !== undefined ? num(r.comisionUsd) : comisionDe(monto));
  });

  setMoneda("montoPorPagar", "montoPorPagarPen", porPagar, "neto a transferir");
  setTxt("retirosPendientesCount", retirosPend.length);
  setMoneda("retirosPendientesNeto", "retirosPendientesNetoPen", porPagar, "lo que sale de tu bolsillo");
  setMoneda("retirosPendientesComision", "retirosPendientesComisionPen", comisionEnJuego, "tu ganancia al aprobar");

  const ventas = Object.keys(ventasCache || {}).map((id) => ({ id, ...(ventasCache[id] || {}) }));

  let volumenHist = 0, volumenMes = 0, volumenHoy = 0;
  let ventasMes = 0, ventasHoy = 0;
  const conteoProductos = {};

  ventas.forEach((v) => {
    const m = montoVenta(v);
    volumenHist += m;

    if (esEsteMes(v.fecha)) {
      volumenMes += m;
      ventasMes++;
      const p = v.productoNombre || v.producto || v.productoId || "-";
      conteoProductos[p] = (conteoProductos[p] || 0) + 1;
    }

    if (esHoy(v.fecha)) { volumenHoy += m; ventasHoy++; }
  });

  setTxt("totalVentasHistorico", String(ventas.length));
  setTxt("totalVentasMes", String(ventasMes));
  setTxt("totalVentasHoy", String(ventasHoy));

  setMoneda("volumenMes", "volumenMesPen", volumenMes, "dinero movido");
  setMoneda("volumenHoy", "volumenHoyPen", volumenHoy);
  setMoneda("volumenHistorico", "volumenHistoricoPen", volumenHist);

  setMoneda("comisionMes", "comisionMesPen", comisionDe(volumenMes), "ganancia devengada");
  setMoneda("comisionHoy", "comisionHoyPen", comisionDe(volumenHoy));
  setMoneda("comisionHistorica", "comisionHistoricaPen", comisionDe(volumenHist), "sobre todas las ventas");

  setTxt("topProductoMes", topClave(conteoProductos));

  /* Comisión efectivamente cobrada */
  let comisionCobrada = 0;
  Object.values(comisionesCache || {}).forEach((c) => { comisionCobrada += num(c.comisionUsd); });

  if (!Object.keys(comisionesCache || {}).length) {
    Object.values(retirosCache || {}).forEach((r) => {
      if (estadoNorm(r.estado) !== "aprobado") return;
      const monto = num(r.montoUsd ?? r.monto);
      comisionCobrada += (r.comisionUsd !== undefined ? num(r.comisionUsd) : comisionDe(monto));
    });
  }

  setMoneda("comisionCobrada", "comisionCobradaPen", comisionCobrada, "retiros aprobados");
  setMoneda("retirosComisionCobrada", "retirosComisionCobradaPen", comisionCobrada);

  const recargasHoy = Object.values(recargasCache || {}).filter((r) =>
    estadoNorm(r.estado) === "aprobada" && esHoy(r.fechaAprobacion || r.fecha)
  );

  let montoRecargadoHoy = 0;
  recargasHoy.forEach((r) => { montoRecargadoHoy += montoRecarga(r); });

  setMoneda("montoRecargadoHoyDash", null, montoRecargadoHoy);
  setTxt("recargasHoyDash", recargasHoy.length + " recargas aprobadas");

  let saldoProv = 0, provActivos = 0, clientes = 0;

  Object.values(usuariosCache || {}).forEach((u) => {
    if (esAdminUser(u)) return;
    if (esProveedor(u)) {
      saldoProv += saldoDe(u);
      if (String(u.estado || "activo").toLowerCase() !== "bloqueado") provActivos++;
    } else {
      clientes++;
    }
  });

  setMoneda("saldoProveedores", "saldoProveedoresPen", saldoProv, "pendiente de retiro");
  setTxt("totalProveedoresActivos", String(provActivos));
  setTxt("totalUsuarios", String(clientes));

  const ids = Object.keys(productosCache || {});
  let unidades = 0;

  ids.forEach((id) => {
    const p = productosCache[id] || {};
    if (p.stockIlimitado === true || p.tipoEntrega === "descarga") return;
    unidades += num(stockCache[id] ?? p.stock);
  });

  setTxt("totalProductos", String(ids.length));
  setTxt("totalStock", String(unidades));
}

function topClave(conteo) {
  let mejor = "-", max = 0;
  Object.keys(conteo).forEach((k) => { if (conteo[k] > max) { max = conteo[k]; mejor = k; } });
  return max > 0 ? `${mejor} (${max})` : "Sin datos aún";
}

/* =========================================================
   RECARGAS
========================================================= */

function aprobarRecarga(id) {
  const input = document.getElementById("recargaMonto_" + safeDomKey(id));
  permitirSoloNumerosDecimales(input);
  let montoEditado = num(input?.value);

  db.ref("recargas/" + id).get()
    .then((snap) => {
      const item = snap.val();
      if (!item) throw new Error("La recarga no existe.");

      const uid = clienteDeRecarga(item);
      const estado = estadoNorm(item.estado);

      if (!uid) throw new Error("La recarga no identifica al cliente (falta clienteId).");
      if (estado === "aprobada") throw new Error("Esta recarga ya fue aprobada.");
      if (estado === "rechazada") throw new Error("Esta recarga ya fue rechazada.");

      if (!montoEditado || montoEditado <= 0) montoEditado = montoRecarga(item);
      if (!montoEditado || montoEditado <= 0) throw new Error("El monto a aprobar no es válido.");

      montoEditado = redondear(montoEditado);

      return db.ref("usuarios/" + uid).get().then((us) => {
        const usuario = us.val();
        if (!usuario) throw new Error("No existe el usuario en usuarios/" + uid);

        const ahora = Date.now();
        const movKey = db.ref("movimientosSaldo/" + uid).push().key;

        const updates = {};
        updates["usuarios/" + uid + "/saldoUsd"] = redondear(saldoDe(usuario) + montoEditado);
        updates["recargas/" + id + "/estado"] = "aprobada";
        updates["recargas/" + id + "/montoAprobadoUsd"] = montoEditado;
        updates["recargas/" + id + "/fechaAprobacion"] = ahora;
        updates["recargas/" + id + "/adminUid"] = auth.currentUser ? auth.currentUser.uid : "";
        updates["movimientosSaldo/" + uid + "/" + movKey] = {
          tipo: "recarga",
          detalle: "Recarga aprobada · " + (item.metodoPago || "manual"),
          montoUsd: montoEditado,
          signo: "+",
          fecha: ahora
        };

        return db.ref().update(updates);
      });
    })
    .then(() => mostrarMensajeEn("recargaMsg", "Recarga aprobada. Saldo acreditado al cliente."))
    .catch((err) => mostrarMensajeEn("recargaMsg", "Error: " + err.message, true));
}

function rechazarRecarga(id) {
  db.ref("recargas/" + id).get()
    .then((snap) => {
      const item = snap.val();
      if (!item) throw new Error("La recarga no existe.");

      const estado = estadoNorm(item.estado);
      if (estado === "aprobada") throw new Error("No puedes rechazar una recarga ya aprobada.");
      if (estado === "rechazada") throw new Error("Esta recarga ya fue rechazada.");

      return db.ref("recargas/" + id).update({
        estado: "rechazada",
        fechaRechazo: Date.now(),
        adminUid: auth.currentUser ? auth.currentUser.uid : ""
      });
    })
    .then(() => mostrarMensajeEn("recargaMsg", "Recarga rechazada."))
    .catch((err) => mostrarMensajeEn("recargaMsg", "Error: " + err.message, true));
}

function eliminarRecarga(id) {
  if (!confirm("¿Eliminar esta recarga del historial?")) return;
  db.ref("recargas/" + id).remove()
    .then(() => mostrarMensajeEn("recargaMsg", "Recarga eliminada del historial."))
    .catch((err) => mostrarMensajeEn("recargaMsg", "Error: " + err.message, true));
}

function renderRecargas() {
  const tbody = document.querySelector("#tablaRecargas tbody");
  const tabla = document.getElementById("tablaRecargas");
  const vacio = document.getElementById("recargasVacio");
  const badge = document.getElementById("badgeRecargas");
  if (!tbody || !tabla || !vacio) return;

  const data = recargasCache || {};
  let keys = Object.keys(data).filter((id) => data[id] && typeof data[id] === "object");

  const pendientes = keys.filter((id) => estadoNorm(data[id].estado) === "pendiente");
  if (badge) badge.textContent = String(pendientes.length);

  const aprobHoy = keys.filter((id) =>
    estadoNorm(data[id].estado) === "aprobada" && esHoy(data[id].fechaAprobacion || data[id].fecha)
  );
  const montoHoy = aprobHoy.reduce((a, id) => a + montoRecarga(data[id]), 0);

  setTxt("recargasHoyCount", String(aprobHoy.length));
  setMoneda("recargasHoyMonto", "recargasHoyMontoPen", montoHoy);
  setTxt("recargasPendientesCount", String(pendientes.length));

  keys.sort((a, b) => ts(data[b].fecha || data[b].fechaAprobacion) - ts(data[a].fecha || data[a].fechaAprobacion));

  if (filtroRecargas) {
    keys = keys.filter((id) => {
      const it = data[id];
      const uid = clienteDeRecarga(it);
      const u = usuariosCache[uid] || {};
      const texto = [id, it.clienteNombre, nombreUsuario(u), u.usuario, u.correo, uid,
                     it.metodoPago, it.operacion, it.numeroOperacion, it.estado].join(" ");
      return coincideFiltro(texto, filtroRecargas);
    });
  }

  if (!keys.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    renderDashboard();
    return;
  }

  tbody.innerHTML = keys.map((id) => {
    const it = data[id] || {};
    const estado = estadoNorm(it.estado);
    const uid = clienteDeRecarga(it);
    const u = usuariosCache[uid] || {};
    const nombre = it.clienteNombre || nombreUsuario(u);
    const monto = montoRecarga(it);
    const resuelto = estado === "aprobada" || estado === "rechazada";
    const comp = String(it.comprobanteURL || "").trim();

    const compHtml = comp
      ? `<a class="nvaCompLink" href="${escaparHTML(comp)}" target="_blank" rel="noopener">Ver comprobante</a>`
      : `<span class="nvaCompLink disabled">Sin comprobante</span>`;

    const acciones = resuelto
      ? `<button class="nvaBtnMini soft" onclick="eliminarRecarga('${escaparParaJS(id)}')">Eliminar</button>`
      : `<button class="nvaBtnMini ok" onclick="aprobarRecarga('${escaparParaJS(id)}')">Aprobar</button>
         <button class="nvaBtnMini danger" onclick="rechazarRecarga('${escaparParaJS(id)}')">Rechazar</button>
         <button class="nvaBtnMini soft" onclick="eliminarRecarga('${escaparParaJS(id)}')">Eliminar</button>`;

    return `
      <tr>
        <td>${escaparHTML(formatearFecha(it.fecha || it.fechaAprobacion))}</td>
        <td>
          <div class="nvaEntity">
            <strong>${escaparHTML(textoSeguro(nombre))}</strong>
            <small>${escaparHTML(u.usuario ? "@" + u.usuario : uid || "-")}</small>
          </div>
        </td>
        <td>
          <div class="nvaMontoInlineWrap">
            <input type="text" inputmode="decimal" class="nvaMontoInline"
                   id="recargaMonto_${safeDomKey(id)}" value="${monto.toFixed(2)}" ${resuelto ? "disabled" : ""}>
            <small>USD</small>
          </div>
        </td>
        <td><span class="nvaMoneyPen">${fmtPen(monto)}</span></td>
        <td>${escaparHTML(textoSeguro(it.metodoPago))}</td>
        <td><small style="font-family:var(--font-mono)">${escaparHTML(textoSeguro(it.operacion || it.numeroOperacion))}</small></td>
        <td>${compHtml}</td>
        <td>${nvaBadge(estado)}</td>
        <td><div class="nvaActions">${acciones}</div></td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll('input[id^="recargaMonto_"]').forEach(prepararInputNumerico);

  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");
  renderDashboard();
}

function cargarRecargas() {
  db.ref("recargas").limitToLast(250).on("value", (snap) => {
    recargasCache = snap.val() || {};
    console.log("✅ recargas:", Object.keys(recargasCache).length);
    renderRecargas();

    const nuevas = {};
    Object.keys(recargasCache).forEach((id) => {
      if (estadoNorm(recargasCache[id].estado) === "pendiente") nuevas[id] = true;
    });

    if (!recargasInicializadas) {
      recargasPendientesPrev = nuevas;
      recargasInicializadas = true;
      return;
    }

    const antes = Object.keys(recargasPendientesPrev);
    if (Object.keys(nuevas).some((id) => !antes.includes(id))) {
      mostrarToast("💳 Nueva solicitud de recarga pendiente.");
    }

    recargasPendientesPrev = nuevas;
  }, (err) => {
    recargasCache = {};
    renderRecargas();
    avisarSinPermisos("recargas", err);
  });
}

/* =========================================================
   RETIROS DE PROVEEDORES
   Aquí la plataforma cobra su comisión.
========================================================= */

function copiarAlPortapapeles(texto, btn) {
  const ok = () => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = "✓ Copiado";
    btn.classList.add("copiado");
    setTimeout(() => { btn.textContent = original; btn.classList.remove("copiado"); }, 1800);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(ok).catch(() => mostrarToast("No se pudo copiar.", true));
  } else {
    const ta = document.createElement("textarea");
    ta.value = texto;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); ok(); } catch (e) { mostrarToast("No se pudo copiar.", true); }
    ta.remove();
  }
}

function aprobarRetiro(id) {
  db.ref("retirosProveedores/" + id).get()
    .then((snap) => {
      const item = snap.val();
      if (!item) throw new Error("La solicitud de retiro no existe.");

      const proveedorId = String(item.proveedorId || "").trim();
      const monto = redondear(item.montoUsd ?? item.monto);
      const estado = estadoNorm(item.estado);

      if (!proveedorId) throw new Error("La solicitud no tiene proveedorId.");
      if (!monto || monto <= 0) throw new Error("Monto inválido.");
      if (estado === "aprobado") throw new Error("Este retiro ya fue aprobado.");
      if (estado === "rechazado") throw new Error("Este retiro ya fue rechazado.");

      const comision = item.comisionUsd !== undefined ? redondear(item.comisionUsd) : comisionDe(monto);
      const neto = item.netoUsd !== undefined ? redondear(item.netoUsd) : redondear(monto - comision);

      const confirmar = confirm(
        "CONFIRMAR PAGO DE RETIRO\n\n" +
        "Proveedor: " + (item.proveedorNombre || proveedorId) + "\n" +
        "Método: " + (item.metodo || "-") + "\n" +
        "Dato de pago: " + (item.datoPago || "-") + "\n\n" +
        "Solicitado:  " + fmtUsd(monto) + "  (" + fmtPen(monto) + ")\n" +
        "Comisión " + Math.round(NVA_COMISION_RETIRO * 100) + "%: -" + fmtUsd(comision) + "  (" + fmtPen(comision) + ")\n" +
        "───────────────────────────\n" +
        "➜ DEBES TRANSFERIR: " + fmtUsd(neto) + "  (" + fmtPen(neto) + ")\n\n" +
        "¿Ya realizaste la transferencia por ese monto neto?"
      );
      if (!confirmar) throw new Error("Operación cancelada por el administrador.");

      return db.ref("usuarios/" + proveedorId).get().then((us) => {
        const prov = us.val();
        if (!prov) throw new Error("No existe el proveedor en usuarios/" + proveedorId);

        const saldoActual = saldoDe(prov);
        if (monto > saldoActual + 0.001) {
          throw new Error("El proveedor solo tiene " + fmtUsd(saldoActual) + " de saldo.");
        }

        const ahora = Date.now();
        const movKey = db.ref("movimientosSaldo/" + proveedorId).push().key;
        const comKey = db.ref("comisiones").push().key;

        const updates = {};

        /* Se descuenta el MONTO COMPLETO del saldo del proveedor. */
        updates["usuarios/" + proveedorId + "/saldoUsd"] = redondear(saldoActual - monto);

        updates["retirosProveedores/" + id + "/estado"] = "aprobado";
        updates["retirosProveedores/" + id + "/montoUsd"] = monto;
        updates["retirosProveedores/" + id + "/comisionUsd"] = comision;
        updates["retirosProveedores/" + id + "/comisionPorcentaje"] = NVA_COMISION_RETIRO * 100;
        updates["retirosProveedores/" + id + "/netoUsd"] = neto;
        updates["retirosProveedores/" + id + "/netoPen"] = redondear(neto * NVA_TIPO_CAMBIO);
        updates["retirosProveedores/" + id + "/fechaResolucion"] = ahora;
        updates["retirosProveedores/" + id + "/adminUid"] = auth.currentUser ? auth.currentUser.uid : "";

        updates["movimientosSaldo/" + proveedorId + "/" + movKey] = {
          tipo: "retiro",
          detalle: "Retiro aprobado · " + (item.metodo || "-") + " · neto " + fmtUsd(neto),
          montoUsd: monto,
          signo: "-",
          fecha: ahora
        };

        /* Libro de comisiones: aquí queda registrada la ganancia real */
        updates["comisiones/" + comKey] = {
          retiroId: id,
          proveedorId,
          proveedorNombre: item.proveedorNombre || nombreUsuario(prov),
          montoUsd: monto,
          comisionUsd: comision,
          comisionPorcentaje: NVA_COMISION_RETIRO * 100,
          netoUsd: neto,
          fecha: ahora
        };

        return db.ref().update(updates);
      });
    })
    .then(() => mostrarToast("✅ Retiro aprobado. Comisión registrada y saldo descontado."))
    .catch((err) => {
      if (String(err.message).includes("cancelada")) return;
      mostrarToast("Error al aprobar retiro: " + err.message, true);
    });
}

function rechazarRetiro(id) {
  const motivo = prompt("Motivo del rechazo (se guarda para el proveedor):", "");
  if (motivo === null) return;

  db.ref("retirosProveedores/" + id).get()
    .then((snap) => {
      const item = snap.val();
      if (!item) throw new Error("La solicitud no existe.");

      const estado = estadoNorm(item.estado);
      if (estado === "aprobado") throw new Error("No puedes rechazar un retiro ya aprobado.");
      if (estado === "rechazado") throw new Error("Este retiro ya fue rechazado.");

      return db.ref("retirosProveedores/" + id).update({
        estado: "rechazado",
        motivoRechazo: motivo || "Sin especificar",
        fechaResolucion: Date.now(),
        adminUid: auth.currentUser ? auth.currentUser.uid : ""
      });
    })
    .then(() => mostrarToast("Retiro rechazado. El saldo del proveedor no se tocó."))
    .catch((err) => mostrarToast("Error: " + err.message, true));
}

function eliminarRetiro(id) {
  if (!confirm("¿Eliminar esta solicitud de retiro del historial?")) return;
  db.ref("retirosProveedores/" + id).remove()
    .then(() => mostrarToast("Retiro eliminado del historial."))
    .catch((err) => mostrarToast("Error: " + err.message, true));
}

function renderRetiros() {
  const tbody = document.querySelector("#tablaRetirosProveedores tbody");
  const tabla = document.getElementById("tablaRetirosProveedores");
  const vacio = document.getElementById("retirosProveedoresVacio");
  const badge = document.getElementById("badgeRetiros");
  if (!tbody || !tabla || !vacio) return;

  const data = retirosCache || {};
  let keys = Object.keys(data).filter((id) => data[id] && typeof data[id] === "object");

  const pendientes = keys.filter((id) => estadoNorm(data[id].estado) === "pendiente");
  if (badge) badge.textContent = String(pendientes.length);

  keys.sort((a, b) => ts(data[b].fechaSolicitud) - ts(data[a].fechaSolicitud));

  if (filtroRetiros) {
    keys = keys.filter((id) => {
      const it = data[id];
      const texto = [id, it.proveedorNombre, it.proveedorId, it.metodo, it.datoPago, it.estado].join(" ");
      return coincideFiltro(texto, filtroRetiros);
    });
  }

  if (!keys.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    renderDashboard();
    return;
  }

  tbody.innerHTML = keys.map((id) => {
    const it = data[id] || {};
    const estado = estadoNorm(it.estado);
    const monto = redondear(it.montoUsd ?? it.monto);
    const comision = it.comisionUsd !== undefined ? redondear(it.comisionUsd) : comisionDe(monto);
    const neto = it.netoUsd !== undefined ? redondear(it.netoUsd) : redondear(monto - comision);
    const prov = usuariosCache[it.proveedorId] || {};
    const dato = String(it.datoPago || "").trim();

    const acciones = estado === "pendiente"
      ? `<button class="nvaBtnMini ok" onclick="aprobarRetiro('${escaparParaJS(id)}')">Pagar y aprobar</button>
         <button class="nvaBtnMini danger" onclick="rechazarRetiro('${escaparParaJS(id)}')">Rechazar</button>`
      : `<button class="nvaBtnMini soft" onclick="eliminarRetiro('${escaparParaJS(id)}')">Eliminar</button>`;

    const motivo = it.motivoRechazo
      ? `<br><small style="color:#ff9aa6">${escaparHTML(it.motivoRechazo)}</small>`
      : "";

    return `
      <tr>
        <td>${escaparHTML(formatearFecha(it.fechaSolicitud))}</td>
        <td>
          <div class="nvaEntity">
            <strong>${escaparHTML(textoSeguro(it.proveedorNombre || nombreUsuario(prov)))}</strong>
            <small>saldo: ${fmtUsd(saldoDe(prov))}</small>
          </div>
        </td>
        <td>${celdaMoneda(monto)}</td>
        <td>${celdaMoneda(comision, "neg")}</td>
        <td>${celdaMoneda(neto, "key")}</td>
        <td>${escaparHTML(textoSeguro(it.metodo))}</td>
        <td>
          <div class="nvaPagoCell">
            <span class="nvaPagoDato">${escaparHTML(textoSeguro(dato))}</span>
            ${dato ? `<button type="button" class="nvaCopyBtn" onclick="copiarAlPortapapeles('${escaparParaJS(dato)}', this)">Copiar dato</button>` : ""}
          </div>
        </td>
        <td>${nvaBadge(estado)}${motivo}</td>
        <td><div class="nvaActions">${acciones}</div></td>
      </tr>`;
  }).join("");

  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");
  renderDashboard();
}

function cargarRetiros() {
  db.ref("retirosProveedores").limitToLast(250).on("value", (snap) => {
    retirosCache = snap.val() || {};
    console.log("✅ retirosProveedores:", Object.keys(retirosCache).length);
    renderRetiros();

    const nuevos = {};
    Object.keys(retirosCache).forEach((id) => {
      if (estadoNorm(retirosCache[id].estado) === "pendiente") nuevos[id] = true;
    });

    if (!retirosInicializados) {
      retirosPendientesPrev = nuevos;
      retirosInicializados = true;
      return;
    }

    const antes = Object.keys(retirosPendientesPrev);
    if (Object.keys(nuevos).some((id) => !antes.includes(id))) {
      mostrarToast("🏦 Nuevo retiro de proveedor pendiente de pago.");
    }

    retirosPendientesPrev = nuevos;
  }, (err) => {
    retirosCache = {};
    renderRetiros();
    avisarSinPermisos("retirosProveedores", err);
  });
}

function cargarComisiones() {
  db.ref("comisiones").limitToLast(500).on("value", (snap) => {
    comisionesCache = snap.val() || {};
    renderDashboard();
  }, (err) => { comisionesCache = {}; avisarSinPermisos("comisiones", err); });
}

/* =========================================================
   REEMBOLSOS
========================================================= */

function aprobarReembolso(id) {
  db.ref("reembolsos/" + id).get()
    .then((snap) => {
      const item = snap.val();
      if (!item) throw new Error("La solicitud no existe.");

      const clienteId = String(item.clienteId || item.uidUsuario || "").trim();
      const proveedorId = String(item.proveedorId || "").trim();
      const monto = redondear(item.montoUsd ?? item.monto);
      const estado = estadoNorm(item.estado);

      if (!clienteId) throw new Error("La solicitud no identifica al cliente.");
      if (!monto || monto <= 0) throw new Error("Monto inválido.");
      if (estado === "aprobado") throw new Error("Este reembolso ya fue aprobado.");
      if (estado === "rechazado") throw new Error("Este reembolso ya fue rechazado.");

      if (!confirm(
        "Se devolverán " + fmtUsd(monto) + " al cliente y se descontará el mismo monto al proveedor.\n" +
        "Si la cuenta entregada no fue usada, volverá al stock.\n\n¿Continuar?"
      )) throw new Error("Operación cancelada.");

      return Promise.all([
        db.ref("usuarios/" + clienteId).get(),
        proveedorId ? db.ref("usuarios/" + proveedorId).get() : Promise.resolve(null)
      ]).then(([cs, ps]) => {
        const cliente = cs.val();
        if (!cliente) throw new Error("No existe el cliente.");

        const ahora = Date.now();
        const updates = {};

        /* 1. Devolver al cliente */
        updates["usuarios/" + clienteId + "/saldoUsd"] = redondear(saldoDe(cliente) + monto);

        const movCli = db.ref("movimientosSaldo/" + clienteId).push().key;
        updates["movimientosSaldo/" + clienteId + "/" + movCli] = {
          tipo: "reembolso",
          detalle: "Reembolso aprobado · " + (item.productoNombre || item.productoId || "producto"),
          montoUsd: monto, signo: "+", fecha: ahora
        };

        /* 2. Descontar al proveedor que cobró la venta */
        if (proveedorId && ps && ps.val()) {
          const prov = ps.val();
          updates["usuarios/" + proveedorId + "/saldoUsd"] = redondear(Math.max(0, saldoDe(prov) - monto));

          const movProv = db.ref("movimientosSaldo/" + proveedorId).push().key;
          updates["movimientosSaldo/" + proveedorId + "/" + movProv] = {
            tipo: "reembolso",
            detalle: "Reembolso al cliente · " + (item.productoNombre || item.productoId || "producto"),
            montoUsd: monto, signo: "-", fecha: ahora
          };
        }

        /* 3. Devolver la cuenta al stock si se conoce */
        const productoId = String(item.productoId || "").trim();
        const cuentaId = String(item.cuentaId || "").trim();

        if (productoId && cuentaId) {
          const base = "cuentas/" + productoId + "/" + cuentaId + "/";
          updates[base + "estado"] = "disponible";
          updates[base + "compradorId"] = null;
          updates[base + "compradorNombre"] = null;
          updates[base + "fechaVenta"] = null;

          const p = productosCache[productoId] || {};
          if (p.stockIlimitado !== true) {
            const nuevo = num(stockCache[productoId] ?? p.stock) + 1;
            updates["stock/" + productoId] = nuevo;
            updates["productos/" + productoId + "/stock"] = nuevo;
          }
        }

        /* 4. Cerrar la solicitud */
        updates["reembolsos/" + id + "/estado"] = "aprobado";
        updates["reembolsos/" + id + "/fechaResolucion"] = ahora;
        updates["reembolsos/" + id + "/adminUid"] = auth.currentUser ? auth.currentUser.uid : "";

        return db.ref().update(updates);
      });
    })
    .then(() => mostrarMensajeEn("reembolsoMsg", "Reembolso aprobado. Saldo devuelto y stock repuesto."))
    .catch((err) => {
      if (String(err.message).includes("cancelada")) return;
      mostrarMensajeEn("reembolsoMsg", "Error: " + err.message, true);
    });
}

function rechazarReembolso(id) {
  const motivo = prompt("Motivo del rechazo:", "");
  if (motivo === null) return;

  db.ref("reembolsos/" + id).get()
    .then((snap) => {
      const item = snap.val();
      if (!item) throw new Error("La solicitud no existe.");

      const estado = estadoNorm(item.estado);
      if (estado === "aprobado") throw new Error("No puedes rechazar un reembolso ya aprobado.");
      if (estado === "rechazado") throw new Error("Este reembolso ya fue rechazado.");

      return db.ref("reembolsos/" + id).update({
        estado: "rechazado",
        motivoRechazo: motivo || "Sin especificar",
        fechaResolucion: Date.now(),
        adminUid: auth.currentUser ? auth.currentUser.uid : ""
      });
    })
    .then(() => mostrarMensajeEn("reembolsoMsg", "Reembolso rechazado."))
    .catch((err) => mostrarMensajeEn("reembolsoMsg", "Error: " + err.message, true));
}

function eliminarReembolso(id) {
  if (!confirm("¿Eliminar esta solicitud del historial?")) return;
  db.ref("reembolsos/" + id).remove()
    .then(() => mostrarMensajeEn("reembolsoMsg", "Reembolso eliminado."))
    .catch((err) => mostrarMensajeEn("reembolsoMsg", "Error: " + err.message, true));
}

function renderReembolsos() {
  const tbody = document.querySelector("#tablaReembolsos tbody");
  const tabla = document.getElementById("tablaReembolsos");
  const vacio = document.getElementById("reembolsosVacio");
  const badge = document.getElementById("badgeReembolsos");
  if (!tbody || !tabla || !vacio) return;

  const data = reembolsosCache || {};
  let keys = Object.keys(data).filter((id) => data[id] && typeof data[id] === "object");

  const pendientes = keys.filter((id) => estadoNorm(data[id].estado) === "pendiente");
  if (badge) badge.textContent = String(pendientes.length);

  keys.sort((a, b) => ts(data[b].fecha || data[b].fechaSolicitud) - ts(data[a].fecha || data[a].fechaSolicitud));

  if (filtroReembolsos) {
    keys = keys.filter((id) => {
      const it = data[id];
      const texto = [id, it.clienteNombre, it.clienteId, it.productoNombre,
                     it.proveedorNombre, it.motivo, it.estado].join(" ");
      return coincideFiltro(texto, filtroReembolsos);
    });
  }

  if (!keys.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    renderDashboard();
    return;
  }

  tbody.innerHTML = keys.map((id) => {
    const it = data[id] || {};
    const estado = estadoNorm(it.estado);
    const monto = redondear(it.montoUsd ?? it.monto);
    const cliente = usuariosCache[it.clienteId || it.uidUsuario] || {};
    const resuelto = estado === "aprobado" || estado === "rechazado";

    const acciones = resuelto
      ? `<button class="nvaBtnMini soft" onclick="eliminarReembolso('${escaparParaJS(id)}')">Eliminar</button>`
      : `<button class="nvaBtnMini ok" onclick="aprobarReembolso('${escaparParaJS(id)}')">Aprobar</button>
         <button class="nvaBtnMini danger" onclick="rechazarReembolso('${escaparParaJS(id)}')">Rechazar</button>`;

    return `
      <tr>
        <td>${escaparHTML(formatearFecha(it.fecha || it.fechaSolicitud))}</td>
        <td>
          <div class="nvaEntity">
            <strong>${escaparHTML(textoSeguro(it.clienteNombre || nombreUsuario(cliente)))}</strong>
            <small>${escaparHTML(cliente.usuario ? "@" + cliente.usuario : (it.clienteId || "-"))}</small>
          </div>
        </td>
        <td>${escaparHTML(textoSeguro(it.productoNombre || it.productoId))}</td>
        <td>${escaparHTML(textoSeguro(it.proveedorNombre))}</td>
        <td>${celdaMoneda(monto)}</td>
        <td><small>${escaparHTML(textoSeguro(it.motivo, "Sin motivo"))}</small></td>
        <td>${nvaBadge(estado)}</td>
        <td><div class="nvaActions">${acciones}</div></td>
      </tr>`;
  }).join("");

  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");
  renderDashboard();
}

function cargarReembolsos() {
  db.ref("reembolsos").limitToLast(250).on("value", (snap) => {
    reembolsosCache = snap.val() || {};
    console.log("✅ reembolsos:", Object.keys(reembolsosCache).length);
    renderReembolsos();
  }, (err) => {
    reembolsosCache = {};
    renderReembolsos();
    avisarSinPermisos("reembolsos", err);
  });
}

/* =========================================================
   CATEGORÍAS
========================================================= */

function comprimirImagenCuadrada(file, lado = 320) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();

    lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
    lector.onload = (e) => {
      const img = new Image();

      img.onerror = () => reject(new Error("El archivo no es una imagen válida."));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = lado;
        canvas.height = lado;

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#0e0f14";
        ctx.fillRect(0, 0, lado, lado);

        const escala = Math.max(lado / img.width, lado / img.height);
        const w = img.width * escala;
        const h = img.height * escala;
        ctx.drawImage(img, (lado - w) / 2, (lado - h) / 2, w, h);

        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };

      img.src = e.target.result;
    };

    lector.readAsDataURL(file);
  });
}

function prepararUploadCategoria() {
  const zona = document.getElementById("categoriaDropZone");
  const input = document.getElementById("categoriaArchivo");
  const btn = document.getElementById("btnElegirImagen");
  if (!zona || !input || zona.dataset.listo) return;

  const abrir = (e) => { if (e) e.stopPropagation(); input.click(); };

  zona.addEventListener("click", abrir);
  if (btn) btn.addEventListener("click", abrir);

  input.addEventListener("change", (e) => manejarImagenCategoria(e.target.files[0]));

  ["dragenter", "dragover"].forEach((ev) => {
    zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("dragging"); });
  });
  ["dragleave", "drop"].forEach((ev) => {
    zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("dragging"); });
  });

  zona.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
    if (file) manejarImagenCategoria(file);
  });

  zona.dataset.listo = "1";
}

async function manejarImagenCategoria(file) {
  if (!file) return;

  if (!/^image\//.test(file.type)) {
    mostrarMensajeEn("categoriasMsg", "El archivo debe ser una imagen (PNG, JPG o WEBP).", true);
    return;
  }

  if (file.size > 6 * 1024 * 1024) {
    mostrarMensajeEn("categoriasMsg", "La imagen es muy grande (máximo 6 MB).", true);
    return;
  }

  try {
    categoriaImagenData = await comprimirImagenCuadrada(file, 320);
    categoriaImagenNombre = file.name;

    const preview = document.getElementById("categoriaAvatarPreview");
    if (preview) preview.innerHTML = `<img src="${categoriaImagenData}" alt="Vista previa">`;

    setTxt("categoriaNombreArchivo", file.name);
    mostrarMensajeEn("categoriasMsg", "Imagen lista. Ahora escribe el nombre y guarda.");
  } catch (err) {
    mostrarMensajeEn("categoriasMsg", "Error: " + err.message, true);
  }
}

function limpiarFormCategoria() {
  categoriaImagenData = "";
  categoriaImagenNombre = "";

  const preview = document.getElementById("categoriaAvatarPreview");
  if (preview) preview.innerHTML = "<span>Sin imagen</span>";

  setTxt("categoriaNombreArchivo", "Arrastra el logo o haz clic");

  const nombre = document.getElementById("categoriaNombre");
  if (nombre) nombre.value = "";

  const input = document.getElementById("categoriaArchivo");
  if (input) input.value = "";
}

async function agregarCategoria(event) {
  event.preventDefault();

  const nombreInput = document.getElementById("categoriaNombre");
  const btn = document.getElementById("btnGuardarCategoria");
  const nombre = (nombreInput.value || "").trim();

  if (!nombre) {
    mostrarMensajeEn("categoriasMsg", "Escribe el nombre de la plataforma.", true);
    return;
  }

  if (!categoriaImagenData) {
    mostrarMensajeEn("categoriasMsg", "Sube una imagen para la categoría.", true);
    return;
  }

  const yaExiste = Object.values(categoriasCache || {}).some(
    (c) => normalizarTexto(c.nombre) === normalizarTexto(nombre)
  );
  if (yaExiste) {
    mostrarMensajeEn("categoriasMsg", "Ya existe una categoría con ese nombre.", true);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = "Guardando..."; }

  try {
    const ref = db.ref("categorias").push();
    let urlFinal = categoriaImagenData;

    /* Intentamos Storage. Si las reglas lo bloquean, usamos el
       dataURL comprimido: pesa poco y el flujo nunca se rompe. */
    if (storage) {
      try {
        const sref = storage.ref("categorias/" + ref.key + ".jpg");
        await sref.putString(categoriaImagenData, "data_url");
        urlFinal = await sref.getDownloadURL();
      } catch (e) {
        console.warn("Storage no disponible, se guarda la imagen embebida:", e.message);
      }
    }

    await ref.set({
      nombre,
      nombreLower: normalizarTexto(nombre),
      imagen: urlFinal,
      fecha: Date.now(),
      creadoPor: auth.currentUser ? auth.currentUser.uid : ""
    });

    mostrarMensajeEn("categoriasMsg", "Categoría “" + nombre + "” agregada correctamente.");
    limpiarFormCategoria();
  } catch (err) {
    mostrarMensajeEn("categoriasMsg", "Error: " + err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Agregar categoría"; }
  }
}

function eliminarCategoria(id) {
  const cat = categoriasCache[id] || {};
  if (!confirm("¿Eliminar la categoría “" + (cat.nombre || id) + "”?\n\nLos productos ya publicados no se borran, pero esta plataforma dejará de ofrecerse a los proveedores.")) return;

  db.ref("categorias/" + id).remove()
    .then(() => {
      if (storage) storage.ref("categorias/" + id + ".jpg").delete().catch(() => {});
      mostrarMensajeEn("categoriasMsg", "Categoría eliminada.");
    })
    .catch((err) => mostrarMensajeEn("categoriasMsg", "Error: " + err.message, true));
}

function renderCategorias() {
  const grid = document.getElementById("categoriasGrid");
  const vacio = document.getElementById("categoriasVacio");
  if (!grid || !vacio) return;

  const data = categoriasCache || {};
  const keys = Object.keys(data).filter((id) => data[id] && typeof data[id] === "object");

  if (!keys.length) {
    grid.innerHTML = "";
    vacio.classList.remove("hidden");
    return;
  }

  vacio.classList.add("hidden");
  keys.sort((a, b) => normalizarTexto(data[a].nombre).localeCompare(normalizarTexto(data[b].nombre)));

  grid.innerHTML = keys.map((id) => {
    const it = data[id] || {};
    const imagen = String(it.imagen || "").trim();

    const usados = Object.values(productosCache || {}).filter(
      (p) => normalizarTexto(p.plataforma) === normalizarTexto(it.nombre)
    ).length;

    return `
      <div class="nvaCatCard">
        <button type="button" class="nvaCatCardDel" title="Eliminar" onclick="eliminarCategoria('${escaparParaJS(id)}')">✕</button>
        <div class="nvaCatCardAvatar">
          ${imagen
            ? `<img src="${escaparHTML(imagen)}" alt="${escaparHTML(it.nombre)}" onerror="this.parentElement.innerHTML='<span>🖼️</span>'">`
            : `<span>🖼️</span>`}
        </div>
        <div class="nvaCatCardName">${escaparHTML(textoSeguro(it.nombre, "Sin nombre"))}</div>
        <div class="nvaCatCardMeta">${usados} producto${usados === 1 ? "" : "s"}</div>
      </div>`;
  }).join("");
}

function cargarCategorias() {
  db.ref("categorias").on("value", (snap) => {
    categoriasCache = snap.val() || {};
    renderCategorias();
  }, (err) => {
    categoriasCache = {};
    renderCategorias();
    console.error("categorias:", err.message);
  });
}

/* =========================================================
   CATÁLOGO Y STOCK (solo moderación)
========================================================= */

function toggleProductoActivo(productoId, estadoActual) {
  db.ref("productos/" + productoId + "/activo").set(!estadoActual)
    .then(() => mostrarMensajeEn("stockMsg", (estadoActual ? "Producto desactivado." : "Producto activado.")))
    .catch((err) => mostrarMensajeEn("stockMsg", "Error: " + err.message, true));
}

function eliminarProductoModeracion(productoId) {
  const p = productosCache[productoId] || {};

  if (!confirm(
    "MODERACIÓN · Eliminar producto\n\n" +
    "“" + (p.nombre || productoId) + "”\n" +
    "Proveedor: " + (p.proveedorNombre || "-") + "\n\n" +
    "Se eliminará el producto y sus cuentas DISPONIBLES.\n" +
    "Las ventas ya realizadas se conservan en el historial.\n\n¿Continuar?"
  )) return;

  const updates = {};
  updates["productos/" + productoId] = null;
  updates["stock/" + productoId] = null;

  const cuentas = cuentasCache[productoId] || {};
  Object.keys(cuentas).forEach((cid) => {
    if (estadoNorm(cuentas[cid].estado, "disponible") === "disponible") {
      updates["cuentas/" + productoId + "/" + cid] = null;
    }
  });

  db.ref().update(updates)
    .then(() => mostrarMensajeEn("stockMsg", "Producto eliminado por moderación."))
    .catch((err) => mostrarMensajeEn("stockMsg", "Error: " + err.message, true));
}

function recalcularTodoElStock() {
  if (!Object.keys(cuentasCache).length) {
    mostrarMensajeEn("stockMsg", "Todavía se están cargando las cuentas. Intenta en unos segundos.", true);
    return;
  }

  const updates = {};
  let cambios = 0;

  Object.keys(productosCache || {}).forEach((id) => {
    const p = productosCache[id] || {};
    if (p.stockIlimitado === true || p.tipoEntrega === "descarga") return;

    const real = stockRealDeCuentas(id);
    const actual = num(stockCache[id] ?? p.stock);

    if (real !== actual) {
      updates["stock/" + id] = real;
      updates["productos/" + id + "/stock"] = real;
      cambios++;
    }
  });

  if (!cambios) {
    mostrarMensajeEn("stockMsg", "Todo el stock ya estaba sincronizado. No hubo cambios.");
    return;
  }

  db.ref().update(updates)
    .then(() => mostrarMensajeEn("stockMsg", "Stock recalculado: " + cambios + " producto(s) corregido(s)."))
    .catch((err) => mostrarMensajeEn("stockMsg", "Error: " + err.message, true));
}

function renderStock() {
  const tbody = document.querySelector("#tablaStock tbody");
  const tabla = document.getElementById("tablaStock");
  const vacio = document.getElementById("stockVacio");
  if (!tbody || !tabla || !vacio) return;

  let ids = Object.keys(productosCache || {});

  let unidades = 0, activos = 0, ilimitados = 0, agotados = 0;

  ids.forEach((id) => {
    const p = productosCache[id] || {};
    const esIlim = p.stockIlimitado === true || p.tipoEntrega === "descarga";
    const valor = esIlim ? 0 : num(stockCache[id] ?? p.stock);
    const activo = p.activo !== false;

    if (esIlim) ilimitados++;
    else unidades += valor;

    if (activo) activos++;
    if (!activo || (!esIlim && valor <= 0)) agotados++;
  });

  setTxt("totalStockStockTab", String(unidades));
  setTxt("stockStatActivos", String(activos));
  setTxt("stockStatIlimitados", String(ilimitados));
  setTxt("stockStatAgotados", String(agotados));

  if (filtroStock) {
    ids = ids.filter((id) => {
      const p = productosCache[id] || {};
      const texto = [id, p.nombre, p.plataforma, p.categoria, p.proveedorNombre, p.proveedorId].join(" ");
      return coincideFiltro(texto, filtroStock);
    });
  }

  if (!ids.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    renderDashboard();
    return;
  }

  ids.sort((a, b) => normalizarTexto(productosCache[a].nombre).localeCompare(normalizarTexto(productosCache[b].nombre)));

  tbody.innerHTML = ids.map((id) => {
    const p = productosCache[id] || {};
    const esIlim = p.stockIlimitado === true || p.tipoEntrega === "descarga";
    const valor = esIlim ? "Ilimitado" : num(stockCache[id] ?? p.stock);
    const activo = p.activo !== false;
    const real = esIlim ? null : stockRealDeCuentas(id);

    let estado = "agotado";
    if (!activo) estado = "desactivado";
    else if (esIlim || num(valor) > 0) estado = "activo";

    const desfase = (!esIlim && real !== null && real !== num(valor))
      ? `<br><small style="color:#f7c463">⚠ cuentas reales: ${real}</small>`
      : "";

    return `
      <tr>
        <td>
          <div class="nvaEntity">
            <strong>${escaparHTML(textoSeguro(p.nombre, id))}</strong>
            <small>${escaparHTML(id)}</small>
          </div>
        </td>
        <td>${escaparHTML(textoSeguro(p.plataforma || p.categoria))}</td>
        <td>${escaparHTML(textoSeguro(p.proveedorNombre))}</td>
        <td>${celdaMoneda(p.precioUsd)}</td>
        <td>${esIlim ? '<span class="nvaBadge teal">Ilimitado</span>' : `<strong style="font-family:var(--font-mono)">${valor}</strong>${desfase}`}</td>
        <td>${nvaBadge(estado)}</td>
        <td>
          <div class="nvaActions">
            <button class="nvaBtnMini ${activo ? "danger" : "ok"}" onclick="toggleProductoActivo('${escaparParaJS(id)}', ${activo})">
              ${activo ? "Desactivar" : "Activar"}
            </button>
            <button class="nvaBtnMini soft" onclick="eliminarProductoModeracion('${escaparParaJS(id)}')">Eliminar</button>
          </div>
        </td>
      </tr>`;
  }).join("");

  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");
  renderDashboard();
}

function cargarProductos() {
  db.ref("productos").on("value", (snap) => {
    productosCache = snap.val() || {};
    console.log("✅ productos:", Object.keys(productosCache).length);
    sincronizarCuentas();
    renderStock();
    renderCategorias();
    renderVentas();
    renderVentasHoy();
    renderProveedores();
  }, (err) => {
    productosCache = {};
    renderStock();
    avisarSinPermisos("productos", err);
  });
}

function cargarStock() {
  db.ref("stock").on("value", (snap) => {
    stockCache = snap.val() || {};
    renderStock();
  }, (err) => { stockCache = {}; renderStock(); console.error("stock:", err.message); });
}

/* Cuentas: un listener por producto.
   Antes se leía /cuentas completo, lo que es pesado y trae de
   golpe credenciales que no se necesitan todas a la vez. */
function sincronizarCuentas() {
  const ids = Object.keys(productosCache);

  ids.forEach((pid) => {
    if (cuentasRefs[pid]) return;
    const ref = db.ref("cuentas/" + pid);
    cuentasRefs[pid] = ref;
    ref.on("value", (s) => { cuentasCache[pid] = s.val() || {}; renderStock(); },
           () => { cuentasCache[pid] = {}; });
  });

  Object.keys(cuentasRefs).forEach((pid) => {
    if (ids.includes(pid)) return;
    try { cuentasRefs[pid].off(); } catch (e) {}
    delete cuentasRefs[pid];
    delete cuentasCache[pid];
  });
}

/* Compatibilidad con el botón del HTML */
function cargarCuentas() { sincronizarCuentas(); }

/* =========================================================
   VENTAS
========================================================= */

function nombreProveedorVenta(v = {}) {
  if (v.proveedorNombre) return v.proveedorNombre;
  const pid = String(v.proveedorId || "").trim();
  if (pid && usuariosCache[pid]) return nombreUsuario(usuariosCache[pid]);
  return "NovaStream";
}

function nombreClienteVenta(v = {}) {
  if (v.clienteNombre) return v.clienteNombre;
  const cid = String(v.clienteId || v.uidUsuario || "").trim();
  if (cid && usuariosCache[cid]) return nombreUsuario(usuariosCache[cid]);
  return "-";
}

function eliminarVenta(id) {
  if (!confirm("¿Eliminar esta venta del historial?\n\nOJO: no revierte el saldo del proveedor ni el stock.")) return;
  db.ref("ventas/" + id).remove()
    .then(() => mostrarToast("Venta eliminada del historial."))
    .catch((err) => mostrarToast("Error: " + err.message, true));
}

function filaVenta(id, v, conAcciones = true, soloHora = false) {
  const monto = montoVenta(v);

  return `
    <tr>
      <td>${escaparHTML(soloHora ? formatearHora(v.fecha) : formatearFecha(v.fecha))}</td>
      <td>
        <div class="nvaEntity">
          <strong>${escaparHTML(textoSeguro(v.productoNombre || v.producto || v.productoId))}</strong>
          <small>${escaparHTML(textoSeguro(v.plataforma, ""))}</small>
        </div>
      </td>
      <td>${escaparHTML(textoSeguro(nombreClienteVenta(v)))}</td>
      <td>${escaparHTML(textoSeguro(nombreProveedorVenta(v)))}</td>
      <td>${celdaMoneda(monto)}</td>
      <td>${celdaMoneda(comisionDe(monto), "pos")}</td>
      <td>${nvaBadge(v.estado || "entregada")}</td>
      ${conAcciones ? `<td><button class="nvaBtnMini soft" onclick="eliminarVenta('${escaparParaJS(id)}')">Eliminar</button></td>` : ""}
    </tr>`;
}

function renderVentas() {
  const tbody = document.querySelector("#tablaVentas tbody");
  const tabla = document.getElementById("tablaVentas");
  const vacio = document.getElementById("ventasVacio");
  if (!tbody || !tabla || !vacio) return;

  let lista = Object.keys(ventasCache || {}).map((id) => ({ id, v: ventasCache[id] || {} }));

  if (filtroVentas) {
    lista = lista.filter(({ id, v }) => {
      const texto = [id, v.productoNombre, v.productoId, v.plataforma,
                     nombreClienteVenta(v), nombreProveedorVenta(v), v.estado].join(" ");
      return coincideFiltro(texto, filtroVentas);
    });
  }

  lista.sort((a, b) => ts(b.v.fecha) - ts(a.v.fecha));

  if (!lista.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    renderDashboard();
    return;
  }

  tbody.innerHTML = lista.map(({ id, v }) => filaVenta(id, v, true, false)).join("");
  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");
  renderDashboard();
}

function renderVentasHoy() {
  const tbody = document.querySelector("#tablaVentasHoy tbody");
  const tabla = document.getElementById("tablaVentasHoy");
  const vacio = document.getElementById("ventasHoyVacio");
  if (!tbody || !tabla || !vacio) return;

  let lista = Object.keys(ventasCache || {})
    .map((id) => ({ id, v: ventasCache[id] || {} }))
    .filter(({ v }) => esHoy(v.fecha));

  let volumen = 0;
  lista.forEach(({ v }) => { volumen += montoVenta(v); });

  setTxt("ventasHoyCount", String(lista.length));
  setMoneda("ventasHoyVolumen", "ventasHoyVolumenPen", volumen);
  setMoneda("ventasHoyComision", "ventasHoyComisionPen", comisionDe(volumen));

  if (filtroVentasHoy) {
    lista = lista.filter(({ id, v }) => {
      const texto = [id, v.productoNombre, nombreClienteVenta(v), nombreProveedorVenta(v)].join(" ");
      return coincideFiltro(texto, filtroVentasHoy);
    });
  }

  lista.sort((a, b) => ts(b.v.fecha) - ts(a.v.fecha));

  if (!lista.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    return;
  }

  tbody.innerHTML = lista.map(({ id, v }) => filaVenta(id, v, false, true)).join("");
  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");
}

function cargarVentas() {
  db.ref("ventas").limitToLast(500).on("value", (snap) => {
    ventasCache = snap.val() || {};
    console.log("✅ ventas:", Object.keys(ventasCache).length);
    renderVentas();
    renderVentasHoy();
    renderUsuarios();
    renderProveedores();
  }, (err) => {
    ventasCache = {};
    renderVentas();
    renderVentasHoy();
    avisarSinPermisos("ventas", err);
  });
}

/* =========================================================
   CLIENTES
========================================================= */

function guardarSaldoUsuario(uid) {
  const input = document.getElementById("saldoUser_" + safeDomKey(uid));
  if (!input) return;

  permitirSoloNumerosDecimales(input);
  const valor = String(input.value || "").trim();

  if (valor === "" || isNaN(Number(valor)) || Number(valor) < 0) {
    mostrarToast("El saldo no es válido.", true);
    return;
  }

  const nuevo = redondear(valor);

  db.ref("usuarios/" + uid).get()
    .then((snap) => {
      const u = snap.val();
      if (!u) throw new Error("El usuario no existe.");

      const anterior = saldoDe(u);
      const diferencia = redondear(nuevo - anterior);

      if (Math.abs(diferencia) < 0.005) throw new Error("SIN_CAMBIOS");

      if (!confirm(
        "AJUSTE MANUAL DE SALDO\n\n" +
        "Usuario: " + nombreUsuario(u) + "\n" +
        "Saldo actual: " + fmtUsd(anterior) + "\n" +
        "Nuevo saldo:  " + fmtUsd(nuevo) + "\n" +
        "───────────────────────\n" +
        (diferencia > 0 ? "➜ SE SUMAN " : "➜ SE RESTAN ") + fmtUsd(Math.abs(diferencia)) + "\n\n" +
        "Este movimiento queda registrado en el historial del usuario. ¿Continuar?"
      )) throw new Error("CANCELADO");

      const ahora = Date.now();
      const movKey = db.ref("movimientosSaldo/" + uid).push().key;

      const updates = {};
      updates["usuarios/" + uid + "/saldoUsd"] = nuevo;
      updates["movimientosSaldo/" + uid + "/" + movKey] = {
        tipo: "ajuste",
        detalle: "Ajuste manual del administrador",
        montoUsd: redondear(Math.abs(diferencia)),
        signo: diferencia > 0 ? "+" : "-",
        fecha: ahora,
        adminUid: auth.currentUser ? auth.currentUser.uid : ""
      };

      return db.ref().update(updates);
    })
    .then(() => mostrarToast("Saldo actualizado a " + fmtUsd(nuevo) + "."))
    .catch((err) => {
      if (err.message === "CANCELADO") return;
      if (err.message === "SIN_CAMBIOS") { mostrarToast("El saldo ya tenía ese valor."); return; }
      mostrarToast("No se pudo actualizar el saldo: " + err.message, true);
    });
}

function toggleUsuarioEstado(uid, nuevoEstado) {
  const u = usuariosCache[uid] || {};
  const bloquear = nuevoEstado === "bloqueado";

  if (bloquear && !confirm(
    "¿Bloquear a " + nombreUsuario(u) + "?\n\n" +
    "Su sesión se cerrará automáticamente y no podrá comprar ni ingresar " +
    "hasta que lo desbloquees. Su saldo se conserva intacto."
  )) return;

  db.ref("usuarios/" + uid + "/estado").set(nuevoEstado)
    .then(() => mostrarToast(bloquear ? "Usuario bloqueado." : "Usuario reactivado."))
    .catch((err) => mostrarToast("No se pudo cambiar el estado: " + err.message, true));
}

function toggleRolProveedor(uid, esProveedorActual) {
  const u = usuariosCache[uid] || {};
  const nuevoRol = esProveedorActual ? "cliente" : "proveedor";

  const suyos = Object.values(productosCache || {}).filter((p) => p.proveedorId === uid).length;

  let aviso;
  if (esProveedorActual) {
    aviso = "¿Quitar el rol de proveedor a " + nombreUsuario(u) + "?\n\n" +
            "Perderá acceso a su panel de proveedor." +
            (suyos ? "\n\n⚠ Tiene " + suyos + " producto(s) publicado(s). Considera desactivarlos antes." : "");
  } else {
    aviso = "¿Convertir a " + nombreUsuario(u) + " en proveedor?\n\n" +
            "Podrá ingresar al panel de proveedores, publicar productos, " +
            "cargar stock y solicitar retiros (comisión " + Math.round(NVA_COMISION_RETIRO * 100) + "%).";
  }

  if (!confirm(aviso)) return;

  const updates = {};
  updates["usuarios/" + uid + "/rol"] = nuevoRol;

  /* Al ascender creamos su ficha pública para que el catálogo
     ya pueda mostrar su nombre y su WhatsApp de soporte. */
  if (nuevoRol === "proveedor") {
    updates["proveedoresPublicos/" + uid + "/nombre"] = nombreUsuario(u);
    updates["proveedoresPublicos/" + uid + "/correo"] = u.correo || "";
    updates["proveedoresPublicos/" + uid + "/soporteActivo"] = true;
    updates["proveedoresPublicos/" + uid + "/actualizado"] = Date.now();
  }

  db.ref().update(updates)
    .then(() => mostrarToast(nuevoRol === "proveedor"
      ? "✅ Ahora es proveedor. Ya puede entrar a su panel."
      : "Rol de proveedor retirado."))
    .catch((err) => mostrarToast("No se pudo actualizar el rol: " + err.message, true));
}

function statsCliente(uid) {
  let compras = 0, gastado = 0;

  Object.values(ventasCache || {}).forEach((v) => {
    const cid = String(v.clienteId || v.uidUsuario || "");
    if (cid !== uid) return;
    compras++;
    gastado += montoVenta(v);
  });

  return { compras, gastado: redondear(gastado) };
}

function renderUsuarios() {
  const tbody = document.querySelector("#tablaUsuarios tbody");
  const tabla = document.getElementById("tablaUsuarios");
  const vacio = document.getElementById("usuariosVacio");
  if (!tbody || !tabla || !vacio) return;

  const data = usuariosCache || {};

  let lista = Object.keys(data)
    .map((id) => ({ id, u: data[id] || {} }))
    .filter(({ u }) => !esProveedor(u) && !esAdminUser(u));

  if (filtroUsuarios) {
    lista = lista.filter(({ id, u }) => {
      const texto = [id, nombreUsuario(u), u.usuario, u.correo, u.estado].join(" ");
      return coincideFiltro(texto, filtroUsuarios);
    });
  }

  lista.sort((a, b) => ts(b.u.fechaRegistro) - ts(a.u.fechaRegistro));

  if (!lista.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    renderDashboard();
    return;
  }

  tbody.innerHTML = lista.map(({ id, u }) => {
    const estado = String(u.estado || "activo").toLowerCase();
    const bloqueado = estado === "bloqueado";
    const key = safeDomKey(id);
    const saldo = saldoDe(u);
    const st = statsCliente(id);

    return `
      <tr>
        <td>
          <div class="nvaEntity">
            <strong>${escaparHTML(textoSeguro(nombreUsuario(u)))}</strong>
            <small>${escaparHTML(u.usuario ? "@" + u.usuario : id)}</small>
          </div>
        </td>
        <td><small>${escaparHTML(textoSeguro(u.correo))}</small></td>
        <td>
          <div class="nvaSaldoEdit">
            <input id="saldoUser_${key}" type="text" inputmode="decimal" autocomplete="off" value="${saldo.toFixed(2)}">
            <button class="nvaBtnMini ok" onclick="guardarSaldoUsuario('${escaparParaJS(id)}')">Guardar</button>
          </div>
          <span class="nvaSaldoEditPen">≈ ${fmtPen(saldo)}</span>
        </td>
        <td>
          <div class="nvaEntity">
            <strong>${st.compras}</strong>
            <small>${fmtUsd(st.gastado)} gastado</small>
          </div>
        </td>
        <td><small>${escaparHTML(formatearFecha(u.fechaRegistro))}</small></td>
        <td>${nvaBadge(estado)}</td>
        <td>
          <div class="nvaActions">
            <button class="nvaBtnMini ${bloqueado ? "ok" : "danger"}"
              onclick="toggleUsuarioEstado('${escaparParaJS(id)}', '${bloqueado ? "activo" : "bloqueado"}')">
              ${bloqueado ? "Reactivar" : "Bloquear"}
            </button>
            <button class="nvaBtnMini soft" onclick="toggleRolProveedor('${escaparParaJS(id)}', false)">Hacer proveedor</button>
            <button class="nvaBtnMini soft" onclick="hacerAdmin('${escaparParaJS(id)}')" title="Acceso total al panel">👑 Admin</button>
          </div>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll('input[id^="saldoUser_"]').forEach(prepararInputNumerico);

  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");

  renderProveedores();
  renderAdmins();
  renderDashboard();
}

function cargarUsuarios() {
  db.ref("usuarios").on("value", (snap) => {
    usuariosCache = snap.val() || {};
    console.log("✅ usuarios:", Object.keys(usuariosCache).length);
    renderUsuarios();
    renderProveedores();
    renderAdmins();
    renderVentas();
    renderVentasHoy();
    renderRecargas();
    renderRetiros();
  }, (err) => {
    usuariosCache = {};
    renderUsuarios();
    avisarSinPermisos("usuarios", err);
  });
}

/* =========================================================
   PROVEEDORES
========================================================= */

function statsProveedor(uid) {
  let productos = 0, activos = 0;
  let ventas = 0, generado = 0;

  Object.values(productosCache || {}).forEach((p) => {
    if (p.proveedorId !== uid) return;
    productos++;
    if (p.activo !== false) activos++;
  });

  Object.values(ventasCache || {}).forEach((v) => {
    if (v.proveedorId !== uid) return;
    ventas++;
    generado += montoVenta(v);
  });

  let retirado = 0;
  Object.values(retirosCache || {}).forEach((r) => {
    if (r.proveedorId !== uid) return;
    if (estadoNorm(r.estado) !== "aprobado") return;
    retirado += num(r.montoUsd ?? r.monto);
  });

  return { productos, activos, ventas, generado: redondear(generado), retirado: redondear(retirado) };
}

function renderProveedores() {
  const tbody = document.querySelector("#tablaProveedores tbody");
  const tabla = document.getElementById("tablaProveedores");
  const vacio = document.getElementById("proveedoresVacio");
  if (!tbody || !tabla || !vacio) return;

  const data = usuariosCache || {};

  let lista = Object.keys(data)
    .map((id) => ({ id, u: data[id] || {} }))
    .filter(({ u }) => esProveedor(u));

  if (filtroProveedores) {
    lista = lista.filter(({ id, u }) => {
      const pub = proveedoresPublicosCache[id] || {};
      const texto = [id, nombreUsuario(u), u.usuario, u.correo, u.estado, pub.whatsappSoporte].join(" ");
      return coincideFiltro(texto, filtroProveedores);
    });
  }

  lista.sort((a, b) => saldoDe(b.u) - saldoDe(a.u));

  if (!lista.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    return;
  }

  tbody.innerHTML = lista.map(({ id, u }) => {
    const estado = String(u.estado || "activo").toLowerCase();
    const bloqueado = estado === "bloqueado";
    const saldo = saldoDe(u);
    const st = statsProveedor(id);
    const pub = proveedoresPublicosCache[id] || {};

    const wsp = String(pub.whatsappSoporte || "").replace(/\D/g, "");
    const wspHtml = wsp
      ? `<a class="nvaCompLink" href="https://wa.me/${wsp}" target="_blank" rel="noopener">+${escaparHTML(wsp)}</a>
         ${pub.soporteActivo === false ? '<br><span class="nvaBadge off">soporte off</span>' : ""}`
      : `<span class="nvaCompLink disabled">Sin número</span>`;

    return `
      <tr>
        <td>
          <div class="nvaEntity">
            <strong>${escaparHTML(textoSeguro(nombreUsuario(u)))}</strong>
            <small>${escaparHTML(u.usuario ? "@" + u.usuario : id)}</small>
          </div>
        </td>
        <td><small>${escaparHTML(textoSeguro(u.correo))}</small></td>
        <td>${celdaMoneda(saldo, saldo > 0 ? "key" : "")}</td>
        <td>
          <div class="nvaEntity">
            <strong>${st.productos}</strong>
            <small>${st.activos} activo${st.activos === 1 ? "" : "s"}</small>
          </div>
        </td>
        <td>
          <div class="nvaEntity">
            <strong>${st.ventas}</strong>
            <small>${fmtUsd(st.generado)} generado</small>
          </div>
        </td>
        <td>${wspHtml}</td>
        <td>${nvaBadge(estado)}</td>
        <td>
          <div class="nvaActions">
            <button class="nvaBtnMini ${bloqueado ? "ok" : "danger"}"
              onclick="toggleUsuarioEstado('${escaparParaJS(id)}', '${bloqueado ? "activo" : "bloqueado"}')">
              ${bloqueado ? "Reactivar" : "Bloquear"}
            </button>
            <button class="nvaBtnMini soft" onclick="toggleRolProveedor('${escaparParaJS(id)}', true)">Quitar rol</button>
          </div>
        </td>
      </tr>`;
  }).join("");

  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");
}

function cargarProveedoresPublicos() {
  db.ref("proveedoresPublicos").on("value", (snap) => {
    proveedoresPublicosCache = snap.val() || {};
    renderProveedores();
  }, () => { proveedoresPublicosCache = {}; });
}

/* =========================================================
   ADMINISTRADORES
   Como ya eres admin, las reglas te permiten cambiar el rol
   de otros usuarios. Así creas admins sin tocar la consola.
========================================================= */

function hacerAdmin(uid) {
  const u = usuariosCache[uid] || {};

  if (!confirm(
    "⚠️ CONVERTIR EN ADMINISTRADOR\n\n" +
    "Usuario: " + nombreUsuario(u) + "\n" +
    "Correo: " + (u.correo || "-") + "\n\n" +
    "Tendrá acceso TOTAL: podrá aprobar recargas y retiros, ajustar\n" +
    "saldos, eliminar productos y crear otros administradores.\n\n" +
    "Solo hazlo con alguien de absoluta confianza.\n\n¿Continuar?"
  )) return;

  db.ref("usuarios/" + uid + "/rol").set("admin")
    .then(() => mostrarToast("✅ " + nombreUsuario(u) + " ahora es administrador."))
    .catch((e) => mostrarToast("No se pudo cambiar el rol: " + e.message, true));
}

function quitarAdmin(uid) {
  const yo = auth.currentUser ? auth.currentUser.uid : "";

  if (uid === yo) {
    mostrarToast("No puedes quitarte tu propio rol de admin.", true);
    return;
  }

  const u = usuariosCache[uid] || {};
  if (!confirm("¿Quitar el rol de administrador a " + nombreUsuario(u) + "?\n\nVolverá a ser cliente.")) return;

  db.ref("usuarios/" + uid + "/rol").set("cliente")
    .then(() => mostrarToast("Rol de administrador retirado."))
    .catch((e) => mostrarToast("Error: " + e.message, true));
}

function renderAdmins() {
  const tbody = document.querySelector("#tablaAdmins tbody");
  const tabla = document.getElementById("tablaAdmins");
  const vacio = document.getElementById("adminsVacio");
  if (!tbody || !tabla || !vacio) return;

  const yo = auth.currentUser ? auth.currentUser.uid : "";
  const lista = Object.keys(usuariosCache)
    .map((id) => ({ id, u: usuariosCache[id] || {} }))
    .filter(({ u }) => esAdminUser(u));

  setTxt("adminsTotal", String(lista.length));

  if (!lista.length) {
    tbody.innerHTML = "";
    tabla.classList.add("hidden");
    vacio.classList.remove("hidden");
    return;
  }

  tbody.innerHTML = lista.map(({ id, u }) => {
    const esYo = id === yo;
    return `
      <tr>
        <td>
          <div class="nvaEntity">
            <strong>${escaparHTML(nombreUsuario(u))}${esYo ? " (tú)" : ""}</strong>
            <small>${escaparHTML(id)}</small>
          </div>
        </td>
        <td><small>${escaparHTML(textoSeguro(u.correo))}</small></td>
        <td><small>${escaparHTML(formatearFecha(u.fechaRegistro))}</small></td>
        <td>${nvaBadge(String(u.estado || "activo").toLowerCase())}</td>
        <td>
          ${esYo
            ? '<span class="nvaBadge teal">Sesión actual</span>'
            : `<button class="nvaBtnMini danger" onclick="quitarAdmin('${escaparParaJS(id)}')">Quitar admin</button>`}
        </td>
      </tr>`;
  }).join("");

  tabla.classList.remove("hidden");
  vacio.classList.add("hidden");
}

/* =========================================================
   VACIAR NODOS
========================================================= */

function vaciarNodoConfirmado(path, aviso) {
  if (!path) return;

  if (!confirm(
    aviso + "\n\n" +
    "⚠ Esta acción NO se puede deshacer y no revierte saldos ni stock.\n" +
    "Solo borra el historial de esta tabla.\n\n¿Continuar?"
  )) return;

  db.ref(path).remove()
    .then(() => {
      if (path === "recargas") {
        recargasCache = {};
        recargasPendientesPrev = {};
        recargasInicializadas = false;
        renderRecargas();
        mostrarMensajeEn("recargaMsg", "Historial de recargas eliminado.");
      } else if (path === "reembolsos") {
        reembolsosCache = {};
        renderReembolsos();
        mostrarMensajeEn("reembolsoMsg", "Historial de reembolsos eliminado.");
      } else if (path === "retirosProveedores") {
        retirosCache = {};
        retirosPendientesPrev = {};
        retirosInicializados = false;
        renderRetiros();
        mostrarToast("Historial de retiros eliminado. (Las comisiones cobradas se conservan.)");
      } else if (path === "ventas") {
        ventasCache = {};
        renderVentas();
        renderVentasHoy();
        mostrarToast("Historial de ventas eliminado.");
      } else {
        mostrarToast("Nodo vaciado correctamente.");
      }

      renderDashboard();
    })
    .catch((error) => {
      if (path === "recargas") mostrarMensajeEn("recargaMsg", "Error: " + error.message, true);
      else if (path === "reembolsos") mostrarMensajeEn("reembolsoMsg", "Error: " + error.message, true);
      else mostrarToast("Error: " + error.message, true);
    });
}

/* =========================================================
   ATAJOS
========================================================= */

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cerrarSidebar();
});

/* =========================================================
   ARRANQUE
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
  pintarConstantes();
  actualizarBotonTiempoActivo();

  const hash = (window.location.hash || "").replace("#", "");
  if (hash && document.getElementById(hash)) {
    setTimeout(() => irASeccion(hash), 300);
  }
});
