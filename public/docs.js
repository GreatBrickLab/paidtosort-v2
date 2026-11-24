// API docs rendered from the OpenAPI spec served by the API. Nothing written by hand here.
(async () => {
  const root = document.getElementById("docs");
  const spec = await (await fetch("/api/v1/openapi.json")).json();
  const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };
  document.title = spec.info.title;
  root.append(el("h1", spec.info.title + " " + spec.info.version), el("p", spec.info.description || ""));
  const base = (spec.servers && spec.servers[0] && spec.servers[0].url) || "";
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      root.append(el("h2", method.toUpperCase() + " " + base + path), el("p", op.summary || ""));
      const ul = el("ul");
      for (const [code, r] of Object.entries(op.responses || {})) ul.append(el("li", code + ": " + r.description));
      root.append(ul);
    }
  }
  root.append(el("h2", "Schemas"), el("pre", JSON.stringify(spec.components.schemas, null, 2)));
})();
