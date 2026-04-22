/* Ark docs shared JS — topbar/footer injection, theme toggle, TOC active state.
   Pages set <body data-root="" data-nav="..."> before loading this script. */
(function () {
  const root = document.body.dataset.root || "";
  const nav = document.body.dataset.nav || "";

  async function inject(selector, url) {
    const slot = document.querySelector(selector);
    if (!slot) return;
    const res = await fetch(root + url);
    const html = (await res.text()).replaceAll("{{ROOT}}", root);
    slot.outerHTML = html;
  }

  // Restore theme before injection so flash of wrong-theme chrome doesn't happen
  try {
    if (localStorage.getItem("ark-docs-theme") === "light")
      document.documentElement.classList.add("light");
  } catch (e) {}

  window.arkToggleTheme = function () {
    const h = document.documentElement;
    h.classList.toggle("light");
    try {
      localStorage.setItem("ark-docs-theme", h.classList.contains("light") ? "light" : "dark");
    } catch (e) {}
  };

  async function boot() {
    const page = document.body.dataset.page || "";
    async function injectInto(el, url) {
      const res = await fetch(root + url);
      const html = (await res.text()).replaceAll("{{ROOT}}", root);
      el.innerHTML = html;
    }
    const sidebarEl = document.querySelector("aside.sidebar[data-auto]");
    await Promise.all([
      inject("[data-slot=topbar]", "_partials/topbar.html"),
      inject("[data-slot=footer]", "_partials/footer.html"),
    ]);
    if (sidebarEl) {
      try {
        const r = await fetch(root + "_partials/sidebar.html");
        sidebarEl.innerHTML = (await r.text()).replaceAll("{{ROOT}}", root);
      } catch (e) { console.error("sidebar inject failed", e); }
    }
    // mark active nav
    if (nav) {
      const link = document.querySelector(`.topbar nav a[data-nav="${nav}"]`);
      if (link) link.classList.add("on");
    }
    // mark active sidebar page
    if (page && sidebarEl) {
      const item = sidebarEl.querySelector(`a.item[data-page="${page}"]`);
      if (item) item.classList.add("on");
    }
    // TOC active state
    const tocLinks = document.querySelectorAll("aside.toc a");
    const headings = Array.from(
      document.querySelectorAll("main.content h2[id], main.content h3[id]"),
    );
    if (tocLinks.length && headings.length) {
      function update() {
        const y = window.scrollY + 120;
        let active = headings[0];
        for (const h of headings) if (h.offsetTop <= y) active = h;
        tocLinks.forEach((a) =>
          a.classList.toggle("on", a.getAttribute("href") === "#" + (active && active.id)),
        );
      }
      window.addEventListener("scroll", update, { passive: true });
      update();
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
