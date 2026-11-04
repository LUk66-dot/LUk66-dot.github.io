// =====================================================================
//  PANIER DE LA STREET — serveur des commandes (Cloudflare Worker)
// =====================================================================
//  Réglages à faire dans Cloudflare : Settings → Variables and Secrets
//    BOT_TOKEN      (type Secret) le token donné par @BotFather
//    ADMIN_CHAT_ID  ton identifiant Telegram (le bot te le donne quand
//                   tu lui envoies /start, tant qu'il n'est pas réglé)
//    WEBAPP_URL     l'adresse de ta boutique : https://xxxx.github.io/...
//    APP_LINK       le lien de ta Mini App : https://t.me/TonBot/boutique
//    CHANNEL        ton canal, par exemple @paniedelastreet (pour /annonce)
//  Et une liaison KV nommée RL (anti-spam).
// =====================================================================

const MAX_PER_HOUR = 3;   // commandes maximum par heure et par client
const COOLDOWN_S = 120;   // attente minimum entre deux commandes (secondes)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === "/order" && request.method === "POST") return cors(await handleOrder(request, env));
      if (url.pathname === "/webhook" && request.method === "POST") return await handleWebhook(request, env);
      if (url.pathname === "/setup") return await setup(url, env);
      if (url.pathname === "/status") return cors(json({ ok: true, open: await isOpen(env) }));
      return text("Panier de la Street : serveur en ligne ✅\n\n" + checkConfig(env));
    } catch (e) {
      if (url.pathname === "/webhook") return new Response("ok");
      return cors(json({ ok: false, error: "server" }, 500));
    }
  }
};

// ---------- Vérification des réglages ----------
function checkConfig(env) {
  const rows = [
    ["BOT_TOKEN", !!env.BOT_TOKEN],
    ["ADMIN_CHAT_ID", !!env.ADMIN_CHAT_ID],
    ["WEBAPP_URL", !!env.WEBAPP_URL],
    ["APP_LINK", !!env.APP_LINK],
    ["CHANNEL", !!env.CHANNEL],
    ["RL (liaison KV)", !!env.RL],
  ];
  return rows.map(([k, ok]) => `${ok ? "✅" : "❌"} ${k}`).join("\n");
}

// ---------- Ouverture / fermeture de la boutique (/enligne et /offline) ----------
async function isOpen(env) {
  if (!env.RL) return true;
  return (await env.RL.get("shop:open")) === "1";
}
async function setOpen(env, open) {
  if (env.RL) await env.RL.put("shop:open", open ? "1" : "0");
}

// ---------- Installation du webhook (ouvre /setup une fois) ----------
async function setup(url, env) {
  if (!env.BOT_TOKEN) return text("❌ Il manque BOT_TOKEN dans les variables Cloudflare.");
  const r = await tg(env, "setWebhook", {
    url: `${url.origin}/webhook`,
    secret_token: await webhookSecret(env),
    allowed_updates: ["message", "callback_query"],
  });
  return text(r.ok
    ? "✅ Bot connecté au serveur. Envoie maintenant /start à ton bot dans Telegram.\n\n" + checkConfig(env)
    : "❌ Erreur Telegram : " + (r.description || "inconnue") + "\nVérifie ton BOT_TOKEN.");
}

// ---------- Réception d'une commande depuis la boutique ----------
async function handleOrder(request, env) {
  if (!env.BOT_TOKEN || !env.ADMIN_CHAT_ID) return json({ ok: false, error: "config" }, 503);
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: "bad" }, 400);

  // 0) La boutique est-elle ouverte ? (/enligne ou /offline)
  if (!(await isOpen(env))) return json({ ok: false, error: "closed" }, 403);

  // 1) Le client est-il vraiment un utilisateur Telegram ? (signature vérifiée)
  const user = await verifyInitData(String(body.initData || ""), env.BOT_TOKEN);
  if (!user || !user.id) return json({ ok: false, error: "auth" }, 401);

  // 2) Contrôle du contenu
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30)
    .map(i => ({ name: str(i.name, 80), qty: clamp(parseInt(i.qty, 10) || 0, 0, 5), price: money(i.price) }))
    .filter(i => i.name && i.qty > 0);
  if (!items.length) return json({ ok: false, error: "bad" }, 400);
  const mode = body.mode === "pickup" || body.mode === "delivery" ? body.mode : "";
  const slot = Number(body.slot) || 0;
  const addr = str(body.addr, 200);
  const tel = str(body.tel, 30);
  if (!mode) return json({ ok: false, error: "bad" }, 400);
  if (mode === "pickup" && !slot) return json({ ok: false, error: "bad" }, 400);
  if (mode === "delivery" && (addr.length < 8 || !/^(\+33\d{9}|0\d{9})$/.test(tel.replace(/[^\d+]/g, ""))))
    return json({ ok: false, error: "bad" }, 400);

  // 3) Anti-spam (par compte Telegram)
  const now = Date.now();
  const log = await getLog(env, user.id, now);
  if (log.length >= MAX_PER_HOUR)
    return json({ ok: false, error: "rate", wait: Math.ceil((log[0] + 3600e3 - now) / 1000) }, 429);
  const last = log[log.length - 1];
  if (last && now - last < COOLDOWN_S * 1000)
    return json({ ok: false, error: "rate", wait: Math.ceil((last + COOLDOWN_S * 1000 - now) / 1000) }, 429);

  // 4) Message pour toi
  const num = "PS-" + now.toString(36).slice(-5).toUpperCase();
  const total = money(body.total);
  const disc = money(body.disc);
  const ref = str(body.ref, 12);
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Client";
  const who = user.username ? `${esc(name)} (@${esc(user.username)})` : `<a href="tg://user?id=${user.id}">${esc(name)}</a>`;
  const lines = [
    `🛒 <b>Nouvelle commande ${num}</b>`,
    `👤 ${who}`,
    "",
    ...items.map(i => `• ${i.qty} × ${esc(i.name)} — ${eur(i.price)}`),
    "",
    `💶 <b>Total : ${eur(total)}</b>` + (disc > 0 ? ` (parrainage −${eur(disc)}, code ${esc(ref)})` : ""),
  ];
  if (mode === "pickup") lines.push(`🏪 <b>Retrait sur place</b> à ${hour(slot)}`);
  else lines.push(`🛵 <b>Livraison</b>`, `📍 ${esc(addr)}`, `📞 ${esc(tel)}`);

  const sent = await tg(env, "sendMessage", {
    chat_id: env.ADMIN_CHAT_ID,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[
      { text: mode === "pickup" ? "✅ Prête" : "🛵 En route", callback_data: `ok:${mode[0]}:${user.id}:${num}` },
      { text: "❌ Annuler", callback_data: `no:${user.id}:${num}` },
    ]] },
  });
  if (!sent.ok) return json({ ok: false, error: "send" }, 502);

  await addLog(env, user.id, log, now);

  // 5) Confirmation au client (s'il a autorisé le bot à lui écrire)
  await tg(env, "sendMessage", {
    chat_id: user.id,
    text: `✅ Commande ${num} reçue, merci !\n` +
      (mode === "pickup" ? `Retrait prévu à ${hour(slot)}. On te prévient quand elle est prête.` : "On te contacte pour la livraison."),
  }).catch(() => {});

  return json({ ok: true, num });
}

// ---------- Messages et boutons reçus par le bot ----------
async function handleWebhook(request, env) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== await webhookSecret(env))
    return new Response("forbidden", { status: 403 });
  const u = await request.json().catch(() => null);
  try {
    if (u && u.callback_query) await onButton(u.callback_query, env);
    else if (u && u.message) await onMessage(u.message, env);
  } catch (e) {}
  return new Response("ok");
}

async function onMessage(m, env) {
  if (!m.chat || m.chat.type !== "private" || !m.from) return;
  const chat_id = m.chat.id;
  const msg = m.text || m.caption || "";
  const isAdmin = env.ADMIN_CHAT_ID && String(m.from.id) === String(env.ADMIN_CHAT_ID);
  const shopButton = env.WEBAPP_URL ? { inline_keyboard: [[{ text: "🛒 Ouvrir la boutique", web_app: { url: env.WEBAPP_URL } }]] } : undefined;

  if (msg.startsWith("/start")) {
    let t = "🛒 <b>Bienvenue chez Panier de la Street !</b>\nCommande en quelques secondes, en retrait sur place ou en livraison.";
    if (!env.ADMIN_CHAT_ID)
      t += `\n\n🔧 <b>Réglage</b> : ton identifiant Telegram est <code>${m.from.id}</code>\nMets-le dans la variable ADMIN_CHAT_ID sur Cloudflare.`;
    if (isAdmin) t += "\n\n👑 Tu es l'administrateur. Envoie /aide pour voir ce que tu peux faire.";
    await tg(env, "sendMessage", { chat_id, text: t, parse_mode: "HTML", reply_markup: shopButton });
    return;
  }

  // Message transféré depuis le canal : le bot donne l'identifiant du canal
  const fwd = (m.forward_origin && m.forward_origin.chat) || m.forward_from_chat;
  if (isAdmin && fwd) {
    await tg(env, "sendMessage", {
      chat_id, parse_mode: "HTML",
      text: `📢 Canal « ${esc(fwd.title || "")} »\nIdentifiant : <code>${fwd.id}</code>\n\n` +
        `Mets <code>${fwd.username ? "@" + esc(fwd.username) : fwd.id}</code> dans la variable CHANNEL sur Cloudflare, puis Déployer.`,
    });
    return;
  }

  if (isAdmin && (msg.startsWith("/enligne") || msg.startsWith("/offline"))) {
    const open = msg.startsWith("/enligne");
    await setOpen(env, open);
    const custom = msg.replace(/^\/(enligne|offline)(@\w+)?\s*/, "");
    let posted = "";
    if (env.CHANNEL) {
      const t = custom || (open
        ? "🟢 Panier de la Street est EN LIGNE !\nLes commandes sont ouvertes, c'est le moment 🛒"
        : "🔴 Panier de la Street est fermé.\nLes commandes sont fermées pour le moment. À très vite !");
      const r = await tg(env, "sendMessage", {
        chat_id: env.CHANNEL, text: t,
        reply_markup: open && env.APP_LINK ? { inline_keyboard: [[{ text: "🛒 Commander", url: env.APP_LINK }]] } : undefined,
      });
      posted = r.ok ? "📣 Message publié dans le canal." : "⚠️ Message non publié dans le canal : " + (r.description || "");
    }
    await tg(env, "sendMessage", {
      chat_id,
      text: (open ? "🟢 Boutique ouverte : les commandes sont acceptées." : "🔴 Boutique fermée : plus aucune commande n'est acceptée.") +
        (posted ? "\n" + posted : ""),
    });
    return;
  }

  if (isAdmin && msg.startsWith("/statut")) {
    const open = await isOpen(env);
    await tg(env, "sendMessage", { chat_id, text: open ? "🟢 La boutique est ouverte." : "🔴 La boutique est fermée." });
    return;
  }

  if (isAdmin && msg.startsWith("/aide")) {
    await tg(env, "sendMessage", {
      chat_id, parse_mode: "HTML",
      text: "👑 <b>Commandes administrateur</b>\n\n" +
        "🟢 <b>/enligne</b>\nOuvre les commandes et l'annonce dans le canal (tu peux ajouter ton propre texte après).\n\n" +
        "🔴 <b>/offline</b>\nFerme les commandes et l'annonce dans le canal.\n\n" +
        "ℹ️ <b>/statut</b>\nTe dit si la boutique est ouverte ou fermée.\n\n" +
        "📣 <b>/annonce ton texte</b>\nPublie un post dans le canal avec un bouton « Commander ».\n\n" +
        "📸 Envoie une <b>photo ou une vidéo</b> avec la légende <b>/annonce ton texte</b> pour la publier avec le bouton.\n\n" +
        "🛒 Les commandes arrivent ici avec les boutons « Prête » et « Annuler », qui préviennent le client.",
    });
    return;
  }

  if (isAdmin && msg.startsWith("/annonce")) {
    if (!env.CHANNEL || !env.APP_LINK) {
      await tg(env, "sendMessage", { chat_id, text: "❌ Il manque CHANNEL ou APP_LINK dans les variables Cloudflare." });
      return;
    }
    const caption = msg.replace(/^\/annonce(@\w+)?\s*/, "");
    const reply_markup = { inline_keyboard: [[{ text: "🛒 Commander", url: env.APP_LINK }]] };
    let r;
    if (m.photo) r = await tg(env, "sendPhoto", { chat_id: env.CHANNEL, photo: m.photo[m.photo.length - 1].file_id, caption, reply_markup });
    else if (m.video) r = await tg(env, "sendVideo", { chat_id: env.CHANNEL, video: m.video.file_id, caption, reply_markup });
    else if (caption) r = await tg(env, "sendMessage", { chat_id: env.CHANNEL, text: caption, reply_markup });
    else {
      await tg(env, "sendMessage", { chat_id, text: "Écris ton texte après /annonce, par exemple :\n/annonce Nouveau drop dispo !" });
      return;
    }
    let help = "";
    const d = String(r.description || "");
    if (/chat not found/i.test(d))
      help = `Le bot ne trouve pas le canal « ${env.CHANNEL} ». Transfère-moi n'importe quel message de ton canal : je te donnerai la bonne valeur à mettre dans CHANNEL.`;
    else if (/not enough rights|administrator|forbidden|kicked|not a member/i.test(d))
      help = "Le bot n'a pas le droit de publier. Dans les infos du canal : Administrateurs → ton bot → active « Publier des messages ».";
    await tg(env, "sendMessage", {
      chat_id,
      text: r.ok ? "✅ Publié dans le canal." : "❌ Publication impossible.\n" + (help || "Détail : " + d),
    });
    return;
  }

  await tg(env, "sendMessage", { chat_id, text: "Pour commander, appuie sur le bouton ci-dessous 👇", reply_markup: shopButton });
}

async function onButton(cq, env) {
  if (!env.ADMIN_CHAT_ID || String(cq.from.id) !== String(env.ADMIN_CHAT_ID)) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }
  const p = String(cq.data || "").split(":");
  let customer, num, toCustomer, label;
  if (p[0] === "ok") {
    customer = p[2]; num = p[3];
    toCustomer = p[1] === "p" ? `✅ Ta commande ${num} est prête ! Tu peux venir la récupérer.` : `🛵 Ta commande ${num} est en route !`;
    label = p[1] === "p" ? "✅ Marquée prête" : "🛵 Marquée en route";
  } else if (p[0] === "no") {
    customer = p[1]; num = p[2];
    toCustomer = `❌ Ta commande ${num} a été annulée. Contacte-nous si tu as une question.`;
    label = "❌ Annulée";
  } else {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }
  const r = await tg(env, "sendMessage", { chat_id: customer, text: toCustomer });
  if (cq.message) {
    await tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: (cq.message.text || "") + `\n\n${label}` + (r.ok ? " · client prévenu" : " · client non prévenu (il n'a pas autorisé le bot)"),
      entities: cq.message.entities || [],
    });
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: label });
}

// ---------- Anti-spam (stocké dans KV) ----------
async function getLog(env, id, now) {
  if (!env.RL) return [];
  let a = [];
  try { a = JSON.parse((await env.RL.get("rl:" + id)) || "[]"); } catch (e) {}
  return a.filter(t => now - t < 3600e3).sort((x, y) => x - y);
}
async function addLog(env, id, log, now) {
  if (!env.RL) return;
  await env.RL.put("rl:" + id, JSON.stringify([...log, now]), { expirationTtl: 3600 });
}

// ---------- Vérification de la signature Telegram ----------
async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc("WebAppData"), enc(botToken));
  const sig = hex(await hmac(secret, enc(dataCheck)));
  if (!safeEqual(sig, hash)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
}

// ---------- Outils ----------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: false }));
}
async function webhookSecret(env) { return (await sha256hex("webhook:" + env.BOT_TOKEN)).slice(0, 48); }
async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}
async function sha256hex(s) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc(s)))); }
const enc = s => new TextEncoder().encode(s);
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const money = v => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n >= 0 && n < 100000 ? n : 0; };
const eur = n => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const hour = ts => new Date(ts).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const text = t => new Response(t, { headers: { "content-type": "text/plain; charset=utf-8" } });
function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type");
  return new Response(res.body, { status: res.status, headers: h });
}
