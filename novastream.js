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

const NS_LOGIN_URL = "login.html";
const NS_REGISTRO_URL = "registro.html";
const TIPO_CAMBIO = 3.40;
const NS_WHATSAPP_FALLBACK = "51900000000";
const NS_WHATSAPP_IMPULSO = "51916252754";

/* =========================
   ESTADO
========================= */

let productosCache = {};
let proveedoresCache = {};
let categoriasCache = {};   // categorías reales creadas por el admin (/categorias)

let filtroCategoria = "todos";
let filtroBusqueda = "";
let filtroFavoritosActivo = false;

let nsAuth = null, nsDb = null;
let nsUid = null;
let nsUsuario = { nombre: "Invitado", correo: "", rol: "cliente", saldoUsd: 0 };

let nsFbActivo = false;
let nsProductosListos = false;
let nsSesionListo = false;
let nsProcesandoPago = false;
let nsRefUsuario = null;      // referencia activa al perfil (para desuscribir)

/* =========================
   HELPERS
========================= */

function fmt(v){ return "$" + Number(v || 0).toFixed(2); }
function fmtPEN(v){ return "S/ " + (Number(v || 0) * TIPO_CAMBIO).toFixed(2); }

/* 365 → "1 año", 30 → "1 mes", 90 → "3 meses"... si no calza
   exacto en años/meses, se muestra en días. */
function formatDuracion(dias){
  const d = Number(dias || 0);
  if (d <= 0) return "Entrega digital";
  if (d >= 3650) return "Acceso permanente";
  if (d % 365 === 0) { const y = d / 365; return y + (y === 1 ? " año" : " años"); }
  if (d % 30 === 0)  { const m = d / 30;  return m + (m === 1 ? " mes" : " meses"); }
  return d + " días";
}
function escaparHTML(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/* normaliza texto (minúsculas + sin tildes) para poder
   comparar "Netflix", "netflix", "NETFLIX", "Nétflix", etc. como
   la misma categoría, sin importar cómo lo haya escrito el
   proveedor o el administrador. */
function normalizarTexto(valor){
  return String(valor || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function esInvitado(){ return !nsUid; }

function toast(msg){
  const el = document.getElementById("toastAviso");
  if (!el) return;
  el.classList.remove("nsToastClicable");
  el.onclick = null;
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("visible"), 2800);
}

function toastCarritoAgregado(nombre){
  const el = document.getElementById("toastAviso");
  if (!el) return;

  el.innerHTML =
    '<span class="nsToastMain">Añadido: ' + escaparHTML(nombre) + '</span>' +
    '<span class="nsToastCTA">Ver carrito →</span>';

  el.classList.add("visible", "nsToastClicable");

  el.onclick = function(){
    abrirCarrito();
    el.classList.remove("visible", "nsToastClicable");
    el.onclick = null;
  };

  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.classList.remove("visible", "nsToastClicable");
    el.onclick = null;
  }, 3200);
}

/* =========================================================
   PANTALLA "VERIFICANDO SESIÓN..."   ⭐ NUEVO (v8)
   Solo se oculta cuando la sesión YA se resolvió (nsSesionListo)
   Y el catálogo YA se pintó (nsProductosListos) — nunca antes,
   para que el saldo/nombre/carrito no "salten" a medio cargar.
   Con forzar=true se ignora la condición (usado en errores y en
   la red de seguridad, para que el loader nunca se quede colgado).
========================================================= */

function nsIntentarOcultarBooting(forzar){
  if (!forzar && (!nsSesionListo || !nsProductosListos)) return;
  const el = document.getElementById("nsBooting");
  if (el) el.classList.add("off");
}

/* =========================
   MODO DE SESIÓN (visitante / cliente)
========================= */

function nsAplicarModoSesion(){
  const body = document.body;

  body.classList.remove("nsSesionCargando");
  body.classList.toggle("nsInvitado", esInvitado());
  body.classList.toggle("nsAutenticado", !esInvitado());

  nsSesionListo = true;

  pintarSaldo();
  pintarDrawerUsuario();
  pintarUserMenu();
  actualizarBadgeCarrito();
  nsIntentarOcultarBooting();

  /* Si quedó el menú de usuario abierto y se cerró sesión, lo colapsamos */
  if (esInvitado()) {
    const menuWrap = document.getElementById("nsUserMenu");
    if (menuWrap) menuWrap.classList.remove("abierto");
  }

  /* Los botones de las tarjetas cambian según el estado */
  if (nsProductosListos) renderizarProductos();

  /* Al cerrar sesión no dejamos un carrito colgando */
  if (esInvitado()) {
    cerrarCarrito();
    setCarrito([]);
  }

  /* Recalcula la altura del navbar: el botón "Ingresar" cambia el alto */
  ajustarAlturaNav();
}

function pintarSaldo(){
  const el = document.getElementById("saldoUsuario");
  const elPen = document.getElementById("saldoUsuarioPen");
  if (el) el.textContent = fmt(nsUsuario.saldoUsd);
  if (elPen) elPen.textContent = fmtPEN(nsUsuario.saldoUsd);
}

function pintarDrawerUsuario(){
  const nombre = document.getElementById("drawerNombre");
  const saldo = document.getElementById("drawerSaldo");
  const avatar = document.getElementById("drawerAvatar");

  if (esInvitado()) return;

  if (nombre) nombre.textContent = nsUsuario.nombre;
  if (saldo) saldo.textContent = fmt(nsUsuario.saldoUsd) + " · " + fmtPEN(nsUsuario.saldoUsd);
  if (avatar) avatar.textContent = String(nsUsuario.nombre || "N").trim().charAt(0).toUpperCase();
}

/* Menú de usuario en escritorio: nombre, avatar, correo y saldo */
function pintarUserMenu(){
  if (esInvitado()) return;

  const inicial = String(nsUsuario.nombre || "N").trim().charAt(0).toUpperCase();

  const avatarChip = document.getElementById("nsUserAvatarChip");
  const avatarDrop = document.getElementById("nsUserAvatarDropdown");
  const nombreChip = document.getElementById("nsUserNombreChip");
  const nombreDrop = document.getElementById("nsUserNombreDropdown");
  const correoDrop = document.getElementById("nsUserCorreoDropdown");
  const saldoDrop  = document.getElementById("nsUserDropdownSaldoValor");

  if (avatarChip) avatarChip.textContent = inicial;
  if (avatarDrop) avatarDrop.textContent = inicial;
  if (nombreChip) nombreChip.textContent = nsUsuario.nombre;
  if (nombreDrop) nombreDrop.textContent = nsUsuario.nombre;
  if (correoDrop) correoDrop.textContent = nsUsuario.correo || "";
  if (saldoDrop) saldoDrop.textContent = fmt(nsUsuario.saldoUsd);
}

/* =========================
   CERRAR SESIÓN (usado por el drawer móvil y el menú de escritorio)
========================= */

async function cerrarSesionUsuario(){
  cerrarDrawer();

  const menuWrap = document.getElementById("nsUserMenu");
  const btnMenu = document.getElementById("btnUserMenu");
  if (menuWrap) menuWrap.classList.remove("abierto");
  if (btnMenu) btnMenu.setAttribute("aria-expanded", "false");

  if (nsFbActivo && nsAuth && nsUid) {
    try { await nsAuth.signOut(); } catch (e) {}
    setCarrito([]);
    toast("Sesión cerrada. Sigues viendo el catálogo como invitado.");
  } else {
    window.location.href = NS_LOGIN_URL;
  }
}

/* =========================
   MODAL "NECESITAS CUENTA"
========================= */

function abrirModalAuth(productoId){
  const modal = document.getElementById("nsAuthModal");
  if (!modal) { window.location.href = NS_REGISTRO_URL; return; }

  const box = document.getElementById("nsAuthProducto");
  const texto = document.getElementById("nsAuthModalText");
  const item = productoId ? productosCache[productoId] : null;

  if (item && box) {
    document.getElementById("nsAuthProdImg").src = item.imagen || "";
    document.getElementById("nsAuthProdNombre").textContent = item.nombre;
    document.getElementById("nsAuthProdPrecio").textContent = fmt(item.precio) + " · " + fmtPEN(item.precio);
    box.style.display = "flex";

    if (texto) {
      texto.textContent = "Para adquirir este producto necesitas una cuenta con saldo. " +
                          "El registro es gratuito y tu acceso se entrega al instante.";
    }
  } else if (box) {
    box.style.display = "none";
    if (texto) {
      texto.textContent = "Estás explorando como invitado. Para adquirir productos " +
                          "necesitas una cuenta con saldo.";
    }
  }

  modal.classList.add("activo");
}

function cerrarModalAuth(){
  const modal = document.getElementById("nsAuthModal");
  if (modal) modal.classList.remove("activo");
}

/* =========================
   FAVORITOS (localStorage · funcionan sin cuenta)
========================= */

function getFavoritos(){ try{ return JSON.parse(localStorage.getItem("ns_favoritos")||"[]"); }catch(e){ return []; } }
function setFavoritos(a){ try{ localStorage.setItem("ns_favoritos", JSON.stringify(a||[])); }catch(e){} }
function esFavorito(id){ return getFavoritos().includes(id); }

function toggleFavorito(id){
  const favs = getFavoritos();
  const i = favs.indexOf(id);
  if (i >= 0) favs.splice(i,1); else favs.push(id);
  setFavoritos(favs);
  renderizarProductos();
}

/* =========================
   FIREBASE — INIT
========================= */

function nsFbInit(){
  if (typeof firebase === "undefined") {
    console.warn("Firebase SDK no encontrado.");
    mostrarErrorCarga("No se pudo conectar con el servidor. Revisa tu conexión.");
    nsAplicarModoSesion();
    return;
  }

  try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    nsAuth = firebase.auth();
    nsDb = firebase.database();
    nsFbActivo = true;
  } catch (err) {
    console.error("Error iniciando Firebase:", err);
    mostrarErrorCarga("Error de conexión con el servidor.");
    nsAplicarModoSesion();
    return;
  }

  /* El catálogo se carga siempre, con o sin sesión */
  nsEscucharCatalogo();
  nsEscucharProveedores();
  nsEscucharCategorias();   // categorías reales del admin

  nsAuth.onAuthStateChanged((user) => {

    /* Se limpia la escucha anterior del perfil */
    if (nsRefUsuario) { try { nsRefUsuario.off(); } catch (e) {} nsRefUsuario = null; }

    if (!user) {
      nsUid = null;
      nsUsuario = { nombre: "Invitado", correo: "", rol: "cliente", saldoUsd: 0 };
      nsAplicarModoSesion();
      return;
    }

    nsUid = user.uid;
    nsRefUsuario = nsDb.ref("usuarios/" + nsUid);

    nsRefUsuario.on("value", (snap) => {
      const d = snap.val() || {};

      /* Cuenta bloqueada: se cierra la sesión y vuelve a modo invitado */
      if (String(d.estado || "activo").toLowerCase() === "bloqueado") {
        toast("Tu cuenta está bloqueada. Contacta con soporte.");
        setTimeout(() => { try { nsAuth.signOut(); } catch (e) {} }, 1800);
        return;
      }

      nsUsuario = {
        nombre: d.nombre || user.email || "Cliente",
        correo: d.correo || user.email || "",
        rol: d.rol || "cliente",
        saldoUsd: Number(d.saldoUsd || 0)
      };

      nsAplicarModoSesion();
    }, (err) => {
      console.error("Error leyendo perfil:", err);
      nsAplicarModoSesion();
    });
  });
}

function mostrarErrorCarga(msg){
  const cont = document.getElementById("contenedorProductos");
  const cats = document.getElementById("categoriasBox");
  const info = document.getElementById("resultadoFiltroInfo");
  if (cont) cont.innerHTML = '<div class="nsCargando">' + escaparHTML(msg) + '</div>';
  if (cats) cats.innerHTML = "";
  if (info) info.textContent = "";
  nsIntentarOcultarBooting(true); // error: no dejar el loader colgado
}

/* =========================
   FIREBASE — CATÁLOGO EN VIVO
========================= */

function nsEscucharCatalogo(){
  nsDb.ref("productos").on("value", (snap) => {
    const nuevo = {};

    snap.forEach(ch => {
      const p = ch.val() || {};
      if (p.activo === false) return;
      if (!p.nombre) return;

      const ilimitado = p.stockIlimitado === true || p.tipoEntrega === "descarga";
      const stockNum = Number(p.stock || 0);

      nuevo[ch.key] = {
        id: ch.key,
        nombre: p.nombre,
        plataforma: p.plataforma || p.categoria || "Otros",
        categoria: p.categoria || "streaming",
        precio: Number(p.precioUsd || 0),
        duracionDias: Number(p.duracionDias || 30),
        stock: ilimitado ? "Ilimitado" : stockNum,
        stockIlimitado: ilimitado,
        descripcion: p.descripcion || "Sin descripción disponible.",
        reglas: p.reglas || "",
        imagen: p.imagen || "img/productos/log.jpg",
        proveedor: p.proveedorNombre || "NovaStream",
        proveedorId: p.proveedorId || "",
        tipoEntrega: p.tipoEntrega || "cuenta",
        modoEntrega: p.modoEntrega || "automatico",
        aplicaReembolso: p.aplicaReembolso || "si",
        esRenovable: p.esRenovable !== false   // por defecto true salvo que sea explícitamente false
      };
    });

    productosCache = nuevo;
    nsProductosListos = true;

    limpiarCarritoDeProductosInexistentes();
    renderizarCategorias();
    renderizarProductos();
    renderizarCarrito();
    actualizarBadgeCarrito();
    nsIntentarOcultarBooting();
  }, (err) => {
    console.error(err);
    mostrarErrorCarga("No se pudo cargar el catálogo.");
  });
}

function nsEscucharProveedores(){
  nsDb.ref("proveedoresPublicos").on("value", (snap) => {
    proveedoresCache = snap.val() || {};
    actualizarEnlaceSoporte();
  });
}

/* Escucha en vivo el nodo /categorias que se administra desde el
   panel admin (novaadmin.html → sección Categorías). Esto es lo
   que trae el LOGO oficial de cada plataforma (Netflix, Spotify,
   etc.) para mostrarlo en el catálogo público. */
function nsEscucharCategorias(){
  nsDb.ref("categorias").on("value", (snap) => {
    categoriasCache = snap.val() || {};
    renderizarCategorias();
    }, (err) => {
    console.error("categorias:", err && err.message);
    categoriasCache = {};
    renderizarCategorias();
  });
}

function limpiarCarritoDeProductosInexistentes(){
  const carrito = getCarrito();
  const limpio = carrito.filter(l => productosCache[l.id]);
  if (limpio.length !== carrito.length) setCarrito(limpio);
}

/* =========================================================
   CATEGORÍAS DINÁMICAS
   Se arman con las categorías REALES creadas por el
   administrador (nombre + logo oficial subido en su panel),
   y cada botón agrupa todos los productos cuya "plataforma" haga
   match con esa categoría (sin importar mayúsculas/tildes). Si un
   proveedor escribió una plataforma que el admin no ha creado
   todavía como categoría oficial, igual se muestra (usando la
   imagen del producto) para que nada quede oculto.
========================================================= */

function renderizarCategorias(){
  const cont = document.getElementById("categoriasBox");
  if (!cont) return;

  if (!nsProductosListos) {
    cont.innerHTML = '<div class="nsCargando">Cargando categorías...</div>';
    return;
  }

  const mapaCategorias = new Map();

  Object.values(categoriasCache || {}).forEach(cat => {
    if (!cat || !cat.nombre) return;
    const key = normalizarTexto(cat.nombre);
    if (!key) return;
    mapaCategorias.set(key, {
      nombre: cat.nombre,
      imagen: cat.imagen || "",
      orden: Number(cat.orden) || null
    });
  });

  Object.keys(productosCache).forEach(id => {
    const item = productosCache[id];
    const key = normalizarTexto(item.plataforma);
    if (!key || mapaCategorias.has(key)) return;
    mapaCategorias.set(key, { nombre: item.plataforma, imagen: item.imagen, orden: null });
  });

  if (!mapaCategorias.size) { cont.innerHTML = ""; return; }

  let html = `<button type="button" class="nsCatBtn${filtroCategoria === "todos" ? " activo" : ""}" data-categoria="todos">Todos</button>`;

  Array.from(mapaCategorias.values())
    .sort((a, b) => {
      const oa = a.orden || 9999;
      const ob = b.orden || 9999;
      if (oa !== ob) return oa - ob;
      return a.nombre.localeCompare(b.nombre);
    })
    .forEach(cat => {
      const activo = normalizarTexto(filtroCategoria) === normalizarTexto(cat.nombre) ? " activo" : "";
      html += `
        <button type="button" class="nsCatBtn nsCatBtnFoto${activo}" data-categoria="${escaparHTML(cat.nombre)}">
          <span class="nsCatAvatar"><img src="${escaparHTML(cat.imagen)}" alt="${escaparHTML(cat.nombre)}" onerror="this.style.opacity=0"></span>
          <span>${escaparHTML(cat.nombre)}</span>
        </button>`;
    });

  cont.innerHTML = html;

  nsInicializarFlechasCategorias();   // ⭐ AQUÍ VA, justo después de pintar el HTML

  cont.querySelectorAll(".nsCatBtn").forEach(btn => {
    btn.addEventListener("click", function(){
      filtroCategoria = this.dataset.categoria;
      cont.querySelectorAll(".nsCatBtn").forEach(b => b.classList.remove("activo"));
      this.classList.add("activo");
      renderizarProductos();
    });
  });
}

function actualizarFlechasCategorias(){
  const cont = document.getElementById("categoriasBox");
  const wrap = document.getElementById("categoriasWrap");
  const btnL = document.getElementById("catArrowLeft");
  const btnR = document.getElementById("catArrowRight");
  if (!cont || !wrap || !btnL || !btnR) return;

  const desbordado = cont.scrollWidth > cont.clientWidth + 4;
  wrap.classList.toggle("nsSinDesborde", !desbordado);

  const alInicio = cont.scrollLeft <= 4;
  const alFinal = cont.scrollLeft >= cont.scrollWidth - cont.clientWidth - 4;

  wrap.classList.toggle("at-start", alInicio);
  wrap.classList.toggle("at-end", alFinal);

  btnL.disabled = alInicio;
  btnR.disabled = alFinal;
}

function nsInicializarFlechasCategorias(){
  const cont = document.getElementById("categoriasBox");
  const btnL = document.getElementById("catArrowLeft");
  const btnR = document.getElementById("catArrowRight");
  if (!cont || !btnL || !btnR) return;

  if (!cont.dataset.flechasOk) {
    cont.addEventListener("scroll", actualizarFlechasCategorias);
    btnL.addEventListener("click", () => cont.scrollBy({ left: -240, behavior: "smooth" }));
    btnR.addEventListener("click", () => cont.scrollBy({ left: 240, behavior: "smooth" }));
    window.addEventListener("resize", actualizarFlechasCategorias);
    cont.dataset.flechasOk = "1";
  }

  actualizarFlechasCategorias();
}

/* =========================
   RENDER PRODUCTOS
========================= */

function productoCoincide(id, item){
  /* comparación de categoría normalizada (sin
     mayúsculas/tildes) para que "Netflix" agrupe todos los
     productos de esa plataforma sin importar cómo se escribieron. */
  const cat = filtroCategoria === "todos" || normalizarTexto(item.plataforma) === normalizarTexto(filtroCategoria);

  const q = (filtroBusqueda || "").toLowerCase().trim();
  const busq = !q
    || (item.nombre || "").toLowerCase().includes(q)
    || (item.plataforma || "").toLowerCase().includes(q)
    || (item.proveedor || "").toLowerCase().includes(q);

  const fav = !filtroFavoritosActivo || esFavorito(id);
  return cat && busq && fav;
}

/* Genera el HTML de los badges de entrega/reembolso/renovación según
   lo que configuró el proveedor en su panel (modoEntrega /
   aplicaReembolso / esRenovable) */
function badgeEntregaHTML(item){
  const esManual = item.modoEntrega === "manual";
  const claseEntrega = esManual ? "manual" : "automatico";
  const txtEntrega = esManual ? "🕒 Entrega manual" : "⚡ Entrega automática";
  return '<span class="nsBadgeEntrega ' + claseEntrega + '">' + txtEntrega + '</span>';
}

function badgeRenovableHTML(item){
  const esRenovable = item.esRenovable !== false;
  const claseRenovable = esRenovable ? "si" : "no";
  const txtRenovable = esRenovable ? "🔁 Renovable" : "⛔ No renovable";
  return '<span class="nsBadgeRenovable ' + claseRenovable + '">' + txtRenovable + '</span>';
}

/* Pill con texto completo en la esquina de la imagen, en espejo
   con el botón de favorito (esquina superior derecha). */
function iconoRenovableCorner(item){
  const esRenovable = item.esRenovable !== false;
  const clase = esRenovable ? "si" : "no";
  const icono = esRenovable ? "🔁" : "⛔";
  const texto = esRenovable ? "Renovable" : "No renovable";
  return '<span class="nsRenovableCorner ' + clase + '">' + icono + ' ' + texto + '</span>';
}

function renderizarProductos(){
  const cont = document.getElementById("contenedorProductos");
  const info = document.getElementById("resultadoFiltroInfo");
  if (!cont) return;

  if (!nsProductosListos) {
    cont.innerHTML = '<div class="nsCargando">Cargando productos...</div>';
    if (info) info.textContent = "Conectando con el catálogo...";
    return;
  }

  const todosIds = Object.keys(productosCache);
  const ids = todosIds.filter(id => productoCoincide(id, productosCache[id]));

  if (info) {
    info.textContent = (ids.length === todosIds.length && !filtroFavoritosActivo)
      ? "Mostrando todos los productos (" + todosIds.length + ")"
      : "Mostrando " + ids.length + " de " + todosIds.length + " productos";
  }

  if (!todosIds.length) {
    cont.innerHTML = '<div class="nsCargando">Todavía no hay productos publicados. Vuelve pronto.</div>';
    return;
  }

  if (!ids.length) {
    cont.innerHTML = '<div class="nsCargando">' + (filtroFavoritosActivo ? "Aún no tienes favoritos." : "No se encontraron productos.") + '</div>';
    return;
  }

  /* Los productos con stock van primero */
  ids.sort((a, b) => {
    const A = productosCache[a], B = productosCache[b];
    const agotA = !A.stockIlimitado && Number(A.stock||0) <= 0 ? 1 : 0;
    const agotB = !B.stockIlimitado && Number(B.stock||0) <= 0 ? 1 : 0;
    if (agotA !== agotB) return agotA - agotB;
    return (A.nombre||"").localeCompare(B.nombre||"");
  });

  const invitado = esInvitado();

  const iconoCandado =
    '<svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="10" rx="2.5"></rect>' +
    '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path></svg>';

  let html = "";

  ids.forEach(id => {
    const item = productosCache[id];
    const ilimitado = item.stockIlimitado;
    const agotado = !ilimitado && Number(item.stock||0) <= 0;
    const stockTxt = ilimitado ? "Ilimitado" : String(item.stock);
    const fav = esFavorito(id);
    const metaIzq = ilimitado ? "Entrega digital" : formatDuracion(item.duracionDias);

    /* El botón de acción cambia según el estado de sesión */
    let botonAccion;

    if (agotado) {
      botonAccion = `<button type="button" class="nsBtnAgregar" disabled>Agotado</button>`;
    } else if (invitado) {
      botonAccion =
        `<button type="button" class="nsBtnAgregar nsBloqueado" data-accion="auth" data-id="${escaparHTML(id)}" title="Necesitas una cuenta para comprar">
          ${iconoCandado}<span>Ingresar</span>
        </button>`;
    } else {
      botonAccion = `<button type="button" class="nsBtnAgregar" data-accion="agregar" data-id="${escaparHTML(id)}">Agregar</button>`;
    }

    html += `
      <div class="nsCard" data-id="${escaparHTML(id)}">
        <div class="nsCardImgWrap">
  <img class="nsCardImg" src="${escaparHTML(item.imagen)}" alt="${escaparHTML(item.nombre)}" onerror="this.style.opacity=0">
  ${iconoRenovableCorner(item)}
  <button type="button" class="nsFavBtn${fav?" activo":""}" data-id="${escaparHTML(id)}" aria-label="Favorito">
            <svg viewBox="0 0 24 24"><polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2"></polygon></svg>
          </button>
        </div>
        <div class="nsCardBody">
          <div class="nsCardProveedor" title="Proveedor verificado">
            <span class="nsProveedorCheck">
              <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </span>
            <span class="nsProveedorTexto">Proveedor: <strong>${escaparHTML(item.proveedor)}</strong></span>
          </div>
          <div class="nsCardTitulo">${escaparHTML(item.nombre)}</div>
          <div class="nsCardMeta">
            <span>${escaparHTML(metaIzq)}</span>
            <span class="nsCardStock">Stock: ${escaparHTML(stockTxt)}</span>
          </div>
          <div class="nsBadgesFila">
  ${badgeEntregaHTML(item)}
</div>
          <div class="nsCardPrecio">
            <span class="nsCardPrecioUsd">${fmt(item.precio)}</span>
            <span class="nsCardPrecioPen">${fmtPEN(item.precio)}</span>
          </div>
          <div class="nsCardBtns">
            <button type="button" class="nsBtnVer" data-id="${escaparHTML(id)}" title="Ver descripción" aria-label="Ver descripción">
              <svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            </button>
            ${botonAccion}
          </div>
        </div>
      </div>`;
  });

  cont.innerHTML = html;

  cont.querySelectorAll(".nsFavBtn").forEach(b => {
    b.addEventListener("click", e => { e.stopPropagation(); toggleFavorito(b.dataset.id); });
  });

  cont.querySelectorAll(".nsBtnVer").forEach(b => {
    b.addEventListener("click", e => { e.stopPropagation(); abrirModal(b.dataset.id); });
  });

  cont.querySelectorAll(".nsBtnAgregar[data-accion]").forEach(b => {
    b.addEventListener("click", e => {
      e.stopPropagation();
      if (b.disabled) return;

      if (b.dataset.accion === "auth") abrirModalAuth(b.dataset.id);
      else agregarAlCarrito(b.dataset.id, 1);
    });
  });

  cont.querySelectorAll(".nsCard").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("button")) return;
      abrirModal(card.dataset.id);
    });
  });
}

/* =========================
   MODAL PRODUCTO
========================= */

function abrirModal(id){
  const item = productosCache[id];
  if (!item) return;

  document.getElementById("modalNombre").innerText = item.nombre;
  document.getElementById("modalImagen").src = item.imagen || "";
  document.getElementById("modalImagen").alt = item.nombre;

  const badgesBox = document.getElementById("modalBadgesFila");
  if (badgesBox) badgesBox.innerHTML = badgeEntregaHTML(item) + badgeRenovableHTML(item);

  document.getElementById("modalDescripcion").innerText = item.descripcion || "Sin descripción disponible.";

  const lista = document.getElementById("listaReglas");
  let reglasHtml = "";

  if (item.reglas) {
    item.reglas.split(/\r?\n|\.\s+/g)
      .map(r => r.trim())
      .filter(r => r.length > 2)
      .forEach(r => { reglasHtml += "<li>" + escaparHTML(r) + "</li>"; });
  }

  reglasHtml +=
    "<li>Uso exclusivo para el comprador salvo que se indique lo contrario.</li>" +
    "<li>No compartir credenciales fuera de lo permitido.</li>" +
    (item.esRenovable === false
      ? "<li>Este producto <strong>no admite renovación</strong> una vez vencido.</li>"
      : "<li>Puedes solicitar la renovación de tu acceso antes o al vencer.</li>") +
    "<li>Reporta cualquier problema por soporte para atención inmediata.</li>";

  lista.innerHTML = reglasHtml;

  document.getElementById("modalCompra").style.display = "flex";
}

function cerrarModal(){
  const m = document.getElementById("modalCompra");
  if (m) m.style.display = "none";
}

/* =========================
   CARRITO
========================= */

function getCarrito(){ try{ return JSON.parse(localStorage.getItem("ns_carrito")||"[]"); }catch(e){ return []; } }
function setCarrito(a){ try{ localStorage.setItem("ns_carrito", JSON.stringify(a||[])); }catch(e){} }

function actualizarBadgeCarrito(){
  const badge = document.getElementById("badgeCarrito");
  if (!badge) return;

  const total = esInvitado() ? 0 : getCarrito().reduce((a,c) => a + Number(c.cantidad||0), 0);
  badge.textContent = total > 99 ? "99+" : String(total);
  badge.classList.toggle("visible", total > 0);
}

function stockDisponibleProducto(id){
  const item = productosCache[id];
  if (!item) return 0;
  if (item.stockIlimitado) return 9999;
  return Math.max(0, Number(item.stock || 0));
}

function agregarAlCarrito(id, cantidad){
  if (esInvitado()) { abrirModalAuth(id); return; }

  const item = productosCache[id];
  if (!item) return;

  const carrito = getCarrito();
  const idx = carrito.findIndex(c => c.id === id);
  const enCarrito = idx >= 0 ? Number(carrito[idx].cantidad||0) : 0;
  const disponible = stockDisponibleProducto(id);

  if (enCarrito + cantidad > disponible) {
    toast("Solo quedan " + disponible + " unidad(es) de este producto.");
    return;
  }

  if (idx >= 0) carrito[idx].cantidad = enCarrito + cantidad;
  else carrito.push({ id, cantidad });

  setCarrito(carrito);
  actualizarBadgeCarrito();
  toastCarritoAgregado(item.nombre);
  renderizarCarrito();
}

function cambiarCantidadCarrito(id, delta){
  const carrito = getCarrito();
  const idx = carrito.findIndex(c => c.id === id);
  if (idx < 0) return;

  const nueva = Number(carrito[idx].cantidad||1) + delta;
  if (nueva < 1) { quitarDelCarrito(id); return; }

  if (nueva > stockDisponibleProducto(id)) {
    toast("No hay más stock disponible.");
    return;
  }

  carrito[idx].cantidad = nueva;
  setCarrito(carrito);
  actualizarBadgeCarrito();
  renderizarCarrito();
}

function quitarDelCarrito(id){
  setCarrito(getCarrito().filter(c => c.id !== id));
  actualizarBadgeCarrito();
  renderizarCarrito();
}

function calcularTotalCarrito(){
  let total = 0;
  getCarrito().forEach(l => {
    const item = productosCache[l.id];
    if (item) total += item.precio * Number(l.cantidad||0);
  });
  return Number(total.toFixed(2));
}

function renderizarCarrito(){
  const body = document.getElementById("carritoBody");
  const totalTxt = document.getElementById("carritoTotalTexto");
  const totalPenEl = document.getElementById("carritoTotalPen");
  if (!body) return;

  const carrito = esInvitado() ? [] : getCarrito();

  if (!carrito.length) {
    body.innerHTML = '<div class="nsCartVacio">Tu carrito está vacío.</div>';
    if (totalTxt) totalTxt.textContent = fmt(0);
    if (totalPenEl) totalPenEl.textContent = fmtPEN(0);
    return;
  }

  let total = 0;
  let html = "";

  carrito.forEach(linea => {
    const item = productosCache[linea.id];
    if (!item) return;
    const sub = item.precio * linea.cantidad;
    total += sub;

    html += `
      <div class="nsCartItem" data-id="${escaparHTML(linea.id)}">
        <img class="nsCartItemImg" src="${escaparHTML(item.imagen)}" alt="" onerror="this.style.opacity=0">
        <div class="nsCartItemInfo">
          <div class="nsCartItemNombre">${escaparHTML(item.nombre)}</div>
          <div class="nsCartItemPrecio">${fmt(sub)}<span class="nsCartItemPen">(${fmtPEN(sub)})</span></div>
          <div class="nsCartQty">
            <button type="button" class="btnMenos">-</button>
            <span>${linea.cantidad}</span>
            <button type="button" class="btnMas">+</button>
            <button type="button" class="nsCartRemove">Quitar</button>
          </div>
        </div>
      </div>`;
  });

  body.innerHTML = html;
  if (totalTxt) totalTxt.textContent = fmt(total);
  if (totalPenEl) totalPenEl.textContent = fmtPEN(total);

  body.querySelectorAll(".nsCartItem").forEach(el => {
    const id = el.dataset.id;
    el.querySelector(".btnMas").addEventListener("click", () => cambiarCantidadCarrito(id, 1));
    el.querySelector(".btnMenos").addEventListener("click", () => cambiarCantidadCarrito(id, -1));
    el.querySelector(".nsCartRemove").addEventListener("click", () => quitarDelCarrito(id));
  });
}

function abrirCarrito(){
  if (esInvitado()) { abrirModalAuth(null); return; }
  renderizarCarrito();
  document.getElementById("nsCartOverlay").classList.add("activo");
}

function cerrarCarrito(){
  const o = document.getElementById("nsCartOverlay");
  if (o) o.classList.remove("activo");
}

/* =========================================================
   PAGO / ENTREGA AUTOMÁTICA   (v5.1 · atómico)

   El cobro del saldo va DENTRO del mismo update() que entrega
   las cuentas. Si algo falla, no se aplica nada: el cliente
   nunca se queda con un producto sin pagar.
========================================================= */

async function procesarPago(){
  if (nsProcesandoPago) return;
  if (esInvitado()) { abrirModalAuth(null); return; }

  const carrito = getCarrito();
  if (!carrito.length) { toast("Tu carrito está vacío."); return; }
  if (!nsFbActivo)     { toast("Sin conexión con el servidor."); return; }

  const total = calcularTotalCarrito();
  if (total <= 0) { toast("Total inválido."); return; }

  nsProcesandoPago = true;
  const btn = document.getElementById("btnPagarCarrito");
  const textoOriginal = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Procesando..."; }

  try {

    /* ---- 0. Saldo REAL del servidor (no confiamos en la caché) ---- */
    const snapSaldo = await nsDb.ref("usuarios/" + nsUid + "/saldoUsd").get();
    const saldoReal = Number(snapSaldo.val() || 0);

    if (saldoReal < total) {
      toast("Saldo insuficiente. Te faltan " + fmt(total - saldoReal) + ".");
      setTimeout(() => { window.location.href = "recargas.html"; }, 1600);
      throw new Error("__SALDO__");
    }

    /* ---- 1. Reservar accesos leyendo SOLO los disponibles ---- */
    const entregas = [];

    for (const linea of carrito) {
      const item = productosCache[linea.id];
      if (!item) continue;

      const cantidad = Number(linea.cantidad || 0);
      if (cantidad <= 0) continue;

      if (item.stockIlimitado) {
        entregas.push({ producto: item, cantidad, cuentas: [], stockServidor: null });
        continue;
      }

      /* Query .equalTo('disponible'): nunca leemos credenciales de otros clientes */
      const [snapCuentas, snapStock] = await Promise.all([
        nsDb.ref("cuentas/" + item.id).orderByChild("estado").equalTo("disponible").get(),
        nsDb.ref("productos/" + item.id + "/stock").get()
      ]);

      const todas = snapCuentas.val() || {};
      const claves = Object.keys(todas);

      if (claves.length < cantidad) {
        throw new Error('Se agotó el stock de "' + item.nombre + '". Ajusta tu carrito.');
      }

      const libres = claves.slice(0, cantidad);

      entregas.push({
        producto: item,
        cantidad,
        cuentas: libres.map(k => Object.assign({ id: k }, todas[k])),
        /* Base real: el nuevo stock siempre será MENOR a este valor */
        stockServidor: Math.min(Number(snapStock.val() || 0), claves.length)
      });
    }

    if (!entregas.length) throw new Error("No hay productos válidos en el carrito.");

    /* ---- 2. Un solo update atómico ---- */
    const ahora = Date.now();
    const updates = {};
    const compraId = "cmp_" + ahora + "_" + Math.random().toString(36).slice(2, 6);
    const detalleCompra = [];
    const acreditar = {};

    entregas.forEach(en => {
      const p = en.producto;
      const montoLinea = Number((p.precio * en.cantidad).toFixed(2));

      /* 2a. Marcar cuentas como usadas */
      en.cuentas.forEach(c => {
        const base = "cuentas/" + p.id + "/" + c.id + "/";
        updates[base + "estado"]          = "usada";
        updates[base + "compradorId"]     = nsUid;
        updates[base + "compradorNombre"] = nsUsuario.nombre;
        updates[base + "fechaVenta"]      = ahora;
        updates[base + "renovado"]        = false;
        updates[base + "avisoAtendido"]   = false;
      });

      /* 2b. Descontar stock desde el valor real del servidor */
      if (!p.stockIlimitado) {
        const restante = Math.max(0, en.stockServidor - en.cantidad);
        updates["productos/" + p.id + "/stock"] = restante;
        updates["stock/" + p.id] = restante;
      }

      /* 2c. Una venta por unidad · 100% al proveedor, comisión 0 en venta */
      for (let i = 0; i < en.cantidad; i++) {
        const ventaKey = nsDb.ref("ventas").push().key;
        updates["ventas/" + ventaKey] = {
          proveedorId: p.proveedorId,
          proveedorNombre: p.proveedor,
          productoId: p.id,
          productoNombre: p.nombre,
          plataforma: p.plataforma,
          clienteId: nsUid,
          clienteNombre: nsUsuario.nombre,
          clienteCorreo: nsUsuario.correo || "",
          compraId,
          precioUsd: p.precio,
          montoProveedorUsd: p.precio,
          comisionPlataformaUsd: 0,
          estado: "entregada",
          fecha: ahora
        };
      }

      /* 2d. Movimiento visible en el panel del proveedor */
      if (p.proveedorId) {
        const movKey = nsDb.ref("movimientosSaldo/" + p.proveedorId).push().key;
        updates["movimientosSaldo/" + p.proveedorId + "/" + movKey] = {
          tipo: "venta",
          detalle: p.nombre + " · " + nsUsuario.nombre + (en.cantidad > 1 ? " (x" + en.cantidad + ")" : ""),
          montoUsd: montoLinea,
          signo: "+",
          fecha: ahora
        };
        acreditar[p.proveedorId] = Number(((acreditar[p.proveedorId] || 0) + montoLinea).toFixed(2));
      }

      detalleCompra.push({
        productoId: p.id,
        productoNombre: p.nombre,
        plataforma: p.plataforma,
        proveedor: p.proveedor,
        proveedorId: p.proveedorId,
        imagen: p.imagen,
        cantidad: en.cantidad,
        precioUnitarioUsd: p.precio,
        subtotalUsd: montoLinea,
        duracionDias: p.duracionDias,
        tipoEntrega: p.tipoEntrega,
        modoEntrega: p.modoEntrega,
        aplicaReembolso: p.aplicaReembolso,
        reglas: p.reglas || "",
        accesos: en.cuentas.map(c => ({
          cuentaId: c.id,
          correo: c.correo || "",
          clave:  c.clave  || "",
          perfil: c.perfil || "",
          pin:    c.pin    || ""
        }))
      });
    });

    /* 2e. Compra del cliente (historial de Mis compras) */
    updates["compras/" + nsUid + "/" + compraId] = {
      id: compraId,
      clienteId: nsUid,
      clienteNombre: nsUsuario.nombre,
      totalUsd: total,
      totalPen: Number((total * TIPO_CAMBIO).toFixed(2)),
      estado: "completada",
      fecha: ahora,
      items: detalleCompra
    };

    /* 2f. EL COBRO VA AQUÍ MISMO. Todo o nada. */
    updates["usuarios/" + nsUid + "/saldoUsd"] = Number((saldoReal - total).toFixed(2));

    const movCli = nsDb.ref("movimientosSaldo/" + nsUid).push().key;
    updates["movimientosSaldo/" + nsUid + "/" + movCli] = {
      tipo: "compra",
      detalle: "Compra " + compraId + " · " + detalleCompra.length + " producto(s)",
      montoUsd: total,
      signo: "-",
      fecha: ahora
    };

    await nsDb.ref().update(updates);

    /* ---- 3. Acreditar a proveedores (transacción: no pisa saldos) ---- */
    for (const provId of Object.keys(acreditar)) {
      try {
        await nsDb.ref("usuarios/" + provId + "/saldoUsd").transaction(
          actual => Number(((Number(actual) || 0) + acreditar[provId]).toFixed(2))
        );
      } catch (e) {
        /* Si falla, el movimiento ya quedó registrado y el admin
           puede ajustar el saldo manualmente desde su panel. */
        console.error("No se pudo acreditar al proveedor " + provId, e);
      }
    }

    /* ---- 4. Limpieza + feedback ---- */
    setCarrito([]);
    actualizarBadgeCarrito();
    renderizarCarrito();
    cerrarCarrito();

    mostrarResumenEntrega(detalleCompra, total);

  } catch (err) {
    if (err.message !== "__SALDO__") {
      console.error(err);
      toast(err.message || "No se pudo completar la compra.");
    }
  } finally {
    nsProcesandoPago = false;
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal || "Proceder al pago"; }
  }
}

function mostrarResumenEntrega(items, total){
  const modal = document.getElementById("modalCompra");
  if (!modal) { toast("Compra realizada · " + fmt(total)); return; }

  document.getElementById("modalNombre").innerText = "✅ Compra completada";
  document.getElementById("modalImagen").src = items[0] ? items[0].imagen : "";

  const badgesBox = document.getElementById("modalBadgesFila");
  if (badgesBox) badgesBox.innerHTML = "";

  document.getElementById("modalDescripcion").innerText =
    "Pagaste " + fmt(total) + " (" + fmtPEN(total) + ").\n" +
    "Tus accesos también quedaron guardados en 'Mis compras'.";

  const lista = document.getElementById("listaReglas");
  let html = "";

  items.forEach(it => {
    html += "<li><strong>" + escaparHTML(it.productoNombre) + "</strong> · x" + it.cantidad;

    if (it.accesos && it.accesos.length) {
      it.accesos.forEach(a => {
        html += "<br><span style='font-size:12px; opacity:.85;'>" +
          "Correo: " + escaparHTML(a.correo || "-") +
          " · Clave: " + escaparHTML(a.clave || "-") +
          (a.perfil ? " · Perfil: " + escaparHTML(a.perfil) : "") +
          (a.pin ? " · PIN: " + escaparHTML(a.pin) : "") +
          "</span>";
      });
    } else {
      html += "<br><span style='font-size:12px; opacity:.85;'>Entrega digital: revisa 'Mis compras' para el enlace.</span>";
    }

    html += "</li>";
  });

  html += "<li style='opacity:.8;'>Guarda estos datos. No cambies el correo ni la contraseña de la cuenta.</li>";
  lista.innerHTML = html;

  modal.style.display = "flex";
  toast("Compra realizada · " + fmt(total));
}

/* =========================
   SOPORTE WHATSAPP
========================= */

function obtenerNumeroSoporte(){
  const claves = Object.keys(proveedoresCache);
  for (const k of claves) {
    const p = proveedoresCache[k] || {};
    if (p.soporteActivo !== false && p.whatsappSoporte) {
      return String(p.whatsappSoporte).replace(/\D/g, "");
    }
  }
  return NS_WHATSAPP_FALLBACK;
}

function actualizarEnlaceSoporte(){
  const numero = obtenerNumeroSoporte();
  const msg = encodeURIComponent("Hola, necesito ayuda con NovaStream");
  const url = "https://wa.me/" + numero + "?text=" + msg;

  const flotante = document.querySelector(".nsWhatsapp");
  if (flotante) flotante.href = url;

  const enFooter = document.getElementById("linkFooterSoporte");
  if (enFooter) enFooter.href = url;
}

/* =========================
   BANNER
========================= */

let slideIndex = 0;

function mostrarSlide(){
  const slides = document.querySelectorAll(".nsSlide");
  const dotsBox = document.getElementById("nsDots");
  if (!slides.length) return;

  if (dotsBox && !dotsBox.dataset.armado) {
    slides.forEach((_,i) => {
      const d = document.createElement("span");
      d.className = "nsDot" + (i===0 ? " activo":"");
      d.addEventListener("click", () => { slideIndex = i; mostrarSlide(); });
      dotsBox.appendChild(d);
    });
    dotsBox.dataset.armado = "1";
  }

  slides.forEach((s,i) => s.classList.toggle("activo", i === slideIndex));
  document.querySelectorAll(".nsDot").forEach((d,i) => d.classList.toggle("activo", i === slideIndex));
}

setInterval(() => {
  const n = document.querySelectorAll(".nsSlide").length;
  if (!n) return;
  slideIndex = (slideIndex + 1) % n;
  mostrarSlide();
}, 6000);

/* =========================
   ALTURA DEL NAVBAR FIJO
========================= */

function ajustarAlturaNav(){
  const nav = document.getElementById("nsNav");
  if (!nav) return;
  document.documentElement.style.setProperty("--nav-height", nav.offsetHeight + "px");
}

window.addEventListener("load", ajustarAlturaNav);
window.addEventListener("resize", ajustarAlturaNav);

/* =========================
   FOOTER
========================= */

function prepararFooter(){
  const anio = document.getElementById("nsAnioActual");
  if (anio) anio.textContent = new Date().getFullYear();

  const credito = document.getElementById("nsFooterCredito");
  if (credito) {
    const msg = encodeURIComponent(
      "Hola Impulso Project, vi su trabajo en NovaStream y quiero información " +
      "sobre la creación de páginas web y sistemas a medida."
    );
    credito.href = "https://wa.me/" + NS_WHATSAPP_IMPULSO + "?text=" + msg;
  }

  const favFooter = document.getElementById("linkFooterFavoritos");
  if (favFooter) {
    favFooter.addEventListener("click", e => {
      e.preventDefault();
      filtroFavoritosActivo = true;
      renderizarProductos();
      window.scrollTo({ top: 0, behavior: "smooth" });
      toast("Mostrando tus favoritos.");
    });
  }

  const informativos = {
    linkFooterReembolso: "Puedes pedir reembolso si el producto lo permite. Escríbenos por soporte.",
    linkFooterGarantia: "Todas las cuentas tienen garantía durante su periodo de vigencia.",
    linkFooterFaq: "Sección de preguntas frecuentes en preparación.",
    linkFooterTerminos: "Términos y condiciones en preparación.",
    linkFooterPrivacidad: "Política de privacidad en preparación.",
    linkFooterProveedor: "¿Quieres vender en NovaStream? Escríbenos por soporte para registrarte como proveedor."
  };

  Object.keys(informativos).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", e => { e.preventDefault(); toast(informativos[id]); });
  });
}

/* =========================
   INIT
========================= */

document.addEventListener("DOMContentLoaded", () => {

  mostrarSlide();
  ajustarAlturaNav();
  prepararFooter();
  renderizarCarrito();

  /* Buscador */
  const buscador = document.getElementById("buscadorProductos");
  if (buscador) {
    buscador.addEventListener("input", function(){
      filtroBusqueda = this.value;
      renderizarProductos();
    });
  }

  const btnLimpiar = document.getElementById("btnLimpiarBusqueda");
  if (btnLimpiar) {
    btnLimpiar.addEventListener("click", () => {
      filtroBusqueda = "";
      if (buscador) buscador.value = "";
      renderizarProductos();
    });
  }

  const btnAbrirBusqueda = document.getElementById("btnAbrirBusqueda");
  if (btnAbrirBusqueda) {
    btnAbrirBusqueda.addEventListener("click", () => {
      if (buscador) { buscador.focus(); buscador.select(); }
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* Favoritos */
  const toggleFav = () => { filtroFavoritosActivo = !filtroFavoritosActivo; renderizarProductos(); };

  const btnFavTop = document.getElementById("btnFavoritosTop");
  if (btnFavTop) btnFavTop.addEventListener("click", toggleFav);

  const linkFavDrawer = document.getElementById("linkFavoritosDrawer");
  if (linkFavDrawer) linkFavDrawer.addEventListener("click", e => { e.preventDefault(); toggleFav(); cerrarDrawer(); });

  /* Modal producto */
  const btnCerrarModal = document.getElementById("btnCerrarModal");
  if (btnCerrarModal) btnCerrarModal.addEventListener("click", cerrarModal);

  const modal = document.getElementById("modalCompra");
  if (modal) modal.addEventListener("click", e => { if (e.target.id === "modalCompra") cerrarModal(); });

  /* Modal "necesitas cuenta" */
  const btnCerrarAuth = document.getElementById("btnCerrarAuthModal");
  if (btnCerrarAuth) btnCerrarAuth.addEventListener("click", cerrarModalAuth);

  const authModal = document.getElementById("nsAuthModal");
  if (authModal) authModal.addEventListener("click", e => { if (e.target.id === "nsAuthModal") cerrarModalAuth(); });

  /* Carrito */
  const btnCarrito = document.getElementById("btnCarrito");
  if (btnCarrito) btnCarrito.addEventListener("click", abrirCarrito);

  const btnCerrarCarrito = document.getElementById("btnCerrarCarrito");
  if (btnCerrarCarrito) btnCerrarCarrito.addEventListener("click", cerrarCarrito);

  const cartOverlay = document.getElementById("nsCartOverlay");
  if (cartOverlay) cartOverlay.addEventListener("click", e => { if (e.target.id === "nsCartOverlay") cerrarCarrito(); });

  const btnPagar = document.getElementById("btnPagarCarrito");
  if (btnPagar) btnPagar.addEventListener("click", procesarPago);

  /* Drawer móvil */
  function abrirDrawer(){
    const d = document.getElementById("nsDrawerOverlay");
    if (d) d.classList.add("activo");
  }
  window.cerrarDrawer = function(){
    const d = document.getElementById("nsDrawerOverlay");
    if (d) d.classList.remove("activo");
  };

  const btnMenu = document.getElementById("btnMenuMovil");
  if (btnMenu) btnMenu.addEventListener("click", abrirDrawer);

  const btnCerrarDrawer = document.getElementById("btnCerrarDrawer");
  if (btnCerrarDrawer) btnCerrarDrawer.addEventListener("click", cerrarDrawer);

  const drawerOverlay = document.getElementById("nsDrawerOverlay");
  if (drawerOverlay) drawerOverlay.addEventListener("click", e => { if (e.target.id === "nsDrawerOverlay") cerrarDrawer(); });

  /* Menú de usuario en escritorio (nombre + cerrar sesión) */
  const btnUserMenu = document.getElementById("btnUserMenu");
  const userMenuWrap = document.getElementById("nsUserMenu");

  if (btnUserMenu && userMenuWrap) {
    btnUserMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      const abierto = userMenuWrap.classList.toggle("abierto");
      btnUserMenu.setAttribute("aria-expanded", abierto ? "true" : "false");
    });

    document.addEventListener("click", (e) => {
      if (!userMenuWrap.contains(e.target)) {
        userMenuWrap.classList.remove("abierto");
        btnUserMenu.setAttribute("aria-expanded", "false");
      }
    });
  }

  const btnCerrarSesionDesktop = document.getElementById("btnCerrarSesionDesktop");
  if (btnCerrarSesionDesktop) {
    btnCerrarSesionDesktop.addEventListener("click", (e) => {
      e.preventDefault();
      cerrarSesionUsuario();
    });
  }

  /* Cerrar sesión (drawer móvil) */
  const linkSalir = document.getElementById("linkSalirDrawer");
  if (linkSalir) {
    linkSalir.addEventListener("click", e => {
      e.preventDefault();
      cerrarSesionUsuario();
    });
  }

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      cerrarModal(); cerrarModalAuth(); cerrarCarrito(); cerrarDrawer();
      if (userMenuWrap) userMenuWrap.classList.remove("abierto");
      if (btnUserMenu) btnUserMenu.setAttribute("aria-expanded", "false");
    }
  });

  /* Conectar Firebase */
  nsFbInit();

  /* Red de seguridad: si Firebase tarda, se muestra el modo invitado
     para que el visitante nunca vea la interfaz "a medias". */
  setTimeout(() => { if (!nsSesionListo) nsAplicarModoSesion(); }, 3500);

  /* Segunda red de seguridad: pase lo que pase, el loader "Verificando
     tu sesión..." nunca se queda colgado en pantalla. */
  setTimeout(() => nsIntentarOcultarBooting(true), 6000);
});
