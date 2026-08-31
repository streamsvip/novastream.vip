/* =========================================================
   NOVASTREAM.VIP — novaauth.js (v2)
   Lógica compartida de login.html y registro.html

   ─────────────────────────────────────────────────────────
   REDIRECCIÓN SEGÚN ROL
   ─────────────────────────────────────────────────────────
     admin      →  novaadmin.html
     proveedor  →  novapro.html
     cliente    →  catalogo.html

   Se aplica en 3 momentos:
     1. Al abrir la página con sesión ya activa (guardián).
     2. Justo después de un login exitoso.
     3. Al cerrar el modal de bienvenida del registro.

   ─────────────────────────────────────────────────────────
   COMPATIBILIDAD CON LAS REGLAS RTDB v5
   ─────────────────────────────────────────────────────────
   · usuarios/{uid} solo acepta al crear:
         rol: "cliente"  ·  estado: "activo"  ·  saldoUsd: 0
     (nadie puede autoascenderse a proveedor ni darse saldo)

   · usernames/{usuarioLower} SOLO acepta 3 campos:
         { uid, correo, fecha }
     Cualquier campo extra rechaza el write completo.

   · El write del perfil se hace en UN SOLO update() atómico:
     si falla algo, no queda nada a medias.

   ─────────────────────────────────────────────────────────
   NOTA HONESTA DE SEGURIDAD
   ─────────────────────────────────────────────────────────
   `usernames` es de lectura pública porque Firebase Auth
   necesita el correo para iniciar sesión. Alguien que conozca
   un usuario podría deducir su correo. Si eso te incomoda,
   pon NA_PERMITIR_LOGIN_USUARIO = false y se exigirá correo.
========================================================= */

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

/* ⚠️ RUTAS REALES DEL PROYECTO */
const NA_RUTAS_ROL = {
  cliente:   "catalogo.html",
  proveedor: "novapro.html",
  admin:     "novaadmin.html"
};

const NA_PERMITIR_LOGIN_USUARIO = true;   // false = solo correo
const NA_WHATSAPP_IMPULSO       = "51916252754";
const NA_MIN_PASSWORD           = 6;

/* =========================
   ESTADO
========================= */

let naAuth = null, naDb = null;
let naFbListo = false;
let naProcesando = false;
let naRegistroEnCurso = false;   // frena al guardián mientras se crea la cuenta
let naRedirigiendo = false;      // evita redirecciones dobles
let naUsuarioTimer = null;

const NA_PAGINA      = (window.location.pathname.split("/").pop() || "login.html").toLowerCase();
const NA_ES_REGISTRO = NA_PAGINA.indexOf("registro") !== -1;

/* =========================
   TÉRMINOS
========================= */

const NA_TERMINOS = [
  "Los accesos ofrecidos en NovaStream corresponden a cuentas, perfiles o licencias de servicios digitales provistos por proveedores verificados dentro de la plataforma.",
  "NovaStream no mantiene afiliación oficial ni representación con las marcas o plataformas mencionadas en el catálogo.",
  "El acceso adquirido es para <strong>uso personal</strong> del comprador y no debe revenderse ni utilizarse con fines comerciales, salvo autorización expresa.",
  "El usuario se compromete a respetar las reglas de uso indicadas en cada producto: no cambiar el correo ni la contraseña de la cuenta entregada, y no compartirla fuera de lo permitido.",
  "Cada producto indica si <strong>aplica reembolso</strong>. Cuando aplica, la solicitud debe realizarse dentro del plazo señalado y a través del canal de soporte.",
  "El saldo cargado en la cuenta es de uso exclusivo dentro de NovaStream y no es transferible ni canjeable por dinero en efectivo.",
  "Por políticas o actualizaciones de las plataformas de origen, algunos accesos pueden ser reemplazados o actualizados; en ese caso se notificará al comprador.",
  "El uso indebido de un acceso, el incumplimiento de las reglas del producto o cualquier intento de fraude puede derivar en la suspensión de la cuenta sin derecho a reembolso.",
  "Al crear una cuenta y utilizar la plataforma, el usuario confirma haber leído y aceptado estos términos y condiciones."
];

/* =========================
   UTILIDADES
========================= */

function naEl(id){ return document.getElementById(id); }
function naLimpiar(v){ return String(v == null ? "" : v).trim(); }

function naEsCorreo(v){
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(naLimpiar(v));
}

function naUsuarioValido(v){
  return /^[A-Za-z0-9_]{3,20}$/.test(naLimpiar(v));
}

/* Firebase RTDB prohíbe . $ # [ ] / en las claves.
   Se usa para no lanzar una consulta que reventaría el SDK. */
function naClaveSegura(v){
  return !/[.$#\[\]\/]/.test(String(v || ""));
}

/* ---- Mensaje principal ---- */
function naMensaje(texto, tipo){
  const box = naEl("naMessage");
  if (!box) return;
  if (!texto) { box.className = "naMessage"; box.textContent = ""; return; }
  box.className = "naMessage visible " + (tipo || "info");
  box.textContent = texto;
}

/* ---- Toast ---- */
function naToast(texto, tipo){
  const el = naEl("naToast");
  if (!el) return;
  el.className = "naToast visible " + (tipo || "");
  el.textContent = texto;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = "naToast"; }, 3200);
}

/* ---- Errores por campo ---- */
function naError(idCampo, idError, mensaje){
  const campo = naEl(idCampo);
  const err   = naEl(idError);

  if (campo) {
    const wrap = campo.closest(".naInputWrap");
    if (wrap) {
      wrap.classList.toggle("error", !!mensaje);
      if (mensaje) wrap.classList.remove("ok");
    }
  }
  if (err) {
    err.textContent = mensaje || "";
    err.classList.toggle("visible", !!mensaje);
  }
  return !mensaje;
}

function naOk(idCampo, idError){
  naError(idCampo, idError, "");
  const campo = naEl(idCampo);
  if (campo) {
    const wrap = campo.closest(".naInputWrap");
    if (wrap) wrap.classList.add("ok");
  }
}

function naLimpiarErrores(){
  document.querySelectorAll(".naFieldError").forEach(e => { e.textContent = ""; e.classList.remove("visible"); });
  document.querySelectorAll(".naInputWrap").forEach(w => w.classList.remove("error", "ok"));
  naMensaje("");
}

/* ---- Botón cargando ---- */
function naCargando(idBtn, activo, textoAlt){
  const btn = naEl(idBtn);
  if (!btn) return;
  const label = btn.querySelector(".naBtnLabel");

  if (activo) {
    btn.classList.add("cargando");
    btn.disabled = true;
    if (label) {
      if (!btn.dataset.textoOriginal) btn.dataset.textoOriginal = label.textContent;
      label.textContent = textoAlt || "Procesando...";
    }
  } else {
    btn.classList.remove("cargando");
    btn.disabled = false;
    if (label && btn.dataset.textoOriginal) label.textContent = btn.dataset.textoOriginal;
  }
}

/* ---- Traducción de errores ---- */
function naTraducirError(error, contexto){
  const c = String(error && error.code ? error.code : "").trim();
  const m = String(error && error.message ? error.message : "").trim();

  const mapa = {
    "auth/network-request-failed": "Sin conexión. Revisa tu internet e intenta de nuevo.",
    "auth/too-many-requests": "Demasiados intentos. Espera unos minutos antes de reintentar.",
    "auth/user-not-found": "No existe una cuenta con esos datos.",
    "auth/wrong-password": "La contraseña es incorrecta.",
    "auth/invalid-credential": "Usuario, correo o contraseña incorrectos.",
    "auth/invalid-login-credentials": "Usuario, correo o contraseña incorrectos.",
    "auth/invalid-email": "El correo electrónico no tiene un formato válido.",
    "auth/email-already-in-use": "Ese correo ya está registrado. Intenta iniciar sesión.",
    "auth/weak-password": "La contraseña es demasiado débil.",
    "auth/user-disabled": "Esta cuenta fue deshabilitada. Contacta con soporte.",
    "auth/operation-not-allowed": "El acceso con correo y contraseña no está habilitado en el proyecto.",
    "auth/missing-password": "Ingresa tu contraseña.",
    "PERMISSION_DENIED": "El servidor rechazó la operación. Revisa los permisos de la base de datos."
  };

  if (mapa[c]) return mapa[c];

  if (/permission_denied/i.test(m)) {
    return "El servidor rechazó los datos. Verifica que tu usuario y correo sean válidos.";
  }
  if (/web storage|localStorage|sessionStorage/i.test(m)) {
    return "Tu navegador está bloqueando el almacenamiento. Activa las cookies o prueba en otro navegador.";
  }

  if (contexto === "login")     return "No se pudo iniciar sesión. Verifica tus datos.";
  if (contexto === "registro")  return "No se pudo crear la cuenta. Intenta de nuevo.";
  if (contexto === "recuperar") return "No se pudo enviar el correo de recuperación.";

  return m || "Ocurrió un error inesperado.";
}

/* =========================================================
   FIREBASE + GUARDIÁN DE SESIÓN
========================================================= */

function naInit(){
  if (typeof firebase === "undefined") {
    naOcultarBooting();
    naMensaje("No se pudo cargar el sistema de acceso. Revisa tu conexión.", "err");
    return;
  }

  try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    naAuth = firebase.auth();
    naDb   = firebase.database();
    naFbListo = true;
  } catch (err) {
    console.error("Error iniciando Firebase:", err);
    naOcultarBooting();
    naMensaje("Error de conexión con el servidor.", "err");
    return;
  }

  /* Si ya hay sesión activa, no lo dejamos en el login:
     lo mandamos directo al panel que le corresponde. */
  naAuth.onAuthStateChanged(async (user) => {
    if (naRegistroEnCurso) return;      // no interrumpir la creación de cuenta
    if (!user) { naOcultarBooting(); return; }

    const ok = await naRedirigirPorRol(user.uid);
    if (!ok) naOcultarBooting();        // bloqueado o error: se muestra el form
  });
}

function naOcultarBooting(){
  const boot = naEl("naBooting");
  const wrap = naEl("naWrap");
  if (boot) boot.classList.add("oculto");
  if (wrap) wrap.classList.add("listo");
}

/* =========================================================
   ⭐ REDIRECCIÓN SEGÚN ROL
   Puedes llamarla de 2 formas:
     naRedirigirPorRol(uid)             → lee el perfil de la BD
     naRedirigirPorRol(uid, perfilObj)  → usa el perfil ya leído
   Devuelve true si redirigió, false si no (bloqueado / error).
========================================================= */

async function naRedirigirPorRol(uid, perfilPrecargado){
  if (naRedirigiendo) return true;

  let d = perfilPrecargado;

  if (!d) {
    try {
      const snap = await naDb.ref("usuarios/" + uid).get();
      d = snap.val() || {};
    } catch (err) {
      console.error("No se pudo leer el perfil:", err);
      naMensaje("No pudimos verificar tu cuenta. Revisa tu conexión.", "err");
      return false;
    }
  }

  /* Cuenta bloqueada: se cierra la sesión y se queda en el login */
  if (String(d.estado || "activo").toLowerCase() === "bloqueado") {
    try { await naAuth.signOut(); } catch (e) {}
    naMensaje("Tu cuenta está bloqueada. Contacta con soporte para más información.", "err");
    return false;
  }

  const rol = String(d.rol || "cliente").toLowerCase();
  const destino = NA_RUTAS_ROL[rol] || NA_RUTAS_ROL.cliente;

  naRedirigiendo = true;
  window.location.replace(destino);
  return true;
}

/* =========================================================
   LOGIN
========================================================= */

async function naBuscarCorreoPorUsuario(usuario){
  const clave = naLimpiar(usuario).toLowerCase();

  if (!naClaveSegura(clave) || !naUsuarioValido(clave)) {
    throw { code: "auth/user-not-found" };
  }

  const snap = await naDb.ref("usernames/" + clave).get();
  if (!snap.exists()) throw { code: "auth/user-not-found" };

  const correo = naLimpiar((snap.val() || {}).correo);
  if (!correo) throw { code: "auth/user-not-found" };

  return correo;
}

async function naIniciarSesion(e){
  if (e) e.preventDefault();
  if (naProcesando || !naFbListo) return;

  naLimpiarErrores();

  const entrada  = naLimpiar(naEl("loginUsuario").value);
  const password = naEl("loginPassword").value;
  const mantener = naEl("mantenerSesion") && naEl("mantenerSesion").checked;

  let valido = true;

  if (!entrada) {
    valido = naError("loginUsuario", "errLoginUsuario", "Ingresa tu usuario o correo.");
  } else if (!NA_PERMITIR_LOGIN_USUARIO && !naEsCorreo(entrada)) {
    valido = naError("loginUsuario", "errLoginUsuario", "Debes ingresar tu correo electrónico.");
  } else if (!naEsCorreo(entrada) && !naUsuarioValido(entrada)) {
    valido = naError("loginUsuario", "errLoginUsuario", "Ingresa un usuario válido o tu correo completo.");
  }

  if (!password) {
    valido = naError("loginPassword", "errLoginPassword", "Ingresa tu contraseña.") && valido;
  }

  if (!valido) return;

  naProcesando = true;
  naCargando("btnLogin", true, "Ingresando...");
  naMensaje("Verificando tus datos...", "info");

  try {
    await naAuth.setPersistence(
      mantener
        ? firebase.auth.Auth.Persistence.LOCAL
        : firebase.auth.Auth.Persistence.SESSION
    );

    /* Recordar el dato ingresado para la próxima visita */
    try {
      if (mantener) {
        localStorage.setItem("ns_login_recordado", entrada);
        localStorage.setItem("ns_mantener_sesion", "true");
      } else {
        localStorage.removeItem("ns_login_recordado");
        localStorage.removeItem("ns_mantener_sesion");
      }
    } catch (err) {}

    /* Usuario → correo (Auth solo entiende correos) */
    const correo = naEsCorreo(entrada)
      ? entrada
      : await naBuscarCorreoPorUsuario(entrada);

    const cred = await naAuth.signInWithEmailAndPassword(correo, password);
    const user = cred.user;

    /* Perfil: rol + estado */
    const snap = await naDb.ref("usuarios/" + user.uid).get();
    const d = snap.val() || {};

    if (String(d.estado || "activo").toLowerCase() === "bloqueado") {
      await naAuth.signOut();
      throw { code: "cuenta-bloqueada" };
    }

    /* Marca de última sesión (permitido: es su propio nodo) */
    naDb.ref("usuarios/" + user.uid + "/ultimaSesion").set(Date.now()).catch(() => {});

    const rol = String(d.rol || "cliente").toLowerCase();
    const saludo = rol === "proveedor" ? "Entrando a tu panel de proveedor..."
                 : rol === "admin"     ? "Entrando al panel de administración..."
                 : "¡Bienvenido de nuevo, " + (d.nombre || "usuario") + "!";

    naMensaje(saludo, "ok");
    naCargando("btnLogin", true, "Redirigiendo...");

    setTimeout(() => naRedirigirPorRol(user.uid, d), 650);

  } catch (err) {
    console.error("Error login:", err);

    naProcesando = false;
    naCargando("btnLogin", false);

    if (err && err.code === "cuenta-bloqueada") {
      naMensaje("Tu cuenta está bloqueada. Contacta con soporte.", "err");
      return;
    }

    const codigo = String(err && err.code ? err.code : "");

    if (codigo === "auth/user-not-found") {
      naError("loginUsuario", "errLoginUsuario", "No existe una cuenta con esos datos.");
    } else if (codigo === "auth/wrong-password" || codigo.indexOf("invalid") !== -1) {
      naError("loginPassword", "errLoginPassword", "Contraseña incorrecta.");
    }

    naMensaje(naTraducirError(err, "login"), "err");
  }
}

/* =========================================================
   REGISTRO
========================================================= */

function naFuerzaPassword(pass){
  const p = String(pass || "");
  let puntos = 0;

  if (p.length >= 6)  puntos++;
  if (p.length >= 10) puntos++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) puntos++;
  if (/[0-9]/.test(p)) puntos++;
  if (/[^A-Za-z0-9]/.test(p)) puntos++;

  if (!p.length)   return { nivel: 0, texto: "Seguridad de la contraseña" };
  if (puntos <= 1) return { nivel: 1, texto: "Muy débil · agrega más caracteres" };
  if (puntos === 2) return { nivel: 2, texto: "Débil · combina letras y números" };
  if (puntos === 3) return { nivel: 3, texto: "Buena · casi lista" };
  return { nivel: 4, texto: "Excelente · contraseña fuerte" };
}

function naActualizarFuerza(){
  const cont  = naEl("naStrength");
  const txt   = naEl("naStrengthTxt");
  const input = naEl("regPassword");
  if (!cont || !txt || !input) return;

  const r = naFuerzaPassword(input.value);
  cont.setAttribute("data-nivel", String(r.nivel));
  txt.textContent = r.texto;
}

async function naVerificarUsuario(){
  const input  = naEl("regUsuario");
  const status = naEl("statusUsuario");
  if (!input || !naFbListo) return;

  const valor = naLimpiar(input.value);

  if (!valor) {
    if (status) status.textContent = "";
    naError("regUsuario", "errRegUsuario", "");
    return;
  }

  if (!naUsuarioValido(valor)) {
    if (status) status.textContent = "";
    naError("regUsuario", "errRegUsuario", "Usa 3–20 caracteres: letras, números o guion bajo.");
    return;
  }

  if (status) { status.textContent = "⏳"; status.style.color = ""; }

  try {
    const snap = await naDb.ref("usernames/" + valor.toLowerCase()).get();

    if (snap.exists()) {
      if (status) status.textContent = "";
      naError("regUsuario", "errRegUsuario", "Ese usuario ya está tomado. Prueba otro.");
    } else {
      if (status) { status.textContent = "✓"; status.style.color = "#21e6c1"; }
      naOk("regUsuario", "errRegUsuario");
    }
  } catch (err) {
    if (status) status.textContent = "";
  }
}

function naValidarRegistro(){
  const nombre   = naLimpiar(naEl("regNombre").value);
  const usuario  = naLimpiar(naEl("regUsuario").value);
  const correo   = naLimpiar(naEl("regCorreo").value);
  const pass     = naEl("regPassword").value;
  const conf     = naEl("regConfirmar").value;
  const terminos = naEl("regTerminos").checked;

  let ok = true;

  if (!nombre) ok = naError("regNombre", "errRegNombre", "Ingresa tu nombre.") && ok;
  else if (nombre.length < 3) ok = naError("regNombre", "errRegNombre", "El nombre es demasiado corto.") && ok;
  else if (nombre.length > 60) ok = naError("regNombre", "errRegNombre", "El nombre es demasiado largo (máx. 60).") && ok;
  else naOk("regNombre", "errRegNombre");

  if (!usuario) ok = naError("regUsuario", "errRegUsuario", "Elige un nombre de usuario.") && ok;
  else if (usuario.indexOf("@") !== -1) ok = naError("regUsuario", "errRegUsuario", "El usuario no debe llevar @.") && ok;
  else if (!naUsuarioValido(usuario)) ok = naError("regUsuario", "errRegUsuario", "Usa 3–20 caracteres: letras, números o guion bajo.") && ok;

  if (!correo) ok = naError("regCorreo", "errRegCorreo", "Ingresa tu correo electrónico.") && ok;
  else if (!naEsCorreo(correo)) ok = naError("regCorreo", "errRegCorreo", "El correo no tiene un formato válido.") && ok;
  else if (correo.length > 120) ok = naError("regCorreo", "errRegCorreo", "El correo es demasiado largo.") && ok;
  else naOk("regCorreo", "errRegCorreo");

  if (!pass) ok = naError("regPassword", "errRegPassword", "Crea una contraseña.") && ok;
  else if (pass.length < NA_MIN_PASSWORD) ok = naError("regPassword", "errRegPassword", "Mínimo " + NA_MIN_PASSWORD + " caracteres.") && ok;
  else naOk("regPassword", "errRegPassword");

  if (!conf) ok = naError("regConfirmar", "errRegConfirmar", "Repite tu contraseña.") && ok;
  else if (pass !== conf) ok = naError("regConfirmar", "errRegConfirmar", "Las contraseñas no coinciden.") && ok;
  else naOk("regConfirmar", "errRegConfirmar");

  const errT = naEl("errRegTerminos");
  if (!terminos) {
    if (errT) { errT.textContent = "Debes aceptar los términos y condiciones."; errT.classList.add("visible"); }
    ok = false;
  } else if (errT) {
    errT.textContent = ""; errT.classList.remove("visible");
  }

  return ok;
}

async function naCrearCuenta(e){
  if (e) e.preventDefault();
  if (naProcesando || !naFbListo) return;

  naMensaje("");
  if (!naValidarRegistro()) {
    naMensaje("Revisa los campos marcados en rojo.", "warn");
    return;
  }

  const nombre       = naLimpiar(naEl("regNombre").value);
  const usuario      = naLimpiar(naEl("regUsuario").value);
  const usuarioLower = usuario.toLowerCase();
  const correo       = naLimpiar(naEl("regCorreo").value);
  const password     = naEl("regPassword").value;

  naProcesando = true;
  naRegistroEnCurso = true;
  naCargando("btnRegistro", true, "Creando cuenta...");
  naMensaje("Estamos creando tu cuenta...", "info");

  let credencial = null;

  try {
    /* ── 1. El usuario debe estar libre (usernames tiene lectura pública) ── */
    const snapUser = await naDb.ref("usernames/" + usuarioLower).get();
    if (snapUser.exists()) throw { code: "usuario-duplicado" };

    /* ── 2. Crear en Firebase Auth (esto ya deja auth != null) ── */
    await naAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    credencial = await naAuth.createUserWithEmailAndPassword(correo, password);

    const user  = credencial.user;
    const ahora = Date.now();

    /* ── 3. Nombre visible en Auth (cosmético) ── */
    try { await user.updateProfile({ displayName: nombre }); } catch (err) {}

    /* ── 4. Perfil + username en UN SOLO update atómico ──
       ⚠️ Las reglas exigen en la creación:
            rol: "cliente"  ·  estado: "activo"  ·  saldoUsd: 0
            uid === $uid
       ⚠️ usernames SOLO acepta { uid, correo, fecha } */
    await naDb.ref().update({
      ["usuarios/" + user.uid]: {
        uid:            user.uid,
        nombre:         nombre,
        nombreCompleto: nombre,
        usuario:        usuario,
        usuarioLower:   usuarioLower,
        correo:         correo,
        rol:            "cliente",
        estado:         "activo",
        saldoUsd:       0,
        fechaRegistro:  ahora,
        ultimaSesion:   ahora
      },
      ["usernames/" + usuarioLower]: {
        uid:    user.uid,
        correo: correo,
        fecha:  ahora
      }
    });

    /* ── 5. Verificación de correo (informativa, no bloquea) ── */
    try { await user.sendEmailVerification(); } catch (err) {}

    naRegistroEnCurso = false;
    naProcesando = false;
    naCargando("btnRegistro", false);
    naMensaje("");

    /* ── 6. Modal de bienvenida ── */
    const spanNombre = naEl("bienvenidaNombre");
    if (spanNombre) spanNombre.textContent = nombre.split(" ")[0] || usuario;

    const modal = naEl("naModalBienvenida");
    if (modal) {
      modal.classList.add("show");
      /* Guardamos el uid para redirigir con el rol correcto al cerrar */
      modal.dataset.uid = user.uid;
    } else {
      naRedirigirPorRol(user.uid);
    }

  } catch (err) {
    console.error("Error registro:", err);

    /* Rollback: si algo falló luego de crear el usuario en Auth,
       limpiamos todo para que el correo y el username queden libres. */
    if (credencial && credencial.user) {
      try { await naDb.ref("usernames/" + usuarioLower).remove(); } catch (e2) {}
      try { await naDb.ref("usuarios/" + credencial.user.uid).remove(); } catch (e2) {}
      try { await credencial.user.delete(); } catch (e2) {}
    }

    try { await naAuth.signOut(); } catch (e2) {}

    naRegistroEnCurso = false;
    naProcesando = false;
    naCargando("btnRegistro", false);

    if (err && err.code === "usuario-duplicado") {
      naError("regUsuario", "errRegUsuario", "Ese usuario ya está tomado. Prueba otro.");
      naMensaje("El nombre de usuario ya está registrado.", "err");
      return;
    }

    if (String(err && err.code) === "auth/email-already-in-use") {
      naError("regCorreo", "errRegCorreo", "Este correo ya tiene una cuenta.");
    }

    naMensaje(naTraducirError(err, "registro"), "err");
  }
}

/* =========================================================
   RECUPERAR CONTRASEÑA
========================================================= */

function naAbrirRecuperar(){
  const modal = naEl("naModalRecuperar");
  if (!modal) return;

  const input   = naEl("recuperarCorreo");
  const enLogin = naEl("loginUsuario");

  if (input && enLogin && naEsCorreo(enLogin.value)) input.value = naLimpiar(enLogin.value);

  modal.classList.add("show");
  setTimeout(() => { if (input) input.focus(); }, 120);
}

function naCerrarRecuperar(){
  const modal = naEl("naModalRecuperar");
  if (modal) modal.classList.remove("show");
  naError("recuperarCorreo", "errRecuperar", "");
}

async function naEnviarRecuperar(e){
  if (e) e.preventDefault();
  if (!naFbListo) return;

  const correo = naLimpiar(naEl("recuperarCorreo").value);

  if (!correo)             { naError("recuperarCorreo", "errRecuperar", "Ingresa tu correo."); return; }
  if (!naEsCorreo(correo)) { naError("recuperarCorreo", "errRecuperar", "El correo no es válido."); return; }

  naError("recuperarCorreo", "errRecuperar", "");
  naCargando("btnEnviarRecuperar", true, "Enviando...");

  try {
    await naAuth.sendPasswordResetEmail(correo);
    naCargando("btnEnviarRecuperar", false);
    naCerrarRecuperar();
    naToast("Te enviamos un enlace a " + correo, "ok");
    naMensaje("Revisa tu correo para restablecer la contraseña. Puede tardar un par de minutos.", "ok");
  } catch (err) {
    console.error(err);
    naCargando("btnEnviarRecuperar", false);
    naError("recuperarCorreo", "errRecuperar", naTraducirError(err, "recuperar"));
  }
}

/* =========================================================
   MODAL DE TÉRMINOS
========================================================= */

function naPintarTerminos(){
  const cont = naEl("naTerminosTexto");
  if (!cont || cont.dataset.listo) return;
  cont.innerHTML = NA_TERMINOS.map(t => "<p>" + t + "</p>").join("");
  cont.dataset.listo = "1";
}

function naAbrirTerminos(){
  naPintarTerminos();
  const modal = naEl("naModalTerminos");
  if (modal) modal.classList.add("show");
}

function naCerrarTerminos(){
  const modal = naEl("naModalTerminos");
  if (modal) modal.classList.remove("show");
}

function naAceptarTerminos(){
  const check = naEl("regTerminos");
  if (check) {
    check.checked = true;
    const err = naEl("errRegTerminos");
    if (err) { err.textContent = ""; err.classList.remove("visible"); }
  }
  naCerrarTerminos();
  if (NA_ES_REGISTRO) naToast("Términos aceptados", "ok");
}

/* =========================================================
   UI: OJO, CAPS LOCK, CRÉDITO
========================================================= */

function naPrepararOjos(){
  document.querySelectorAll(".naEye").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = naEl(btn.dataset.target);
      if (!input) return;

      const mostrar = input.type === "password";
      input.type = mostrar ? "text" : "password";
      btn.classList.toggle("activo", mostrar);
      btn.setAttribute("aria-label", mostrar ? "Ocultar contraseña" : "Mostrar contraseña");
      input.focus();
    });
  });
}

function naPrepararCapsLock(){
  const pares = [
    { input: "loginPassword", aviso: "capsWarnLogin" },
    { input: "regPassword",   aviso: "capsWarnReg" },
    { input: "regConfirmar",  aviso: "capsWarnReg" }
  ];

  pares.forEach(par => {
    const input = naEl(par.input);
    const aviso = naEl(par.aviso);
    if (!input || !aviso) return;

    const revisar = (e) => {
      if (typeof e.getModifierState !== "function") return;
      aviso.classList.toggle("visible", e.getModifierState("CapsLock"));
    };

    input.addEventListener("keyup", revisar);
    input.addEventListener("keydown", revisar);
    input.addEventListener("blur", () => aviso.classList.remove("visible"));
  });
}

function naPrepararCredito(){
  const credito = naEl("naCredito");
  if (!credito) return;
  const msg = encodeURIComponent(
    "Hola Impulso Project, quiero información sobre la creación de páginas web y sistemas a medida."
  );
  credito.href = "https://wa.me/" + NA_WHATSAPP_IMPULSO + "?text=" + msg;
}

/* =========================================================
   INIT
========================================================= */

document.addEventListener("DOMContentLoaded", () => {

  naPrepararOjos();
  naPrepararCapsLock();
  naPrepararCredito();

  /* ---- Términos ---- */
  ["btnTerminosAside", "btnVerTerminos", "linkTerminosCheck"].forEach(id => {
    const b = naEl(id);
    if (b) b.addEventListener("click", (e) => { e.preventDefault(); naAbrirTerminos(); });
  });

  const btnCerrarT = naEl("btnCerrarTerminos");
  if (btnCerrarT) btnCerrarT.addEventListener("click", naCerrarTerminos);

  const btnAceptarT = naEl("btnAceptarTerminos");
  if (btnAceptarT) btnAceptarT.addEventListener("click", naAceptarTerminos);

  const modalT = naEl("naModalTerminos");
  if (modalT) modalT.addEventListener("mousedown", (e) => { if (e.target === modalT) naCerrarTerminos(); });

  /* ---- LOGIN ---- */
  const formLogin = naEl("formLogin");
  if (formLogin) {
    formLogin.addEventListener("submit", naIniciarSesion);

    try {
      const recordado = localStorage.getItem("ns_login_recordado");
      const mantener  = localStorage.getItem("ns_mantener_sesion") === "true";
      if (recordado && naEl("loginUsuario")) naEl("loginUsuario").value = recordado;
      if (mantener && naEl("mantenerSesion")) naEl("mantenerSesion").checked = true;
    } catch (err) {}

    ["loginUsuario", "loginPassword"].forEach(id => {
      const input = naEl(id);
      if (input) input.addEventListener("input", () => {
        naError(id, id === "loginUsuario" ? "errLoginUsuario" : "errLoginPassword", "");
        naMensaje("");
      });
    });

    const btnRec = naEl("btnRecuperar");
    if (btnRec) btnRec.addEventListener("click", naAbrirRecuperar);

    const btnCerrarR = naEl("btnCerrarRecuperar");
    if (btnCerrarR) btnCerrarR.addEventListener("click", naCerrarRecuperar);

    const formRec = naEl("formRecuperar");
    if (formRec) formRec.addEventListener("submit", naEnviarRecuperar);

    const modalR = naEl("naModalRecuperar");
    if (modalR) modalR.addEventListener("mousedown", (e) => { if (e.target === modalR) naCerrarRecuperar(); });
  }

  /* ---- REGISTRO ---- */
  const formReg = naEl("formRegistro");
  if (formReg) {
    formReg.addEventListener("submit", naCrearCuenta);

    const pass = naEl("regPassword");
    if (pass) pass.addEventListener("input", () => {
      naActualizarFuerza();
      naError("regPassword", "errRegPassword", "");

      const conf = naEl("regConfirmar");
      if (conf && conf.value) {
        if (conf.value === pass.value) naOk("regConfirmar", "errRegConfirmar");
        else naError("regConfirmar", "errRegConfirmar", "Las contraseñas no coinciden.");
      }
    });

    const conf = naEl("regConfirmar");
    if (conf) conf.addEventListener("input", () => {
      const p = naEl("regPassword").value;
      if (!conf.value) { naError("regConfirmar", "errRegConfirmar", ""); return; }
      if (conf.value === p) naOk("regConfirmar", "errRegConfirmar");
      else naError("regConfirmar", "errRegConfirmar", "Las contraseñas no coinciden.");
    });

    /* Usuario: se normaliza a minúsculas y se consulta con debounce */
    const usuario = naEl("regUsuario");
    if (usuario) {
      usuario.addEventListener("input", () => {
        usuario.value = usuario.value.replace(/[^A-Za-z0-9_]/g, "").toLowerCase();

        const status = naEl("statusUsuario");
        if (status) status.textContent = "";
        naError("regUsuario", "errRegUsuario", "");

        clearTimeout(naUsuarioTimer);
        naUsuarioTimer = setTimeout(naVerificarUsuario, 550);
      });
    }

    const correo = naEl("regCorreo");
    if (correo) correo.addEventListener("blur", () => {
      const v = naLimpiar(correo.value);
      if (!v) return;
      if (!naEsCorreo(v)) naError("regCorreo", "errRegCorreo", "El correo no tiene un formato válido.");
      else naOk("regCorreo", "errRegCorreo");
    });

    const nombre = naEl("regNombre");
    if (nombre) nombre.addEventListener("input", () => naError("regNombre", "errRegNombre", ""));

    const check = naEl("regTerminos");
    if (check) check.addEventListener("change", () => {
      const err = naEl("errRegTerminos");
      if (check.checked && err) { err.textContent = ""; err.classList.remove("visible"); }
    });

    /* Los botones del modal de bienvenida respetan el rol */
    const modalB = naEl("naModalBienvenida");
    if (modalB) {
      const irAlPanel = (e) => {
        const uid = modalB.dataset.uid;
        if (!uid) return;                 // deja que el href normal actúe
        e.preventDefault();
        naRedirigirPorRol(uid);
      };
      const btnCat = naEl("btnIrCatalogo");
      if (btnCat) btnCat.addEventListener("click", irAlPanel);
    }

    naActualizarFuerza();
  }

  /* ---- Escape cierra modales (menos la bienvenida) ---- */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    naCerrarTerminos();
    naCerrarRecuperar();
  });

  naInit();

  /* Si Firebase tarda demasiado, no dejamos la pantalla trabada */
  setTimeout(naOcultarBooting, 4000);
});
