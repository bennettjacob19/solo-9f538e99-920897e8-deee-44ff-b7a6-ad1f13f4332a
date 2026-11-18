// Confirmation dialogs for destructive actions. Names are read from data
// attributes (already HTML-escaped by the template), never interpolated into
// inline JavaScript.
document.addEventListener("submit", function (event) {
  var form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.confirm) {
    return;
  }
  var name = form.dataset.name || "";
  if (!window.confirm(form.dataset.confirm.replace("{name}", name))) {
    event.preventDefault();
  }
});

// Resolve query box: progressive enhancement. Without JavaScript the form
// simply navigates to /resolve?name=<name> and the browser shows the JSON.
(function () {
  var form = document.getElementById("resolve-form");
  var out = document.getElementById("resolve-result");
  if (!form || !out || typeof window.fetch !== "function") {
    return;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function line(parent, text, className) {
    var p = document.createElement("p");
    if (className) {
      p.className = className;
    }
    p.textContent = text;
    parent.appendChild(p);
    return p;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var input = form.querySelector("input[name=name]");
    var name = (input && input.value ? input.value : "").trim();
    if (!name) {
      return;
    }
    clear(out);
    line(out, "查询中…", "muted small");
    window
      .fetch("/resolve?name=" + encodeURIComponent(name), {
        headers: { Accept: "application/json" },
      })
      .then(function (resp) {
        return resp.json().then(function (body) {
          return { status: resp.status, body: body };
        });
      })
      .then(function (result) {
        clear(out);
        var body = result.body || {};
        if (result.status !== 200 || !body.ok) {
          var message = body.error && body.error.message ? body.error.message : "查询失败";
          line(out, message, "bad-text");
          return;
        }
        line(out, "终点地址：" + body.address, "mono");
        var names = (body.chain || []).map(function (step) {
          return step.service;
        });
        if (names.length > 1) {
          line(out, "解析链：" + names.join(" → "), "mono small");
        }
        line(out, "目录版本：" + body.version, "muted small");
      })
      .catch(function () {
        clear(out);
        line(out, "查询失败：网络错误", "bad-text");
      });
  });
})();
