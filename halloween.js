/* =========================================================
   NOVASTREAM · EDICIÓN HALLOWEEN — decoraciones animadas
   No toca tu lógica: solo agrega dos capas decorativas al <body>
   (una detrás del contenido y otra encima, ambas sin clics).
   Para quitarlo: elimina el <script> de este archivo.
   ========================================================= */
(function () {
  "use strict";
  if (window.__hwOn) return;
  window.__hwOn = true;

  var BAT =
    '<svg viewBox="0 0 64 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<g fill="currentColor">' +
    '<path d="M32 12c-1.6 0-2.6 1.4-3 3.2C25 11 17 8 3 12c3.4 1.6 5 4.4 5 8 3-1.8 6-1.8 8.6.4 2-2.2 5-2.4 7.4-.6 1.4-.9 2.6-1.4 4-1.6V12z"/>' +
    '<path transform="translate(64,0) scale(-1,1)" d="M32 12c-1.6 0-2.6 1.4-3 3.2C25 11 17 8 3 12c3.4 1.6 5 4.4 5 8 3-1.8 6-1.8 8.6.4 2-2.2 5-2.4 7.4-.6 1.4-.9 2.6-1.4 4-1.6V12z"/>' +
    '<ellipse cx="32" cy="19" rx="4.4" ry="7"/>' +
    '<circle cx="32" cy="11.5" r="3.6"/>' +
    '<path d="M28.6 10.5 29.4 5.2 31.6 9zM35.4 10.5 34.6 5.2 32.4 9z"/>' +
    '</g>' +
    '<circle cx="30.6" cy="11.2" r=".9" fill="#ff8a1f"/><circle cx="33.4" cy="11.2" r=".9" fill="#ff8a1f"/>' +
    '</svg>';

  var SPIDER =
    '<svg viewBox="0 0 40 46" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<g stroke="#cdb6ff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M15 24 6 15 3 22M14 27 3 25 2 33M14 30 5 33 6 41M16 33 10 40 11 45"/>' +
    '<path d="M25 24 34 15 37 22M26 27 37 25 38 33M26 30 35 33 34 41M24 33 30 40 29 45"/>' +
    '</g>' +
    '<ellipse cx="20" cy="29" rx="7.6" ry="9" fill="#1d0d2e" stroke="#a66bff" stroke-width="1.2"/>' +
    '<circle cx="20" cy="18" r="5" fill="#1d0d2e" stroke="#a66bff" stroke-width="1.2"/>' +
    '<circle cx="18" cy="17.4" r="1.2" fill="#ff8a1f"/><circle cx="22" cy="17.4" r="1.2" fill="#ff8a1f"/>' +
    '<path d="M17.5 27.5 20 31l2.5-3.5" stroke="#ff8a1f" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
    '</svg>';

  var WEB =
    '<svg viewBox="0 0 130 130" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<g stroke="#e8dcff" stroke-width="1" fill="none" stroke-linecap="round">' +
    '<path d="M0 0 130 0M0 0 122 44M0 0 92 92M0 0 44 122M0 0 0 130"/>' +
    '<path d="M28 0Q26 26 0 28M52 0Q46 46 0 52M76 0Q66 66 0 76M100 0Q86 86 0 100M124 0Q104 104 0 124"/>' +
    '</g></svg>';

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  function build() {
    if (document.getElementById("hwBack")) return;

    var small = window.matchMedia("(max-width:760px)").matches;
    var reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;

    /* ---- capa de fondo (detrás del contenido) ---- */
    var back = el("div");
    back.id = "hwBack";
    back.setAttribute("aria-hidden", "true");
    back.appendChild(el("div", "hw-moon"));
    back.appendChild(el("div", "hw-fog"));

    if (!reduce) {
      var embers = small ? 8 : 16;
      for (var i = 0; i < embers; i++) {
        var s = rnd(2, 5);
        var e = el("span", "hw-ember");
        e.style.left = rnd(2, 98) + "%";
        e.style.width = e.style.height = s + "px";
        e.style.animationDuration = rnd(9, 20) + "s";
        e.style.animationDelay = "-" + rnd(0, 18) + "s";
        e.style.setProperty("--dx", rnd(-70, 70) + "px");
        back.appendChild(e);
      }
    }

    /* ---- capa frontal (encima, sin clics) ---- */
    var front = el("div");
    front.id = "hwFront";
    front.setAttribute("aria-hidden", "true");
    front.appendChild(el("div", "hw-web", WEB));
    front.appendChild(el("div", "hw-spider", "<i></i>" + SPIDER));

    if (!reduce) {
      var bats = small ? 2 : 4;
      for (var b = 0; b < bats; b++) {
        var bat = el("div", "hw-bat", BAT);
        bat.style.top = rnd(14, 52) + "%";
        bat.style.width = rnd(30, 52) + "px";
        bat.style.animationDuration = rnd(20, 34) + "s";
        bat.style.animationDelay = "-" + rnd(0, 30) + "s";
        bat.querySelector("svg").style.animationDuration = rnd(0.26, 0.42) + "s";
        front.appendChild(bat);
      }
    }

    document.body.appendChild(back);
    document.body.appendChild(front);
  }

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);
})();
