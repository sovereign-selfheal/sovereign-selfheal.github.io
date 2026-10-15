// Theme chosen with the button (light or dark), applied before the page is drawn. Without a choice,
// the CSS follows the system setting. Storage can be blocked (private mode): then nothing happens.
(function () {
  "use strict";
  try {
    var t = window.localStorage.getItem("theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* no storage: follow the system */ }
})();
