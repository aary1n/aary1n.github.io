// aaryans.page. Everything here is optional: links and the blog list work without it.
(() => {
  // Night / paper toggle. The choice is applied before paint by the inline script in <head>; this only switches and saves it.
  const toggle = document.querySelector(".theme");
  if (toggle) {
    const root = document.documentElement;
    const sync = () => {
      const paper = root.dataset.theme === "paper";
      const label = paper ? "switch to night mode" : "switch to paper mode";
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", paper ? "#f2ede1" : "#11110e");
    };
    toggle.hidden = false;
    sync();
    toggle.addEventListener("click", () => {
      root.dataset.theme = root.dataset.theme === "paper" ? "night" : "paper";
      try { localStorage.setItem("theme", root.dataset.theme); } catch (e) { /* private mode: the toggle still works for this page */ }
      sync();
    });
  }

  // Blog legend: click a category to show only that; click it again to show everything.
  const legend = document.querySelector(".legend");
  if (legend) {
    legend.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-cat]");
      if (!btn) return;
      const on = btn.getAttribute("aria-pressed") !== "true";
      legend.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(on && b === btn)));
      document.querySelectorAll(".posts li[data-cat]").forEach((li) => {
        li.hidden = on && li.dataset.cat !== btn.dataset.cat;
      });
    });
  }
})();
