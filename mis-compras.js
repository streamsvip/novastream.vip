/* =========================================================
   NOVASTREAM.VIP — mis-compras.js (v3)
   ✅ CONECTADO A FIREBASE · compatible con las reglas RTDB v5

   ─────────────────────────────────────────────────────────
   DE DÓNDE SALEN LOS DATOS
   ─────────────────────────────────────────────────────────
   compras/{uid}/{compraId} = {
     totalUsd, fecha, estado,
     items: [ { productoId, productoNombre, plataforma, proveedor,
                proveedorId, imagen, cantidad, precioUnitarioUsd,
                duracionDias, reglas, aplicaReembolso,
                accesos: [ { cuentaId, correo, clave, perfil, pin } ] } ]
   }

   Cada ACCESO se muestra como una fila independiente, porque cada
   cuenta entregada tiene su propia vigencia y su propio ciclo de
   renovación / reembolso.

   ─────────────────────────────────────────────────────────
   CÓMO SE CALCULA LA VIGENCIA
   ─────────────────────────────────────────────────────────
   El cliente NO puede leer /cuentas (solo las disponibles), así
   que la fecha de vencimiento se deduce de datos que sí puede ver:

     vence = compra.fecha
           + duracionDias
           + (suma de duracionDias de las renovaciones ACEPTADAS
              de ese mismo cuentaId)

   ─────────────────────────────────────────────────────────
   RENOVACIÓN — cómo funciona y por qué
   ─────────────────────────────────────────────────────────
   Las reglas NO permiten que el proveedor mueva el saldo del
   cliente. Por eso el cobro ocurre en el momento de solicitar:
     · Se descuenta el saldo del cliente
     · Se acredita al proveedor
     · Se crea renovaciones/{id} en estado "pendiente"
   El proveedor la acepta desde su panel. Si la cancela, el
   administrador devuelve el saldo desde su panel (queda visible
   en la lista de renovaciones canceladas).

   ─────────────────────────────────────────────────────────
   REEMBOLSO
   ─────────────────────────────────────────────────────────
   Solo se CREA la solicitud en estado "pendiente". El dinero lo
   devuelve el administrador tras revisarla. El cliente nunca
   puede aprobar su propio reembolso.
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

const MC_LOGIN_URL = "login.html";
const MC_ADMIN_URL = "novaadmin.html";

const MC_TIPO_CAMBIO   = 3.40;
const MC_DIAS_RENOVAR  = 3;                        // se puede renovar con <= 3 días
const MC_MS_DIA        = 24 * 60 * 60 * 1000;
const MC_LIMITE_REEMB  = 24 * 60 * 60 * 1000;      // reembolso dentro de 24 h
const MC_WSP_FALLBACK  = "51900000000";

/* =========================
   ESTADO
========================= */

let mcAuth = null, mcDb = null;
let mcUid = null;
let mcPerfil = { nombre: "Cliente", correo: "", saldoUsd: 0 };

let mcComprasRaw   = {};   // compras/{uid}
let mcRenovaciones = {};   // renovaciones del cliente
let mcReembolsos   = {};   // reembolsos del cliente
let mcProveedores  = {};   // proveedoresPublicos (para el WhatsApp)

let mcFilas = [];          // lista plana de accesos

let filtroTexto = "";
let filtroEstado = "todos";
let filtroPlataforma = "todos";

let mcFilaModal = null;
let mcAccionPendiente = null;   // { tipo:'renovar'|'reembolso', fila }

/* =========================
   HELPERS
========================= */

function mcEl(id){ return document.getElementById(id); }
function num(v){ return Number(v || 0); }
function red(v){ return Number(num(v).toFixed(2)); }
function fmt(v){ return "$" + num(v).toFixed(2); }
function fmtPEN(v){ return "S/ " + (num(v) * MC_TIPO_CAMBIO).toFixed(2); }

function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function norm(v){
  return String(v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
}

function fechaCorta(ts){
  if (!ts) return "-";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("es-PE", { day:"2-digit", month:"short", year:"numeric" });
}

function toast(msg){
  const el = mcEl("toastAviso");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("visible"), 2800);
}

/* =========================================================
   FIREBASE + GUARDIA DE SESIÓN
========================================================= */

function mcInit(){
  if (typeof firebase === "undefined"){
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#fff;font-family:sans-serif">No se pudo cargar el sistema. Revisa tu conexión.</div>';
    return;
  }

  if (!firebase.apps.length) firebase.initializeApp(MC_FB_CONFIG);
  mcAuth = firebase.auth();
  mcDb   = firebase.database();

  /* Proveedores públicos: lectura pública (para el botón de soporte) */
  mcDb.ref("proveedoresPublicos").on("value", s => { mcProveedores = s.val() || {}; });

  mcAuth.onAuthStateChanged(async (user) => {
    if (!user){ window.location.replace(MC_LOGIN_URL); return; }

    let d = {};
    try {
      const snap = await mcDb.ref("usuarios/" + user.uid).get();
      d = snap.val() || {};
    } catch(e){ toast("No pudimos verificar tu cuenta."); return; }

    if (String(d.estado || "activo").toLowerCase() === "bloqueado"){
      await mcAuth.signOut();
      window.location.replace(MC_LOGIN_URL);
      return;
    }

    if (String(d.rol || "cliente").toLowerCase() === "admin"){
      window.location.replace(MC_ADMIN_URL);
      return;
    }

    mcUid = user.uid;

    /* Perfil en vivo */
    mcDb.ref("usuarios/" + mcUid).on("value", s => {
      const p = s.val() || {};
      if (String(p.estado || "activo").toLowerCase() === "bloqueado"){
        mcAuth.signOut().finally(() => window.location.replace(MC_LOGIN_URL));
        return;
      }
      mcPerfil = {
        nombre: p.nombre || user.email || "Cliente",
        correo: p.correo || user.email || "",
        saldoUsd: num(p.saldoUsd)
      };
      pintarPerfil();
    });

    /* Compras: lectura directa permitida */
    mcDb.ref("compras/" + mcUid).on("value", s => {
      mcComprasRaw = s.val() || {};
      reconstruirFilas();
      const boot = mcEl("rgBooting");
      if (boot) boot.classList.add("off");
    }, err => {
      console.error(err);
      mcComprasRaw = {};
      reconstruirFilas();
      const boot = mcEl("rgBooting");
      if (boot) boot.classList.add("off");
    });

    /* Renovaciones propias · query OBLIGATORIA */
    mcDb.ref("renovaciones").orderByChild("clienteId").equalTo(mcUid)
      .on("value", s => { mcRenovaciones = s.val() || {}; reconstruirFilas(); },
          () => { mcRenovaciones = {}; });

    /* Reembolsos propios · query OBLIGATORIA */
    mcDb.ref("reembolsos").orderByChild("clienteId").equalTo(mcUid)
      .on("value", s => { mcReembolsos = s.val() || {}; reconstruirFilas(); },
          () => { mcReembolsos = {}; });
  });
}

function pintarPerfil(){
  const s = mcPerfil.saldoUsd;
  const u = mcEl("saldoUsuario");    if (u) u.textContent = fmt(s);
  const p = mcEl("saldoUsuarioPen"); if (p) p.textContent = fmtPEN(s);
  const dn = mcEl("drawerNombre");   if (dn) dn.textContent = mcPerfil.nombre;
  const ds = mcEl("drawerSaldo");    if (ds) ds.textContent = fmt(s) + " · " + fmtPEN(s);
  const da = mcEl("drawerAvatar");   if (da) da.textContent = String(mcPerfil.nombre || "N").trim().charAt(0).toUpperCase();
}

/* =========================================================
   RECONSTRUIR LA LISTA PLANA DE ACCESOS
========================================================= */

function diasRenovadosDe(cuentaId){
  let dias = 0;
  Object.values(mcRenovaciones).forEach(r => {
    if (!r || r.cuentaId !== cuentaId) return;
    /* Solo cuentan las aceptadas (o pendientes, que ya se pagaron) */
    const est = String(r.estado || "").toLowerCase();
    if (est === "aceptada" || est === "pendiente") dias += num(r.duracionDias);
  });
  return dias;
}

function estadoReembolsoDe(cuentaId){
  let est = null;
  Object.values(mcReembolsos).forEach(r => {
    if (!r || r.cuentaId !== cuentaId) return;
    est = String(r.estado || "pendiente").toLowerCase();
  });
  return est;
}

function reconstruirFilas(){
  mcFilas = [];

  Object.keys(mcComprasRaw).forEach(compraId => {
    const c = mcComprasRaw[compraId];
    if (!c || !Array.isArray(c.items)) return;

    c.items.forEach((it, iIdx) => {
      const accesos = Array.isArray(it.accesos) && it.accesos.length
        ? it.accesos
        : [{ cuentaId: "", correo: "", clave: "", perfil: "", pin: "" }];

      accesos.forEach((a, aIdx) => {
        const cuentaId = a.cuentaId || (it.productoId + "_" + compraId + "_" + aIdx);
        const dias = num(it.duracionDias) + diasRenovadosDe(cuentaId);

        mcFilas.push({
          /* rutas para poder escribir la nota del cliente */
          compraId, iIdx, aIdx,

          cuentaId,
          productoId:      it.productoId || "",
          servicio:        it.productoNombre || "Producto",
          plataforma:      it.plataforma || it.productoNombre || "Otros",
          proveedor:       it.proveedor || "NovaStream",
          proveedorId:     it.proveedorId || "",
          imagen:          it.imagen || "",
          precio:          num(it.precioUnitarioUsd),
          duracionDias:    num(it.duracionDias),
          aplicaReembolso: it.aplicaReembolso || "si",
          reglas:          it.reglas || "",

          correo: a.correo || "",
          clave:  a.clave  || "",
          perfil: a.perfil || "",
          pin:    a.pin    || "",
          nombreCliente: a.nombreCliente || "",

          fechaCompra: num(c.fecha),
          fechaExpira: dias > 0 ? num(c.fecha) + dias * MC_MS_DIA : num(c.fecha),
          reembolso:   estadoReembolsoDe(cuentaId)
        });
      });
    });
  });

  renderPlataformas();
  renderCompras();
}

/* =========================================================
   ESTADO DE CADA ACCESO
========================================================= */

function obtenerEstado(f){
  if (f.reembolso === "aprobado") return "expirada";
  const restante = f.fechaExpira - Date.now();
  if (restante <= 0) return "expirada";
  if (restante <= MC_DIAS_RENOVAR * MC_MS_DIA) return "porVencer";
  return "activa";
}

function etiquetaEstado(e){
  if (e === "porVencer") return "Por vencer";
  if (e === "expirada")  return "Expirada";
  return "Activa";
}

function tiempoRestante(fechaExpira){
  const diff = fechaExpira - Date.now();
  if (diff <= 0) return "Expirada";

  const dias = Math.floor(diff / MC_MS_DIA);
  const horas = Math.floor((diff / (1000*60*60)) % 24);
  const min = Math.floor((diff / (1000*60)) % 60);
  const seg = Math.floor((diff / 1000) % 60);

  if (dias > 0) return dias + "d " + horas + "h restantes";
  return horas + "h " + min + "m " + seg + "s restantes";
}

function puedeRenovar(f, estado){
  if (f.reembolso === "pendiente" || f.reembolso === "aprobado") return false;
  return estado === "porVencer" || estado === "expirada";
}

function puedeReembolsar(f){
  if (f.aplicaReembolso === "no") return false;
  if (f.reembolso) return false;                    // ya solicitado
  return (Date.now() - f.fechaCompra) <= MC_LIMITE_REEMB;
}

/* =========================================================
   FILTROS
========================================================= */

function renderPlataformas(){
  const cont = mcEl("mcPlataformas");
  if (!cont) return;

  const vistas = new Map();
  mcFilas.forEach(f => { if (!vistas.has(f.plataforma)) vistas.set(f.plataforma, f.imagen); });

  if (!vistas.size){ cont.innerHTML = ""; return; }

  let html = '<button type="button" class="mcPlatBtn' + (filtroPlataforma === "todos" ? " activo" : "") + '" data-plataforma="todos">Todas</button>';

  Array.from(vistas.keys()).sort((a,b) => a.localeCompare(b)).forEach(p => {
    html += '<button type="button" class="mcPlatBtn' + (filtroPlataforma === p ? " activo" : "") + '" data-plataforma="' + esc(p) + '">' +
              '<span class="mcPlatAvatar"><img src="' + esc(vistas.get(p) || "") + '" alt="" onerror="this.style.opacity=0"></span>' +
              '<span>' + esc(p) + '</span>' +
            '</button>';
  });

  cont.innerHTML = html;

  cont.querySelectorAll(".mcPlatBtn").forEach(btn => {
    btn.addEventListener("click", function(){
      filtroPlataforma = this.dataset.plataforma;
      renderPlataformas();
      renderCompras();
    });
  });
}

function coincide(f){
  const est = obtenerEstado(f);
  const okEstado = filtroEstado === "todos" || est === filtroEstado;
  const okPlat = filtroPlataforma === "todos" || f.plataforma === filtroPlataforma;
  const texto = [f.servicio, f.plataforma, f.correo, f.nombreCliente, f.proveedor].join(" ");
  const okTexto = !filtroTexto || norm(texto).includes(norm(filtroTexto));
  return okEstado && okPlat && okTexto;
}

/* =========================================================
   VISTA (compacto / tarjetas)
========================================================= */

const MC_KEY_MOVIL = "ns_vista_compras_movil";
const MC_KEY_ESCRIT = "ns_vista_compras_escritorio";

function esMovil(){ return window.matchMedia("(max-width:768px)").matches; }
function claveVista(){ return esMovil() ? MC_KEY_MOVIL : MC_KEY_ESCRIT; }

function vistaInicial(){
  const g = localStorage.getItem(claveVista());
  if (g === "compacto" || g === "tarjetas") return g;
  return esMovil() ? "tarjetas" : "compacto";
}

let vistaActual = vistaInicial();

function aplicarVista(v, guardar){
  vistaActual = v;
  if (guardar) localStorage.setItem(claveVista(), v);
  document.querySelectorAll(".mcVistaBtn").forEach(b => b.classList.toggle("activo", b.dataset.vista === v));
}

/* =========================================================
   RENDER
========================================================= */

function renderCompras(){
  const cont = mcEl("mcListado");
  const info = mcEl("mcResultadoInfo");
  if (!cont) return;

  document.querySelectorAll(".mcVistaBtn").forEach(b => b.classList.toggle("activo", b.dataset.vista === vistaActual));

  /* Resumen */
  let act = 0, pv = 0, exp = 0, inv = 0;
  mcFilas.forEach(f => {
    const e = obtenerEstado(f);
    if (e === "activa") act++;
    else if (e === "porVencer") pv++;
    else exp++;
    inv += f.precio;
  });

  const sa = mcEl("mcStatActivos");    if (sa) sa.textContent = String(act);
  const sp = mcEl("mcStatPorVencer");  if (sp) sp.textContent = String(pv);
  const se = mcEl("mcStatExpirados");  if (se) se.textContent = String(exp);
  const si = mcEl("mcStatInvertido");  if (si) si.textContent = fmt(inv);

  const visibles = mcFilas.filter(coincide);

  if (info){
    info.textContent = (!mcFilas.length)
      ? "Todavía no tienes compras."
      : (visibles.length === mcFilas.length
          ? "Mostrando todos tus accesos (" + mcFilas.length + ")"
          : "Mostrando " + visibles.length + " de " + mcFilas.length + " accesos");
  }

  cont.className = "mcListado vista-" + vistaActual;

  if (!mcFilas.length){
    cont.innerHTML = '<div class="nsCargando">Aún no realizaste ninguna compra. <a href="catalogo.html" style="color:var(--teal)">Ir al catálogo →</a></div>';
    return;
  }

  if (!visibles.length){
    cont.innerHTML = '<div class="nsCargando">No se encontraron accesos con estos filtros.</div>';
    return;
  }

  /* Ordena: por vencer primero, luego activas, luego expiradas */
  const peso = { porVencer: 0, activa: 1, expirada: 2 };
  visibles.sort((a,b) => {
    const pa = peso[obtenerEstado(a)], pb = peso[obtenerEstado(b)];
    if (pa !== pb) return pa - pb;
    return a.fechaExpira - b.fechaExpira;
  });

  cont.innerHTML = vistaActual === "compacto" ? plantillaCompacta(visibles) : plantillaTarjetas(visibles);

  cont.querySelectorAll(".mcBtnVer").forEach(b => b.addEventListener("click", () => abrirModal(b.dataset.k)));
  cont.querySelectorAll(".mcBtnRenovar.activo").forEach(b => b.addEventListener("click", () => pedirRenovacion(b.dataset.k)));
  cont.querySelectorAll(".mcBtnSoporte").forEach(b => b.addEventListener("click", () => soporte(b.dataset.k)));
}

function claveFila(f){ return f.compraId + "|" + f.iIdx + "|" + f.aIdx; }
function buscarFila(k){
  const p = String(k || "").split("|");
  return mcFilas.find(f => f.compraId === p[0] && String(f.iIdx) === p[1] && String(f.aIdx) === p[2]) || null;
}

function chipReembolso(f){
  if (!f.reembolso) return "";
  const txt = f.reembolso === "aprobado" ? "Reembolsado"
            : f.reembolso === "rechazado" ? "Reemb. rechazado"
            : "Reemb. en revisión";
  return '<span class="mcChipReemb ' + esc(f.reembolso) + '">' + esc(txt) + '</span>';
}

function plantillaTarjetas(lista){
  return lista.map(f => {
    const e = obtenerEstado(f);
    const k = claveFila(f);
    const rn = puedeRenovar(f, e);

    return '<div class="mcCard ' + e + '">' +
      '<div class="mcCardTop">' +
        '<div class="mcCardAvatar"><img src="' + esc(f.imagen) + '" alt="" onerror="this.style.opacity=0"></div>' +
        '<div>' +
          '<div class="mcCardTitulo">' + esc(f.servicio) + '</div>' +
          '<div class="mcCardSub">Comprado el ' + esc(fechaCorta(f.fechaCompra)) + '</div>' +
          '<div class="mcCardCliente">👤 ' + esc(f.nombreCliente || "Sin registrar") + '</div>' +
        '</div>' +
        '<span class="mcBadge ' + e + '">' + esc(etiquetaEstado(e)) + '</span>' +
      '</div>' +
      '<div class="mcCardBody">' +
        chipReembolso(f) +
        '<div class="mcCardRow"><span>Precio</span>' +
          '<span class="mcPrecio"><span class="mcPrecioUsd">' + fmt(f.precio) + '</span>' +
          '<span class="mcPrecioPen">' + fmtPEN(f.precio) + '</span></span></div>' +
        '<div class="mcCardRow"><span>Proveedor</span><strong>' + esc(f.proveedor) + '</strong></div>' +
        '<div class="mcCardRow"><span>Vence</span><strong>' + esc(fechaCorta(f.fechaExpira)) + '</strong></div>' +
        '<div class="mcTiempoBox ' + e + '">' +
          '<span class="mcTiempoLabel">Tiempo restante</span>' +
          '<span class="mcTiempoValor ' + e + '" data-expira="' + f.fechaExpira + '">' + esc(tiempoRestante(f.fechaExpira)) + '</span>' +
        '</div>' +
        '<div class="mcCardBtns">' +
          '<button type="button" class="mcBtnVer" data-k="' + esc(k) + '">👁 Ver cuenta</button>' +
          '<button type="button" class="mcBtnRenovar ' + (rn ? "activo" : "") + '" data-k="' + esc(k) + '" ' + (rn ? "" : "disabled") + '>🔄 Renovar</button>' +
          '<button type="button" class="mcBtnSoporte" data-k="' + esc(k) + '" title="Soporte">🎧</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join("");
}

function plantillaCompacta(lista){
  const filas = lista.map(f => {
    const e = obtenerEstado(f);
    const k = claveFila(f);
    const rn = puedeRenovar(f, e);

    return '<div class="mcCompactRow ' + e + '">' +
      '<div class="mcCompactServicio">' +
        '<div class="mcCompactAvatar"><img src="' + esc(f.imagen) + '" alt="" onerror="this.style.opacity=0"></div>' +
        '<div class="mcCompactServicioTexto">' +
          '<div class="mcCompactNombre">' + esc(f.servicio) + '</div>' +
          '<div class="mcCompactFecha">👤 ' + esc(f.nombreCliente || "Sin registrar") + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mcCompactCell"><span class="mcBadge ' + e + '">' + esc(etiquetaEstado(e)) + '</span>' + chipReembolso(f) + '</div>' +
      '<div class="mcCompactCell"><div class="mcCompactPrecio">' +
        '<span class="usd">' + fmt(f.precio) + '</span><span class="pen">' + fmtPEN(f.precio) + '</span></div></div>' +
      '<div class="mcCompactCell"><strong>' + esc(fechaCorta(f.fechaExpira)) + '</strong></div>' +
      '<div class="mcCompactCell"><span class="mcCompactTiempo ' + e + '" data-expira="' + f.fechaExpira + '">' + esc(tiempoRestante(f.fechaExpira)) + '</span></div>' +
      '<div class="mcCompactAcciones">' +
        '<button type="button" class="mcBtnVer" data-k="' + esc(k) + '">👁 Ver</button>' +
        '<button type="button" class="mcBtnRenovar ' + (rn ? "activo" : "") + '" data-k="' + esc(k) + '" ' + (rn ? "" : "disabled") + '>🔄 Renovar</button>' +
        '<button type="button" class="mcBtnSoporte" data-k="' + esc(k) + '" title="Soporte">🎧</button>' +
      '</div>' +
    '</div>';
  }).join("");

  return '<div class="mcCompactScrollHint"></div>' +
    '<div class="mcCompactWrap">' +
      '<div class="mcCompactHead">' +
        '<div>Servicio</div><div>Estado</div><div>Precio</div>' +
        '<div>Vence</div><div>Tiempo restante</div>' +
        '<div style="text-align:right;">Acciones</div>' +
      '</div>' +
      '<div class="mcCompactBody">' + filas + '</div>' +
    '</div>';
}

function actualizarContadores(){
  document.querySelectorAll(".mcTiempoValor[data-expira], .mcCompactTiempo[data-expira]").forEach(el => {
    el.textContent = tiempoRestante(Number(el.dataset.expira));
  });
}

/* =========================================================
   MODAL VER CUENTA
========================================================= */

function abrirModal(k){
  const f = buscarFila(k);
  if (!f) return;

  mcFilaModal = f;
  const e = obtenerEstado(f);

  mcEl("mcModalImagen").src = f.imagen || "";
  mcEl("mcModalServicio").textContent = f.servicio;

  const badge = mcEl("mcModalEstadoBadge");
  badge.textContent = etiquetaEstado(e);
  badge.className = "mcBadge " + e;

  mcEl("mcModalCorreo").textContent = f.correo || "-";
  mcEl("mcModalClave").textContent  = f.clave  || "-";
  mcEl("mcModalPerfil").textContent = f.perfil || "-";
  mcEl("mcModalPin").textContent    = f.pin    || "-";
  mcEl("mcModalVence").textContent  = fechaCorta(f.fechaExpira) + " · " + tiempoRestante(f.fechaExpira);
  mcEl("mcModalProveedor").textContent = f.proveedor;

  clienteModoVista(f.nombreCliente);

  const obsWrap = mcEl("mcModalObsWrap");
  if (f.reglas){
    obsWrap.style.display = "";
    mcEl("mcModalObservacion").textContent = f.reglas;
  } else {
    obsWrap.style.display = "none";
  }

  const btnReemb = mcEl("mcBtnReembolso");
  if (btnReemb){
    const ok = puedeReembolsar(f);
    btnReemb.disabled = !ok;
    btnReemb.textContent = f.reembolso
      ? "↩️ Reembolso " + f.reembolso
      : (f.aplicaReembolso === "no" ? "↩️ Sin reembolso"
        : ok ? "↩️ Solicitar reembolso" : "↩️ Plazo vencido (24 h)");
  }

  mcEl("mcModalCuenta").style.display = "flex";
}

function cerrarModal(){
  mcEl("mcModalCuenta").style.display = "none";
  mcFilaModal = null;
}

async function copiarTexto(t){
  if (!t || t === "-") return false;
  try { await navigator.clipboard.writeText(t); return true; }
  catch(e){ return false; }
}

/* =========================================================
   NOTA DEL CLIENTE
   Se guarda en compras/{uid}/{compraId}/items/{i}/accesos/{j}/nombreCliente
   Las reglas permiten al dueño actualizar su propia compra.
========================================================= */

function clienteModoVista(nombre){
  const t = mcEl("mcModalClienteTexto");
  const i = mcEl("mcModalClienteInput");
  const be = mcEl("mcBtnEditarCliente");
  const bg = mcEl("mcBtnGuardarCliente");

  t.textContent = nombre || "Sin registrar";
  i.value = nombre || "";
  t.style.display = "";
  be.textContent = nombre ? "Editar" : "Registrar";
  be.style.display = "";
  i.style.display = "none";
  bg.style.display = "none";
}

function clienteModoEdicion(){
  mcEl("mcModalClienteTexto").style.display = "none";
  mcEl("mcBtnEditarCliente").style.display = "none";
  const i = mcEl("mcModalClienteInput");
  i.style.display = "";
  mcEl("mcBtnGuardarCliente").style.display = "";
  i.focus();
}

async function guardarCliente(){
  const f = mcFilaModal;
  if (!f) return;

  const nombre = String(mcEl("mcModalClienteInput").value || "").trim().slice(0, 60);
  const ruta = "compras/" + mcUid + "/" + f.compraId + "/items/" + f.iIdx + "/accesos/" + f.aIdx + "/nombreCliente";

  try {
    await mcDb.ref(ruta).set(nombre);
    f.nombreCliente = nombre;
    clienteModoVista(nombre);
    renderCompras();
    toast(nombre ? "✅ Cliente registrado" : "Nota eliminada");
  } catch(err){
    console.error(err);
    toast("No se pudo guardar la nota.");
  }
}

/* =========================================================
   CONFIRMACIÓN GENÉRICA
========================================================= */

function abrirConfirm(opts){
  mcEl("mcConfirmIcono").textContent = opts.icono || "❓";
  mcEl("mcConfirmTitulo").textContent = opts.titulo || "Confirmar";
  mcEl("mcConfirmTexto").textContent = opts.texto || "";
  mcEl("mcConfirmAceptar").textContent = opts.aceptar || "Confirmar";

  const campo = mcEl("mcConfirmCampo");
  campo.style.display = opts.pedirMotivo ? "" : "none";
  mcEl("mcConfirmMotivo").value = "";

  mcAccionPendiente = opts.accion || null;
  mcEl("mcConfirm").classList.add("show");
}

function cerrarConfirm(){
  mcEl("mcConfirm").classList.remove("show");
  mcAccionPendiente = null;
}

/* =========================================================
   RENOVACIÓN
   Se cobra al solicitar (las reglas no dejan que el proveedor
   toque el saldo del cliente). Ver nota de cabecera.
========================================================= */

function pedirRenovacion(k){
  const f = buscarFila(k);
  if (!f) return;

  if (!f.proveedorId){
    toast("Este producto no tiene proveedor asignado. Contacta con soporte.");
    return;
  }

  abrirConfirm({
    icono: "🔄",
    titulo: "Renovar acceso",
    texto: "Se descontará " + fmt(f.precio) + " (" + fmtPEN(f.precio) + ") de tu saldo y se pedirá al proveedor " +
           f.proveedor + " que extienda tu acceso a \"" + f.servicio + "\" por " + f.duracionDias + " días más.",
    aceptar: "Sí, renovar",
    accion: { tipo: "renovar", fila: f }
  });
}

async function ejecutarRenovacion(f){
  const monto = red(f.precio);

  /* Saldo real del servidor */
  let saldoReal = 0;
  try {
    const s = await mcDb.ref("usuarios/" + mcUid + "/saldoUsd").get();
    saldoReal = num(s.val());
  } catch(e){ toast("No pudimos verificar tu saldo."); return; }

  if (saldoReal < monto){
    toast("Saldo insuficiente. Te faltan " + fmt(monto - saldoReal) + ".");
    setTimeout(() => { window.location.href = "recargas.html"; }, 1600);
    return;
  }

  const ahora = Date.now();
  const renId = mcDb.ref("renovaciones").push().key;
  const movCli = mcDb.ref("movimientosSaldo/" + mcUid).push().key;
  const movProv = mcDb.ref("movimientosSaldo/" + f.proveedorId).push().key;

  const updates = {};

  /* 1. Solicitud (estado obligatorio 'pendiente') */
  updates["renovaciones/" + renId] = {
    clienteId:      mcUid,
    clienteNombre:  mcPerfil.nombre,
    proveedorId:    f.proveedorId,
    proveedorNombre: f.proveedor,
    productoId:     f.productoId,
    productoNombre: f.servicio,
    cuentaId:       f.cuentaId,
    compraId:       f.compraId,
    montoUsd:       monto,
    duracionDias:   f.duracionDias,
    estado:         "pendiente",
    fecha:          ahora
  };

  /* 2. Cobro al cliente (solo puede bajar su propio saldo) */
  updates["usuarios/" + mcUid + "/saldoUsd"] = red(saldoReal - monto);
  updates["movimientosSaldo/" + mcUid + "/" + movCli] = {
    tipo: "compra",
    detalle: "Renovación · " + f.servicio,
    montoUsd: monto, signo: "-", fecha: ahora
  };

  /* 3. Movimiento del proveedor (tipo 'venta' es lo que permiten las reglas) */
  updates["movimientosSaldo/" + f.proveedorId + "/" + movProv] = {
    tipo: "venta",
    detalle: "Renovación · " + f.servicio + " · " + mcPerfil.nombre,
    montoUsd: monto, signo: "+", fecha: ahora
  };

  try {
    await mcDb.ref().update(updates);

    /* 4. Acreditar al proveedor (transacción aparte para no pisar saldos) */
    try {
      await mcDb.ref("usuarios/" + f.proveedorId + "/saldoUsd").transaction(
        a => red(num(a) + monto)
      );
    } catch(e){ console.error("No se pudo acreditar al proveedor:", e); }

    toast("🔄 Renovación solicitada. El proveedor la confirmará pronto.");
  } catch(err){
    console.error(err);
    toast("No se pudo procesar la renovación: " + (err.message || ""));
  }
}

/* =========================================================
   REEMBOLSO — solo crea la solicitud
========================================================= */

function pedirReembolso(){
  const f = mcFilaModal;
  if (!f) return;
  if (!puedeReembolsar(f)) return;

  abrirConfirm({
    icono: "↩️",
    titulo: "Solicitar reembolso",
    texto: "Se enviará una solicitud de reembolso por " + fmt(f.precio) + " del acceso \"" + f.servicio +
           "\". El administrador la revisará y, si procede, devolverá el saldo a tu cuenta.",
    aceptar: "Enviar solicitud",
    pedirMotivo: true,
    accion: { tipo: "reembolso", fila: f }
  });
}

async function ejecutarReembolso(f, motivo){
  if (!motivo || motivo.trim().length < 8){
    toast("Explica el motivo con un poco más de detalle (mínimo 8 caracteres).");
    return;
  }

  try {
    /* Estado obligatorio 'pendiente'. El cliente NUNCA puede aprobarlo. */
    await mcDb.ref("reembolsos").push({
      clienteId:      mcUid,
      clienteNombre:  mcPerfil.nombre,
      proveedorId:    f.proveedorId || "",
      proveedorNombre: f.proveedor || "",
      productoId:     f.productoId || "",
      productoNombre: f.servicio,
      cuentaId:       f.cuentaId || "",
      compraId:       f.compraId,
      montoUsd:       red(f.precio),
      motivo:         motivo.trim().slice(0, 380),
      estado:         "pendiente",
      fecha:          Date.now()
    });

    toast("↩️ Solicitud enviada. Te responderemos en breve.");
    cerrarModal();
  } catch(err){
    console.error(err);
    toast("No se pudo enviar la solicitud: " + (err.message || ""));
  }
}

/* =========================================================
   SOPORTE
========================================================= */

function numeroSoporte(proveedorId){
  const p = mcProveedores[proveedorId] || {};
  if (p.soporteActivo !== false && p.whatsappSoporte){
    return String(p.whatsappSoporte).replace(/\D/g, "");
  }
  const otro = Object.values(mcProveedores).find(x => x && x.soporteActivo !== false && x.whatsappSoporte);
  return otro ? String(otro.whatsappSoporte).replace(/\D/g, "") : MC_WSP_FALLBACK;
}

function soporte(k){
  const f = buscarFila(k) || mcFilaModal;
  if (!f) return;
  const num = numeroSoporte(f.proveedorId);
  const txt = encodeURIComponent(
    "Hola, necesito soporte con mi compra en NovaStream:\n" +
    "Producto: " + f.servicio + "\n" +
    "Cuenta: " + (f.correo || "-")
  );
  window.open("https://wa.me/" + num + "?text=" + txt, "_blank");
}

/* =========================================================
   NAVBAR
========================================================= */

function ajustarAlturaNav(){
  const nav = mcEl("nsNav");
  if (!nav) return;
  document.documentElement.style.setProperty("--nav-height", nav.offsetHeight + "px");
}

window.addEventListener("load", ajustarAlturaNav);
window.addEventListener("resize", ajustarAlturaNav);

/* =========================================================
   INIT
========================================================= */

document.addEventListener("DOMContentLoaded", () => {

  /* Drawer aislado primero */
  try {
    const btnMenu = mcEl("btnMenuMovil");
    const overlay = mcEl("nsDrawerOverlay");
    const btnClose = mcEl("btnCerrarDrawer");
    const salir = mcEl("linkSalirDrawer");

    if (btnMenu && overlay) btnMenu.addEventListener("click", () => overlay.classList.add("activo"));
    if (btnClose && overlay) btnClose.addEventListener("click", () => overlay.classList.remove("activo"));
    if (overlay) overlay.addEventListener("click", e => { if (e.target.id === "nsDrawerOverlay") overlay.classList.remove("activo"); });

    if (salir){
      salir.addEventListener("click", async e => {
        e.preventDefault();
        if (overlay) overlay.classList.remove("activo");
        try { if (mcAuth) await mcAuth.signOut(); } catch(err){}
        window.location.replace(MC_LOGIN_URL);
      });
    }
  } catch(err){ console.error("Drawer:", err); }

  ajustarAlturaNav();
  aplicarVista(vistaActual, false);
  setInterval(actualizarContadores, 1000);

  /* Vista */
  document.querySelectorAll(".mcVistaBtn").forEach(b => {
    b.addEventListener("click", function(){ aplicarVista(this.dataset.vista, true); renderCompras(); });
  });

  let eraMovil = esMovil();
  window.addEventListener("resize", () => {
    const ahora = esMovil();
    if (ahora !== eraMovil){ eraMovil = ahora; aplicarVista(vistaInicial(), false); renderCompras(); }
  });

  /* Filtros */
  mcEl("buscadorCompras").addEventListener("input", function(){ filtroTexto = this.value; renderCompras(); });
  mcEl("filtroEstado").addEventListener("change", function(){ filtroEstado = this.value; renderCompras(); });

  /* Modal */
  mcEl("mcCerrarModalCuenta").addEventListener("click", cerrarModal);
  mcEl("mcModalCuenta").addEventListener("click", e => { if (e.target.id === "mcModalCuenta") cerrarModal(); });

  document.querySelectorAll(".mcBtnCopiar").forEach(btn => {
    btn.addEventListener("click", async function(){
      const t = this.dataset.copyTarget;
      if (!t) return;
      const ok = await copiarTexto(mcEl(t).textContent);
      if (ok){
        const o = this.textContent;
        this.textContent = "Copiado";
        setTimeout(() => this.textContent = o, 1300);
      }
    });
  });

  mcEl("mcBtnCopiarTodo").addEventListener("click", async () => {
    const f = mcFilaModal;
    if (!f) return;
    const p = ["Servicio: " + f.servicio];
    if (f.nombreCliente) p.push("Cliente: " + f.nombreCliente);
    p.push("Correo/Usuario: " + (f.correo || "-"));
    p.push("Clave: " + (f.clave || "-"));
    if (f.perfil && f.perfil !== "-") p.push("Perfil: " + f.perfil);
    if (f.pin) p.push("PIN: " + f.pin);
    p.push("Vence: " + fechaCorta(f.fechaExpira));
    const ok = await copiarTexto(p.join("\n"));
    toast(ok ? "Todos los datos copiados" : "No se pudo copiar");
  });

  /* Nota del cliente */
  mcEl("mcBtnEditarCliente").addEventListener("click", clienteModoEdicion);
  mcEl("mcBtnGuardarCliente").addEventListener("click", guardarCliente);
  mcEl("mcModalClienteInput").addEventListener("keydown", e => {
    if (e.key === "Enter"){ e.preventDefault(); guardarCliente(); }
  });

  /* Reembolso / soporte desde el modal */
  mcEl("mcBtnReembolso").addEventListener("click", pedirReembolso);
  mcEl("mcBtnSoporteModal").addEventListener("click", () => soporte(null));

  /* Confirmación */
  mcEl("mcConfirmCancelar").addEventListener("click", cerrarConfirm);
  mcEl("mcConfirm").addEventListener("click", e => { if (e.target.id === "mcConfirm") cerrarConfirm(); });

  mcEl("mcConfirmAceptar").addEventListener("click", async () => {
    const a = mcAccionPendiente;
    const motivo = mcEl("mcConfirmMotivo").value;
    cerrarConfirm();
    if (!a) return;

    if (a.tipo === "renovar")   await ejecutarRenovacion(a.fila);
    if (a.tipo === "reembolso") await ejecutarReembolso(a.fila, motivo);
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape"){
      cerrarModal();
      cerrarConfirm();
      const o = mcEl("nsDrawerOverlay");
      if (o) o.classList.remove("activo");
    }
  });

  mcInit();
});
