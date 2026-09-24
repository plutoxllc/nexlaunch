/* ============ NexLaunch — landing page ============ */

/* Market table: mix Amazon + TikTok demo rows */
(function renderMarketTable() {
  const tbody = document.querySelector("#market-table tbody");
  if (!tbody) return;

  const amzRows = AMZ_PRODUCTS.slice(0, 5).map(p => {
    const sales = estimateSalesFromBSR(p.bsr, p.category);
    return {
      emoji: p.emoji, name: p.name, cat: `${p.category} › ${p.sub}`,
      platform: "amz", price: p.price, rank: "#" + fmtNum(p.bsr),
      reviews: fmtNum(p.reviews), revenue: sales * p.price, sales, trend: p.trend
    };
  });

  const ttRows = TT_PRODUCTS.slice(0, 3).map(p => ({
    emoji: p.emoji, name: p.name, cat: `${p.category} › TikTok Shop`,
    platform: "tt", price: p.price, rank: (p.views7d / 1e6).toFixed(1) + "M views",
    reviews: fmtNum(p.creators) + " creators", revenue: p.unitsMo * p.price,
    sales: p.unitsMo, trend: p.trend
  }));

  const rows = [...amzRows, ...ttRows].sort((a, b) => b.revenue - a.revenue);

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><div class="prod-cell"><span class="thumb">${r.emoji}</span>
        <div><div class="t">${r.name}</div><div class="c">${r.cat}</div></div></div></td>
      <td><span class="platform-pill ${r.platform}">${r.platform === "amz" ? "AMAZON" : "TIKTOK"}</span></td>
      <td class="mono">${fmtUSD(r.price, 2)}</td>
      <td class="mono">${r.rank}</td>
      <td class="mono">${r.reviews}</td>
      <td><span class="rev-green">${fmtUSD(r.revenue)}</span><span style="color:var(--muted);font-size:12px">/mo</span></td>
      <td class="mono">${fmtNum(r.sales)}<span style="color:var(--muted);font-size:12px">/mo</span></td>
      <td><span class="${r.trend >= 0 ? "trend-up" : "trend-down"}">${r.trend >= 0 ? "▲" : "▼"} ${Math.abs(r.trend).toFixed(1)}%</span></td>
    </tr>`).join("");
})();

/* Signup modal — every pricing/get-started button works */
(function signupModal() {
  const overlay = document.getElementById("signup-modal");
  const planEl = document.getElementById("modal-plan");
  const form = document.getElementById("signup-form");
  const msg = document.getElementById("signup-msg");

  document.querySelectorAll("[data-signup]").forEach(btn => {
    btn.addEventListener("click", () => {
      planEl.textContent = btn.dataset.plan || "Pro";
      overlay.classList.add("open");
      document.getElementById("su-name").focus();
    });
  });

  overlay.addEventListener("click", e => {
    if (e.target === overlay || e.target.hasAttribute("data-close")) overlay.classList.remove("open");
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") overlay.classList.remove("open"); });

  // Signup / login against the real API.
  //
  // This used to write the "account" straight into localStorage and redirect,
  // which meant there was no account: nothing to charge, nothing to protect,
  // and a paid plan was one devtools line away. The plan shown in the modal is
  // now only a hint about what they INTEND to buy - what they actually get is
  // decided by Stripe and set by the webhook.
  let mode = "signup";
  const nameField = document.getElementById("su-name").closest(".field");
  const submitBtn = document.getElementById("su-submit");
  const switchLink = document.getElementById("su-switch");
  const switchText = document.getElementById("su-switch-text");

  function setMode(next) {
    mode = next;
    const signingUp = mode === "signup";
    nameField.style.display = signingUp ? "" : "none";
    document.getElementById("su-name").required = signingUp;
    document.getElementById("su-password").setAttribute(
      "autocomplete", signingUp ? "new-password" : "current-password");
    submitBtn.textContent = signingUp ? "Create account \u2192" : "Log in \u2192";
    // The heading and subtitle belong to signup; in login mode they were
    // telling a returning customer they were creating an account and naming a
    // plan they had not chosen.
    const title = document.getElementById("su-title");
    const sub = document.getElementById("su-sub");
    if (title) title.textContent = signingUp ? "Create your account" : "Welcome back";
    if (sub) sub.style.display = signingUp ? "" : "none";
    switchText.textContent = signingUp ? "Already have an account?" : "Need an account?";
    switchLink.textContent = signingUp ? "Log in" : "Sign up";
    msg.classList.remove("ok", "err");
  }

  switchLink.addEventListener("click", e => {
    e.preventDefault();
    setMode(mode === "signup" ? "login" : "signup");
  });

  document.querySelectorAll("[data-open-login]").forEach(el => {
    el.addEventListener("click", e => {
      e.preventDefault();
      setMode("login");
      overlay.classList.add("open");
      document.getElementById("su-email").focus();
    });
  });

  function showError(text) {
    msg.textContent = text;
    msg.classList.remove("ok");
    msg.classList.add("err");
    msg.style.display = "block";
    submitBtn.disabled = false;
    submitBtn.textContent = mode === "signup" ? "Create account \u2192" : "Log in \u2192";
  }

  form.addEventListener("submit", e => {
    e.preventDefault();
    const email = document.getElementById("su-email").value.trim();
    const password = document.getElementById("su-password").value;
    const name = document.getElementById("su-name").value.trim();

    submitBtn.disabled = true;
    submitBtn.textContent = mode === "signup" ? "Creating\u2026" : "Signing in\u2026";

    const req = mode === "signup"
      ? NexAuth.signup({ email, password, name })
      : NexAuth.login({ email, password });

    req.then(r => {
      if (!r.ok) {
        showError(r.body.offline
          ? "Can't reach the NexLaunch API. Is the server running?"
          : (r.body.error || "Something went wrong."));
        return;
      }
      msg.textContent = mode === "signup"
        ? "Account created \u2014 opening your dashboard\u2026"
        : "Welcome back \u2014 opening your dashboard\u2026";
      msg.classList.remove("err");
      msg.classList.add("ok");
      msg.style.display = "block";
      setTimeout(() => { window.location.href = "app.html"; }, 700);
    });
  });
})();
