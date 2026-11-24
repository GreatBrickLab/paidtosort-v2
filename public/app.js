// Renders only what the API returns. No hardcoded content.
(async () => {
  const app = document.getElementById("app");
  const res = await fetch("/api/v1/health", { headers: { accept: "application/json" } });
  const data = await res.json();
  const flat = {};
  (function walk(o, p) {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? p + "." + k : k;
      if (v && typeof v === "object") walk(v, key); else flat[key] = v;
    }
  })(data, "");
  if (data.service) document.title = data.service;
  const dl = document.createElement("dl");
  for (const [k, v] of Object.entries(flat)) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = String(v);
    dl.append(dt, dd);
  }
  app.replaceChildren(dl);
})();
