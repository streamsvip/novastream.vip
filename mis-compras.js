/* =========================
   CONFIG
========================= */

const firebaseConfig = {
  apiKey: "AIzaSyAFTFc35Dqm8St1bA7ffAcBRlk4DHkNljI",
  authDomain: "novastream-aeb9d.firebaseapp.com",
  databaseURL: "https://novastream-aeb9d-default-rtdb.firebaseio.com",
  projectId: "novastream-aeb9d",
  storageBucket: "novastream-aeb9d.firebasestorage.app",
  messagingSenderId: "101726393403",
  appId: "1:101726393403:web:65b43413b89d7c9968781e",
  measurementId: "G-WX6PRVKMB8"
};

const MC_LOGIN_URL = "login.html";
const MC_ADMIN_URL = "novaadmin.html";

const MC_TIPO_CAMBIO   = 3.40;
const MC_DIAS_RENOVAR  = 3;                        // se puede renovar con <= 3 días
const MC_MS_DIA        = 24 * 60 * 60 * 1000;
const MC_WSP_FALLBACK  = "51900000000";

/* ⭐ v8: el reembolso ya NO está limitado a 24 h.
   Se puede pedir mientras el acceso siga vigente. */

/* Motivos predefinidos de reembolso (se envían al proveedor) */
const MC_MOTIVOS_REEMBOLSO = {
  no_funciona:    "La cuenta no funciona / no deja ingresar",
  clave_cambiada: "Cambiaron la contraseña o el correo",
  perfil_ocupado: "El perfil está ocupado o fue eliminado",
  pantallas:      "Límite de pantallas o dispositivos",
  calidad:        "No es el plan o la calidad prometida",
  otro:           "Otro motivo"
};

/* ⭐ v8: vista según dispositivo (celular → tarjetas, PC → compacto).
   Se incluye tablets/celulares en horizontal con pantalla táctil. */
const MC_MQ_MOVIL = "(max-width:768px), (hover:none) and (pointer:coarse) and (max-width:1024px)";

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

/* ⭐ v8: datos EN VIVO de cada cuenta entregada (/cuentas/{pid}/{cid}).
   Así, si el proveedor reemplaza la cuenta o cambia la clave,
   el cliente ve los datos nuevos y la marca "Cuenta reemplazada". */
let mcCuentasVivas     = {};   // { cuentaId: {...} }
let mcCuentasRefs      = {};   // { "pid/cid": ref }
let mcCuentasDenegadas = {};   // { "pid/cid": true } si las reglas no dejan leer
let mcTimerReconstruir = null;

let mcFilas = [];          // lista plana de accesos

let filtroTexto = "";
let filtroEstado = "todos";
let filtroPlataforma = "todos";

let mcFilaModal = null;
let mcAccionPendiente = null;   // { tipo:'renovar'|'reembolso', fila }

let mcPerfilListo = false;
let mcComprasListo = false;

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

function diasRestantesDe(f){
  return Math.max(0, Math.ceil((f.fechaExpira - Date.now()) / MC_MS_DIA));
}

function toast(msg){
  const el = mcEl("toastAviso");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("visible"), 3200);
}

/* =========================================================
   LOADER
========================================================= */

function mcIntentarOcultarBooting(forzar){
  if (!forzar && (!mcPerfilListo || !mcComprasListo)) return;
  const el = mcEl("rgBooting");
  if (el) el.classList.add("off");
}

/* =========================================================
   FIREBASE + GUARDIA DE SESIÓN
========================================================= */

function mcInit(){
  if (typeof firebase === "undefined"){
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#fff;font-family:sans-serif">No se pudo cargar el sistema. Revisa tu conexión.</div>';
    return;
  }

  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  mcAuth = firebase.auth();
  mcDb   = firebase.database();

  /* Proveedores públicos: soporte y nombre de tienda EN VIVO
     (si el proveedor cambia su nombre, se ve también en compras antiguas) */
  mcDb.ref("proveedoresPublicos").on("value", s => {
    mcProveedores = s.val() || {};
    if (mcUid) programarReconstruccion();
  });

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
    document.body.classList.add("nsAutenticado");

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
      pintarUserMenu();
      mcPerfilListo = true;
      mcIntentarOcultarBooting();
    });

    mcDb.ref("compras/" + mcUid).on("value", s => {
      mcComprasRaw = s.val() || {};
      reconstruirFilas();
      mcComprasListo = true;
      mcIntentarOcultarBooting();
    }, err => {
      console.error(err);
      mcComprasRaw = {};
      reconstruirFilas();
      mcComprasListo = true;
      mcIntentarOcultarBooting();
    });

    mcDb.ref("renovaciones").orderByChild("clienteId").equalTo(mcUid)
      .on("value", s => { mcRenovaciones = s.val() || {}; reconstruirFilas(); },
          () => { mcRenovaciones = {}; });

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

function pintarUserMenu(){
  const inicial = String(mcPerfil.nombre || "N").trim().charAt(0).toUpperCase();
  const set = (id, v) => { const el = mcEl(id); if (el) el.textContent = v; };
  set("nsUserAvatarChip", inicial);
  set("nsUserAvatarDropdown", inicial);
  set("nsUserNombreChip", mcPerfil.nombre);
  set("nsUserNombreDropdown", mcPerfil.nombre);
  set("nsUserCorreoDropdown", mcPerfil.correo || "");
  set("nsUserDropdownSaldoValor", fmt(mcPerfil.saldoUsd));
}

async function mcCerrarSesion(){
  const overlay = mcEl("nsDrawerOverlay");
  if (overlay) overlay.classList.remove("activo");

  const menuWrap = mcEl("nsUserMenu");
  const btnMenu = mcEl("btnUserMenu");
  if (menuWrap) menuWrap.classList.remove("abierto");
  if (btnMenu) btnMenu.setAttribute("aria-expanded", "false");

  try { if (mcAuth) await mcAuth.signOut(); } catch(err){}
  window.location.replace(MC_LOGIN_URL);
}

/* =========================================================
   CUENTAS EN VIVO (detección de reemplazo)
========================================================= */

function programarReconstruccion(){
  clearTimeout(mcTimerReconstruir);
  mcTimerReconstruir = setTimeout(reconstruirFilas, 80);
}

function escucharCuentaViva(pid, cid){
  if (!mcDb || !pid || !cid) return;
  const k = pid + "/" + cid;
  if (mcCuentasRefs[k] || mcCuentasDenegadas[k]) return;

  const ref = mcDb.ref("cuentas/" + k);
  mcCuentasRefs[k] = ref;

  ref.on("value", s => {
    mcCuentasVivas[cid] = s.val();
    programarReconstruccion();
  }, () => {
    /* Las reglas no permiten leerla: se usa la copia guardada en la compra */
    mcCuentasDenegadas[k] = true;
    delete mcCuentasRefs[k];
    delete mcCuentasVivas[cid];
  });
}

/* Solo se usa la cuenta viva si sigue asignada a ESTE cliente.
   (Si fue reembolsada y volvió al stock, ya no le pertenece.) */
function cuentaVivaDe(pid, cid){
  if (!pid || !cid) return null;
  escucharCuentaViva(pid, cid);
  const v = mcCuentasVivas[cid];
  if (!v || v.compradorId !== mcUid) return null;
  return v;
}

/* =========================================================
   RENOVACIONES Y REEMBOLSOS POR CUENTA
========================================================= */

function infoRenovaciones(cuentaId){
  const info = { dias: 0, aceptadas: 0, pendientes: 0, canceladas: 0, ultimaFecha: 0 };
  Object.values(mcRenovaciones).forEach(r => {
    if (!r || r.cuentaId !== cuentaId) return;
    const est = String(r.estado || "").toLowerCase();
    if (est === "aceptada"){
      info.aceptadas++;
      info.dias += num(r.duracionDias);
      info.ultimaFecha = Math.max(info.ultimaFecha, num(r.fechaResolucion) || num(r.fecha));
    } else if (est === "pendiente"){
      info.pendientes++;
      info.dias += num(r.duracionDias);   // ya está pagada
    } else if (est === "cancelada"){
      info.canceladas++;
    }
  });
  return info;
}

/* Devuelve la solicitud de reembolso MÁS RECIENTE de esa cuenta */
function infoReembolso(cuentaId){
  let ultimo = null;
  Object.values(mcReembolsos).forEach(r => {
    if (!r || r.cuentaId !== cuentaId) return;
    if (!ultimo || num(r.fecha) > num(ultimo.fecha)) ultimo = r;
  });
  if (!ultimo) return null;
  return {
    estado: String(ultimo.estado || "pendiente").toLowerCase(),
    monto: num(ultimo.montoUsd),
    fecha: num(ultimo.fecha),
    fechaResolucion: num(ultimo.fechaResolucion),
    motivoRechazo: ultimo.motivoRechazo || ""
  };
}

/* =========================================================
   RECONSTRUIR LA LISTA PLANA DE ACCESOS
========================================================= */

function reconstruirFilas(){
  mcFilas = [];

  Object.keys(mcComprasRaw).forEach(compraId => {
    const c = mcComprasRaw[compraId];
    if (!c || !Array.isArray(c.items)) return;

    c.items.forEach((it, iIdx) => {
      if (!it) return;
      const accesos = Array.isArray(it.accesos) && it.accesos.length
        ? it.accesos
        : [{ cuentaId: "", correo: "", clave: "", perfil: "", pin: "" }];

      accesos.forEach((a, aIdx) => {
        if (!a) return;
        const cuentaReal = a.cuentaId || "";
        const cuentaId = cuentaReal || (it.productoId + "_" + compraId + "_" + aIdx);
        const fechaCompra = num(c.fecha);

        const ren = infoRenovaciones(cuentaId);
        const reemb = infoReembolso(cuentaId);
        const dias = num(it.duracionDias) + ren.dias;

        /* Datos de acceso: copia de la compra, o los vivos si existen */
        let correo = a.correo || "", clave = a.clave || "", perfil = a.perfil || "", pin = a.pin || "";
        let reemplazada = false, datosActualizados = false, fechaCambio = 0;

        const viva = cuentaVivaDe(it.productoId, cuentaReal);
        if (viva){
          const vCorreo = viva.correo || "", vClave = viva.clave || "", vPerfil = viva.perfil || "", vPin = viva.pin || "";
          const flagReemplazo = viva.reemplazada === true && num(viva.fechaReemplazo) > fechaCompra;
          const cambioCorreo = vCorreo && vCorreo !== correo;
          const cambioOtros = vClave !== clave || vPerfil !== perfil || vPin !== pin;

          if (cambioCorreo || (flagReemplazo && viva.tipoCambio === "cuenta")) reemplazada = true;
          else if (cambioOtros || flagReemplazo) datosActualizados = true;

          if (flagReemplazo) fechaCambio = num(viva.fechaReemplazo);

          correo = vCorreo || correo;
          clave  = vClave  || clave;
          perfil = vPerfil;
          pin    = vPin;
        }

        mcFilas.push({
          compraId, iIdx, aIdx,

          cuentaId,
          productoId:      it.productoId || "",
          servicio:        it.productoNombre || "Producto",
          plataforma:      it.plataforma || it.productoNombre || "Otros",
          proveedor:       (mcProveedores[it.proveedorId] || {}).nombre || it.proveedor || "NovaStream",
          proveedorId:     it.proveedorId || "",
          imagen:          it.imagen || "",
          precio:          num(it.precioUnitarioUsd),
          duracionDias:    num(it.duracionDias),
          aplicaReembolso: it.aplicaReembolso || "si",
          reglas:          it.reglas || "",

          correo, clave, perfil, pin,
          nombreCliente: a.nombreCliente || "",

          fechaCompra,
          fechaExpira: dias > 0 ? fechaCompra + dias * MC_MS_DIA : fechaCompra,

          reembolso:     reemb ? reemb.estado : null,
          reembolsoInfo: reemb,
          renov:         ren,
          reemplazada, datosActualizados, fechaCambio
        });
      });
    });
  });

  renderPlataformas();
  renderCompras();

  /* Si el modal está abierto, se refresca con los datos nuevos */
  if (mcFilaModal){
    const f = buscarFila(claveFila(mcFilaModal));
    if (f && f.reembolso !== "aprobado") pintarModal(f, true);
    else if (f && f.reembolso === "aprobado"){ cerrarModal(); toast("Este acceso fue reembolsado."); }
  }
}

/* =========================================================
   ESTADO DE CADA ACCESO
========================================================= */

function obtenerEstado(f){
  if (f.reembolso === "aprobado") return "reembolsada";
  const restante = f.fechaExpira - Date.now();
  if (restante <= 0) return "expirada";
  if (restante <= MC_DIAS_RENOVAR * MC_MS_DIA) return "porVencer";
  return "activa";
}

function etiquetaEstado(e){
  if (e === "porVencer")   return "Por vencer";
  if (e === "expirada")    return "Expirada";
  if (e === "reembolsada") return "Reembolsada";
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
  if (f.renov && f.renov.pendientes > 0) return false;   // ya hay una en curso
  return estado === "porVencer" || estado === "expirada";
}

/* ⭐ v8: el reembolso se puede pedir durante TODA la vigencia */
function motivoSinReembolso(f){
  if (f.aplicaReembolso === "no")   return "Este producto no admite reembolso.";
  if (f.reembolso === "aprobado")   return "Este acceso ya fue reembolsado.";
  if (f.reembolso === "pendiente")  return "Ya tienes una solicitud de reembolso en revisión.";
  if (f.fechaExpira <= Date.now())  return "El acceso ya venció. El reembolso solo aplica mientras está vigente.";
  return "";
}

function puedeReembolsar(f){ return !motivoSinReembolso(f); }

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
   ⭐ v8: al entrar SIEMPRE se abre según el dispositivo:
   celular → tarjetas · PC → compacto. El switch cambia la
   vista solo durante la visita (no se guarda).
========================================================= */

function esMovil(){ return window.matchMedia(MC_MQ_MOVIL).matches; }
function vistaPorDispositivo(){ return esMovil() ? "tarjetas" : "compacto"; }

/* Limpia preferencias viejas que forzaban otra vista */
try {
  localStorage.removeItem("ns_vista_compras_movil");
  localStorage.removeItem("ns_vista_compras_escritorio");
} catch(e){}

let vistaActual = vistaPorDispositivo();

function aplicarVista(v){
  vistaActual = v;
  document.querySelectorAll(".mcVistaBtn").forEach(b => b.classList.toggle("activo", b.dataset.vista === v));
}

/* =========================================================
   CHIPS / AVISOS
========================================================= */

function chipsExtra(f, compacto){
  const chips = [];

  if (f.reembolso === "aprobado"){
    chips.push('<span class="mcChip reembolso">↩️ Reembolsado</span>');
  } else {
    if (f.reemplazada){
      chips.push('<span class="mcChip reemplazo" title="El proveedor te entregó una cuenta nueva' +
        (f.fechaCambio ? " el " + esc(fechaCorta(f.fechaCambio)) : "") + '">🔄 Cuenta reemplazada</span>');
    } else if (f.datosActualizados){
      chips.push('<span class="mcChip actualizado" title="El proveedor actualizó la contraseña o el perfil">🔑 Datos actualizados</span>');
    }

    if (f.renov.aceptadas > 0){
      chips.push('<span class="mcChip renovada">🔁 Renovada' + (f.renov.aceptadas > 1 ? " x" + f.renov.aceptadas : "") + '</span>');
    }
    if (f.renov.pendientes > 0){
      chips.push('<span class="mcChip pendiente">⏳ Renovación en proceso</span>');
    }

    if (f.reembolso === "pendiente"){
      chips.push('<span class="mcChip pendiente">↩️ Reembolso en revisión</span>');
    } else if (f.reembolso === "rechazado"){
      chips.push('<span class="mcChip rechazado" title="' + esc(f.reembolsoInfo && f.reembolsoInfo.motivoRechazo || "") + '">✕ Reembolso rechazado</span>');
    }
  }

  if (!chips.length) return "";
  return '<div class="mcChips' + (compacto ? " compacto" : "") + '">' + chips.join("") + '</div>';
}

function avisoReembolsoHTML(f){
  const info = f.reembolsoInfo || {};
  const monto = info.monto || f.precio;
  const fecha = info.fechaResolucion || info.fecha;
  return '<div class="mcAvisoReemb">' +
    '<div class="mcAvisoReembIcono">↩️</div>' +
    '<div>' +
      '<strong>Acceso reembolsado</strong>' +
      '<span>Se devolvieron ' + fmt(monto) + ' (' + fmtPEN(monto) + ') a tu saldo' +
      (fecha ? ' el ' + esc(fechaCorta(fecha)) : '') +
      '. Por seguridad, los datos de esta cuenta ya no están disponibles.</span>' +
    '</div>' +
  '</div>';
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
  let act = 0, pv = 0, exp = 0, rmb = 0, inv = 0;
  mcFilas.forEach(f => {
    const e = obtenerEstado(f);
    if (e === "activa") act++;
    else if (e === "porVencer") pv++;
    else if (e === "reembolsada") rmb++;
    else exp++;
    if (e !== "reembolsada") inv += f.precio;
  });

  const set = (id, v) => { const el = mcEl(id); if (el) el.textContent = v; };
  set("mcStatActivos", String(act));
  set("mcStatPorVencer", String(pv));
  set("mcStatExpirados", String(exp));
  set("mcStatReembolsados", String(rmb));
  set("mcStatInvertido", fmt(inv));

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

  const peso = { porVencer: 0, activa: 1, expirada: 2, reembolsada: 3 };
  visibles.sort((a,b) => {
    const pa = peso[obtenerEstado(a)], pb = peso[obtenerEstado(b)];
    if (pa !== pb) return pa - pb;
    return a.fechaExpira - b.fechaExpira;
  });

  cont.innerHTML = vistaActual === "compacto" ? plantillaCompacta(visibles) : plantillaTarjetas(visibles);

  cont.querySelectorAll(".mcBtnVer:not([disabled])").forEach(b => b.addEventListener("click", () => abrirModal(b.dataset.k)));
  cont.querySelectorAll(".mcBtnRenovar.activo").forEach(b => b.addEventListener("click", () => pedirRenovacion(b.dataset.k)));
  cont.querySelectorAll(".mcBtnSoporte:not(.mcBtnReembolsoFila)").forEach(b => b.addEventListener("click", () => soporte(b.dataset.k)));
  cont.querySelectorAll(".mcBtnReembolsoFila").forEach(b => b.addEventListener("click", () => pedirReembolsoDesdeFila(b.dataset.k)));
}

function claveFila(f){ return f.compraId + "|" + f.iIdx + "|" + f.aIdx; }
function buscarFila(k){
  const p = String(k || "").split("|");
  return mcFilas.find(f => f.compraId === p[0] && String(f.iIdx) === p[1] && String(f.aIdx) === p[2]) || null;
}

function botonVer(f, corto){
  if (f.reembolso === "aprobado"){
    return '<button type="button" class="mcBtnVer" disabled>🔒 ' + (corto ? "Reemb." : "Reembolsado") + '</button>';
  }
  const nuevo = f.reemplazada || f.datosActualizados;
  const txt = nuevo ? (corto ? "👁 Nuevos datos" : "👁 Ver nuevos datos") : (corto ? "👁 Ver" : "👁 Ver cuenta");
  return '<button type="button" class="mcBtnVer' + (nuevo ? " nuevo" : "") + '" data-k="' + esc(claveFila(f)) + '">' + txt + '</button>';
}

function botonReembolso(f){
  const re = puedeReembolsar(f);
  const titulo = re ? "Solicitar reembolso" : motivoSinReembolso(f);
  return '<button type="button" class="mcBtnSoporte mcBtnReembolsoFila" data-k="' + esc(claveFila(f)) + '" title="' + esc(titulo) + '"' +
    (re ? "" : ' aria-disabled="true" data-off="1"') + '>↩️</button>';
}

function plantillaTarjetas(lista){
  return lista.map(f => {
    const e = obtenerEstado(f);
    const k = claveFila(f);
    const rn = puedeRenovar(f, e);
    const reemb = e === "reembolsada";
    const extraClase = (!reemb && f.reemplazada) ? " reemplazada" : "";

    return '<div class="mcCard ' + e + extraClase + '">' +
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
        chipsExtra(f, false) +
        '<div class="mcCardRow"><span>Precio</span>' +
          '<span class="mcPrecio"><span class="mcPrecioUsd">' + fmt(f.precio) + '</span>' +
          '<span class="mcPrecioPen">' + fmtPEN(f.precio) + '</span></span></div>' +
        '<div class="mcCardRow"><span>Proveedor</span><strong>' + esc(f.proveedor) + '</strong></div>' +
        (reemb
          ? avisoReembolsoHTML(f)
          : '<div class="mcCardRow"><span>Vence</span><strong>' + esc(fechaCorta(f.fechaExpira)) + '</strong></div>' +
            '<div class="mcTiempoBox ' + e + '">' +
              '<span class="mcTiempoLabel">Tiempo restante</span>' +
              '<span class="mcTiempoValor ' + e + '" data-expira="' + f.fechaExpira + '">' + esc(tiempoRestante(f.fechaExpira)) + '</span>' +
            '</div>') +
        '<div class="mcCardBtns">' +
          botonVer(f, false) +
          '<button type="button" class="mcBtnRenovar ' + (rn ? "activo" : "") + '" data-k="' + esc(k) + '" ' + (rn ? "" : "disabled") + '>🔄 Renovar</button>' +
          '<button type="button" class="mcBtnSoporte" data-k="' + esc(k) + '" title="Soporte">🎧</button>' +
          botonReembolso(f) +
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
    const reemb = e === "reembolsada";
    const extraClase = (!reemb && f.reemplazada) ? " reemplazada" : "";

    return '<div class="mcCompactRow ' + e + extraClase + '">' +
      '<div class="mcCompactServicio">' +
        '<div class="mcCompactAvatar"><img src="' + esc(f.imagen) + '" alt="" onerror="this.style.opacity=0"></div>' +
        '<div class="mcCompactServicioTexto">' +
          '<div class="mcCompactNombre">' + esc(f.servicio) + '</div>' +
          '<div class="mcCompactFecha">👤 ' + esc(f.nombreCliente || "Sin registrar") + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mcCompactCell"><span class="mcBadge ' + e + '">' + esc(etiquetaEstado(e)) + '</span>' + chipsExtra(f, true) + '</div>' +
      '<div class="mcCompactCell"><div class="mcCompactPrecio">' +
        '<span class="usd">' + fmt(f.precio) + '</span><span class="pen">' + fmtPEN(f.precio) + '</span></div></div>' +
      '<div class="mcCompactCell"><strong>' + (reemb ? "—" : esc(fechaCorta(f.fechaExpira))) + '</strong></div>' +
      '<div class="mcCompactCell">' + (reemb
        ? '<span class="mcCompactTiempo reembolsada">Saldo devuelto</span>'
        : '<span class="mcCompactTiempo ' + e + '" data-expira="' + f.fechaExpira + '">' + esc(tiempoRestante(f.fechaExpira)) + '</span>') +
      '</div>' +
      '<div class="mcCompactAcciones">' +
        botonVer(f, true) +
        '<button type="button" class="mcBtnRenovar ' + (rn ? "activo" : "") + '" data-k="' + esc(k) + '" ' + (rn ? "" : "disabled") + '>🔄 Renovar</button>' +
        '<button type="button" class="mcBtnSoporte" data-k="' + esc(k) + '" title="Soporte">🎧</button>' +
        botonReembolso(f) +
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

function avisosModalHTML(f){
  const av = [];

  if (f.reemplazada){
    av.push('<div class="mcModalAviso reemplazo"><strong>🔄 Cuenta reemplazada</strong>' +
      '<span>El proveedor te entregó una cuenta nueva' + (f.fechaCambio ? " el " + esc(fechaCorta(f.fechaCambio)) : "") +
      '. Los datos que ves abajo ya son los nuevos; deja de usar los anteriores.</span></div>');
  } else if (f.datosActualizados){
    av.push('<div class="mcModalAviso actualizado"><strong>🔑 Datos actualizados</strong>' +
      '<span>El proveedor cambió la contraseña o el perfil' + (f.fechaCambio ? " el " + esc(fechaCorta(f.fechaCambio)) : "") +
      '. Usa los datos que ves abajo.</span></div>');
  }

  if (f.renov.aceptadas > 0){
    av.push('<div class="mcModalAviso renovada"><strong>🔁 Cuenta renovada</strong>' +
      '<span>Renovada ' + f.renov.aceptadas + (f.renov.aceptadas === 1 ? " vez" : " veces") +
      (f.renov.ultimaFecha ? " · última el " + esc(fechaCorta(f.renov.ultimaFecha)) : "") +
      '. Nueva fecha de vencimiento: ' + esc(fechaCorta(f.fechaExpira)) + '.</span></div>');
  }
  if (f.renov.pendientes > 0){
    av.push('<div class="mcModalAviso pendiente"><strong>⏳ Renovación en proceso</strong>' +
      '<span>Ya pagaste la renovación. El proveedor está extendiendo tu acceso.</span></div>');
  }

  if (f.reembolso === "pendiente"){
    av.push('<div class="mcModalAviso pendiente"><strong>↩️ Reembolso en revisión</strong>' +
      '<span>El proveedor está revisando tu solicitud. Te avisaremos aquí mismo.</span></div>');
  } else if (f.reembolso === "rechazado"){
    const m = f.reembolsoInfo && f.reembolsoInfo.motivoRechazo;
    av.push('<div class="mcModalAviso rechazado"><strong>✕ Reembolso rechazado</strong>' +
      '<span>' + (m ? "Motivo del proveedor: " + esc(m) : "El proveedor rechazó la solicitud.") +
      ' Si el problema continúa, puedes contactar a soporte o enviar una nueva solicitud.</span></div>');
  }

  return av.join("");
}

function abrirModal(k){
  const f = buscarFila(k);
  if (!f) return;

  if (f.reembolso === "aprobado"){
    toast("Este acceso fue reembolsado: el saldo ya volvió a tu cuenta y los datos ya no están disponibles.");
    return;
  }

  pintarModal(f, false);
  mcEl("mcModalCuenta").style.display = "flex";
}

/* refresco=true → solo actualiza datos sin tocar la edición de la nota */
function pintarModal(f, refresco){
  mcFilaModal = f;
  const e = obtenerEstado(f);

  mcEl("mcModalImagen").src = f.imagen || "";
  mcEl("mcModalServicio").textContent = f.servicio;

  const badge = mcEl("mcModalEstadoBadge");
  badge.textContent = etiquetaEstado(e);
  badge.className = "mcBadge " + e;

  const avisos = mcEl("mcModalAvisos");
  if (avisos) avisos.innerHTML = avisosModalHTML(f);

  mcEl("mcModalCorreo").textContent = f.correo || "-";
  mcEl("mcModalClave").textContent  = f.clave  || "-";
  mcEl("mcModalPerfil").textContent = f.perfil || "-";
  mcEl("mcModalPin").textContent    = f.pin    || "-";
  mcEl("mcModalVence").textContent  = fechaCorta(f.fechaExpira) + " · " + tiempoRestante(f.fechaExpira);
  mcEl("mcModalProveedor").textContent = f.proveedor;

  if (!refresco) clienteModoVista(f.nombreCliente);

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
    btnReemb.title = ok ? "" : motivoSinReembolso(f);
    btnReemb.textContent =
      f.reembolso === "pendiente" ? "↩️ Reembolso en revisión" :
      f.aplicaReembolso === "no"  ? "↩️ Sin reembolso" :
      !ok                          ? "↩️ Acceso vencido" :
                                     "↩️ Solicitar reembolso";
  }
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
  i.style.display = "block";
  mcEl("mcBtnGuardarCliente").style.display = "inline-block";
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

function mostrarErrorMotivo(texto, campo){
  const err = mcEl("mcConfirmMotivoError");
  if (err){ err.textContent = texto; err.classList.add("show"); }
  if (campo){ campo.classList.add("error"); campo.focus(); }
}

function limpiarErrorMotivo(){
  const err = mcEl("mcConfirmMotivoError");
  if (err) err.classList.remove("show");
  const t = mcEl("mcConfirmMotivo");     if (t) t.classList.remove("error");
  const s = mcEl("mcConfirmMotivoTipo"); if (s) s.classList.remove("error");
}

function abrirConfirm(opts){
  mcEl("mcConfirmIcono").textContent = opts.icono || "❓";
  mcEl("mcConfirmTitulo").textContent = opts.titulo || "Confirmar";
  mcEl("mcConfirmTexto").textContent = opts.texto || "";
  mcEl("mcConfirmAceptar").textContent = opts.aceptar || "Confirmar";

  mcEl("mcConfirmCampo").style.display = opts.pedirMotivo ? "block" : "none";

  mcEl("mcConfirmMotivo").value = "";
  const tipo = mcEl("mcConfirmMotivoTipo");
  if (tipo) tipo.value = "";
  limpiarErrorMotivo();

  mcAccionPendiente = opts.accion || null;
  mcEl("mcConfirm").classList.add("show");
}

function cerrarConfirm(){
  mcEl("mcConfirm").classList.remove("show");
  mcAccionPendiente = null;
}

/* =========================================================
   RENOVACIÓN
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

  updates["renovaciones/" + renId] = {
    clienteId:       mcUid,
    clienteNombre:   mcPerfil.nombre,
    proveedorId:     f.proveedorId,
    proveedorNombre: f.proveedor,
    productoId:      f.productoId,
    productoNombre:  f.servicio,
    cuentaId:        f.cuentaId,
    compraId:        f.compraId,
    montoUsd:        monto,
    duracionDias:    f.duracionDias,
    estado:          "pendiente",
    fecha:           ahora
  };

  updates["usuarios/" + mcUid + "/saldoUsd"] = red(saldoReal - monto);
  updates["movimientosSaldo/" + mcUid + "/" + movCli] = {
    tipo: "compra",
    detalle: "Renovación · " + f.servicio,
    montoUsd: monto, signo: "-", fecha: ahora
  };

  updates["movimientosSaldo/" + f.proveedorId + "/" + movProv] = {
    tipo: "venta",
    detalle: "Renovación · " + f.servicio + " · " + mcPerfil.nombre,
    montoUsd: monto, signo: "+", fecha: ahora
  };

  try {
    await mcDb.ref().update(updates);

    try {
      await mcDb.ref("usuarios/" + f.proveedorId + "/saldoUsd").transaction(a => red(num(a) + monto));
    } catch(e){ console.error("No se pudo acreditar al proveedor:", e); }

    toast("🔄 Renovación solicitada. El proveedor la confirmará pronto.");
  } catch(err){
    console.error(err);
    toast("No se pudo procesar la renovación: " + (err.message || ""));
  }
}

/* =========================================================
   REEMBOLSO — crea la solicitud que ve el proveedor
========================================================= */

function pedirReembolso(){
  const f = mcFilaModal;
  if (!f) return;
  const motivoNo = motivoSinReembolso(f);
  if (motivoNo){ toast(motivoNo); return; }

  const dias = diasRestantesDe(f);

  abrirConfirm({
    icono: "↩️",
    titulo: "Solicitar reembolso",
    texto: "Se enviará tu solicitud al proveedor " + f.proveedor + " por " + fmt(f.precio) + " (" + fmtPEN(f.precio) +
           ") del acceso \"" + f.servicio + "\". Te quedan " + dias + " día(s) de vigencia. " +
           "Elige el motivo y explica qué pasó para que pueda revisarlo.",
    aceptar: "Enviar solicitud",
    pedirMotivo: true,
    accion: { tipo: "reembolso", fila: f }
  });
}

function pedirReembolsoDesdeFila(k){
  const f = buscarFila(k);
  if (!f) return;

  const motivoNo = motivoSinReembolso(f);
  if (motivoNo){ toast(motivoNo); return; }

  mcFilaModal = f;
  pedirReembolso();
}

async function ejecutarReembolso(f, tipo, motivo){
  const detalle = String(motivo || "").trim();
  if (!MC_MOTIVOS_REEMBOLSO[tipo] || detalle.length < 8){
    toast("Elige un motivo y explica con un poco más de detalle.");
    return;
  }

  /* Revalidación por si cambió el estado mientras escribía */
  const motivoNo = motivoSinReembolso(f);
  if (motivoNo){ toast(motivoNo); return; }

  try {
    await mcDb.ref("reembolsos").push({
      clienteId:       mcUid,
      clienteNombre:   mcPerfil.nombre,
      proveedorId:     f.proveedorId || "",
      proveedorNombre: f.proveedor || "",
      productoId:      f.productoId || "",
      productoNombre:  f.servicio,
      cuentaId:        f.cuentaId || "",
      compraId:        f.compraId,
      montoUsd:        red(f.precio),
      motivoTipo:      tipo,
      motivoTitulo:    MC_MOTIVOS_REEMBOLSO[tipo],
      motivo:          detalle.slice(0, 380),
      cuentaCorreo:    f.correo || "",
      cuentaPerfil:    f.perfil || "",
      diasRestantes:   diasRestantesDe(f),
      fechaCompra:     f.fechaCompra,
      fechaExpira:     f.fechaExpira,
      estado:          "pendiente",
      fecha:           Date.now()
    });

    toast("↩️ Solicitud enviada al proveedor. Verás la respuesta aquí mismo.");
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
  const numero = numeroSoporte(f.proveedorId);
  const txt = encodeURIComponent(
    "Hola, necesito soporte con mi compra en NovaStream:\n" +
    "Producto: " + f.servicio + "\n" +
    "Cuenta: " + (f.reembolso === "aprobado" ? "(reembolsada)" : (f.correo || "-"))
  );
  window.open("https://wa.me/" + numero + "?text=" + txt, "_blank");
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

  /* Drawer */
  try {
    const btnMenu = mcEl("btnMenuMovil");
    const overlay = mcEl("nsDrawerOverlay");
    const btnClose = mcEl("btnCerrarDrawer");
    const salir = mcEl("linkSalirDrawer");

    if (btnMenu && overlay) btnMenu.addEventListener("click", () => overlay.classList.add("activo"));
    if (btnClose && overlay) btnClose.addEventListener("click", () => overlay.classList.remove("activo"));
    if (overlay) overlay.addEventListener("click", e => { if (e.target.id === "nsDrawerOverlay") overlay.classList.remove("activo"); });
    if (salir) salir.addEventListener("click", e => { e.preventDefault(); mcCerrarSesion(); });
  } catch(err){ console.error("Drawer:", err); }

  /* Menú de usuario en escritorio */
  try {
    const btnUserMenu = mcEl("btnUserMenu");
    const userMenuWrap = mcEl("nsUserMenu");

    if (btnUserMenu && userMenuWrap){
      btnUserMenu.addEventListener("click", (e) => {
        e.stopPropagation();
        const abierto = userMenuWrap.classList.toggle("abierto");
        btnUserMenu.setAttribute("aria-expanded", abierto ? "true" : "false");
      });

      document.addEventListener("click", (e) => {
        if (!userMenuWrap.contains(e.target)){
          userMenuWrap.classList.remove("abierto");
          btnUserMenu.setAttribute("aria-expanded", "false");
        }
      });
    }

    const btnCerrarSesionDesktop = mcEl("btnCerrarSesionDesktop");
    if (btnCerrarSesionDesktop){
      btnCerrarSesionDesktop.addEventListener("click", (e) => { e.preventDefault(); mcCerrarSesion(); });
    }
  } catch(err){ console.error("Menú de usuario:", err); }

  ajustarAlturaNav();
  aplicarVista(vistaPorDispositivo());
  setInterval(actualizarContadores, 1000);

  /* Vista: el switch cambia solo durante esta visita */
  document.querySelectorAll(".mcVistaBtn").forEach(b => {
    b.addEventListener("click", function(){ aplicarVista(this.dataset.vista); renderCompras(); });
  });

  /* Si se pasa de celular a PC (o al revés) se vuelve a la vista por defecto */
  let eraMovil = esMovil();
  window.addEventListener("resize", () => {
    const ahora = esMovil();
    if (ahora !== eraMovil){ eraMovil = ahora; aplicarVista(vistaPorDispositivo()); renderCompras(); }
  });

  /* Filtros */
  mcEl("buscadorCompras").addEventListener("input", function(){ filtroTexto = this.value; renderCompras(); });
  mcEl("filtroEstado").addEventListener("change", function(){ filtroEstado = this.value; renderCompras(); });

  /* Modal */
  mcEl("mcCerrarModalCuenta").addEventListener("click", cerrarModal);
  mcEl("mcModalCuenta").addEventListener("click", e => { if (e.target.id === "mcModalCuenta") cerrarModal(); });

  document.querySelectorAll(".mcBtnCopiar[data-copy-target]").forEach(btn => {
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
    const motivoInput = mcEl("mcConfirmMotivo");
    const tipoInput = mcEl("mcConfirmMotivoTipo");
    const motivo = motivoInput ? motivoInput.value : "";
    const tipo = tipoInput ? tipoInput.value : "";

    /* Validación ANTES de cerrar: el modal queda abierto si falta algo */
    if (a && a.tipo === "reembolso"){
      if (!MC_MOTIVOS_REEMBOLSO[tipo]){
        mostrarErrorMotivo("Elige el motivo principal del reembolso.", tipoInput);
        return;
      }
      if (motivo.trim().length < 8){
        mostrarErrorMotivo("Describe el problema con un poco más de detalle (mínimo 8 caracteres).", motivoInput);
        return;
      }
    }

    cerrarConfirm();
    if (!a) return;

    if (a.tipo === "renovar")   await ejecutarRenovacion(a.fila);
    if (a.tipo === "reembolso") await ejecutarReembolso(a.fila, tipo, motivo);
  });

  ["mcConfirmMotivo", "mcConfirmMotivoTipo"].forEach(id => {
    const el = mcEl(id);
    if (el) el.addEventListener(id === "mcConfirmMotivo" ? "input" : "change", limpiarErrorMotivo);
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape"){
      cerrarModal();
      cerrarConfirm();
      const o = mcEl("nsDrawerOverlay");
      if (o) o.classList.remove("activo");
      const um = mcEl("nsUserMenu");
      const bm = mcEl("btnUserMenu");
      if (um) um.classList.remove("abierto");
      if (bm) bm.setAttribute("aria-expanded", "false");
    }
  });

  mcInit();

  setTimeout(() => mcIntentarOcultarBooting(true), 6000);
});
