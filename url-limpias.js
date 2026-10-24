/* =========================================================
   NOVASTREAM · urls-limpias.js
   Quita el ".html" de la barra de direcciones y de todos los
   enlaces, sin tener que editar cada página.

   Cómo usarlo: pon esta línea dentro del <head> de cada HTML
   (login, registro, catalogo, recargas, mis-compras, novapro,
   novaadmin), lo más arriba posible:

       <script src="/urls-limpias.js"></script>

   Funciona en GitHub Pages porque GitHub ya sirve
   "/login" aunque el archivo se llame "login.html".
   ========================================================= */
(function () {
  "use strict";

  /* "carpeta/pagina.html?x#y"  →  "carpeta/pagina?x#y"
     "index.html"               →  "/"                     */
  function quitarHtml(ruta) {
    return ruta.replace(/(^|\/)([A-Za-z0-9_-]+)\.html(?=$|[?#])/i, function (_, barra, nombre) {
      if (nombre.toLowerCase() === "index") return barra || "/";
      return barra + nombre;
    });
  }

  /* 1) Barra de direcciones: /login.html → /login (sin recargar) */
  try {
    var actual = location.pathname;
    var limpia = quitarHtml(actual);
    if (limpia !== actual && window.history && history.replaceState) {
      history.replaceState(history.state, "", limpia + location.search + location.hash);
    }
  } catch (e) {}

  /* 2) Enlaces <a href="algo.html"> → href="algo" */
  function esDelMismoSitio(href) {
    if (/^(mailto:|tel:|javascript:|#|data:)/i.test(href)) return false;
    if (/^https?:\/\//i.test(href)) return href.indexOf(location.origin) === 0;
    if (/^\/\//.test(href)) return false;
    return true;                                   // ruta relativa o absoluta del sitio
  }

  function limpiarEnlace(a) {
    var href = a.getAttribute("href");
    if (!href || href.indexOf(".html") === -1 || !esDelMismoSitio(href)) return;
    var nuevo = quitarHtml(href);
    if (nuevo !== href) a.setAttribute("href", nuevo);
  }

  function limpiarDentroDe(nodo) {
    if (!nodo || nodo.nodeType !== 1) return;
    if (nodo.tagName === "A") limpiarEnlace(nodo);
    var enlaces = nodo.querySelectorAll ? nodo.querySelectorAll('a[href*=".html"]') : [];
    for (var i = 0; i < enlaces.length; i++) limpiarEnlace(enlaces[i]);
  }

  function iniciar() {
    limpiarDentroDe(document.documentElement);

    /* También los enlaces que el JS crea después (tarjetas, menús, etc.) */
    if (window.MutationObserver) {
      new MutationObserver(function (cambios) {
        for (var i = 0; i < cambios.length; i++) {
          var c = cambios[i];
          if (c.type === "attributes") limpiarEnlace(c.target);
          else for (var j = 0; j < c.addedNodes.length; j++) limpiarDentroDe(c.addedNodes[j]);
        }
      }).observe(document.documentElement, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ["href"]
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
