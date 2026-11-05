// =====================================================================
//  PANIER DE LA STREET — serveur des commandes (Cloudflare Worker)
// =====================================================================
//  Réglages dans Cloudflare : Paramètres → Variables et secrets
//    BOT_TOKEN      (type Secret) le token donné par @BotFather
//    ADMIN_CHAT_ID  ton identifiant Telegram (le bot te le donne quand
//                   tu lui envoies /start, tant qu'il n'est pas réglé)
//    WEBAPP_URL     l'adresse de ta boutique : https://xxxx.github.io/...
//    APP_LINK       le lien de ta Mini App : https://t.me/TonBot/boutique
//    CHANNEL        ton canal : @nomducanal, ou -100... pour un canal privé
//  Une liaison KV nommée RL.
//  Un déclencheur Cron toutes les 5 minutes (*/5 * * * *) : il publie les
//  posts programmés et supprime les messages clients au bout de 24 h.
// =====================================================================

const MAX_PER_HOUR = 3;     // commandes maximum par heure et par client
const COOLDOWN_S = 120;     // attente minimum entre deux commandes (secondes)
const DELETE_AFTER_H = 24;  // suppression des messages clients après X heures
const TZ = "Europe/Paris";

// Menu qui s'affiche quand tu tapes « / » dans la conversation avec ton bot
const ADMIN_COMMANDS = [
  { command: "enligne", description: "Ouvrir les commandes + publier un message" },
  { command: "offline", description: "Fermer les commandes + publier un message" },
  { command: "annonce", description: "Publier un post avec le bouton Commander" },
  { command: "programmer", description: "Programmer un post (ex : /programmer 18:30)" },
  { command: "programmes", description: "Voir et annuler les posts programmés" },
  { command: "sondage", description: "Sondage : /sondage Question | Choix 1 | Choix 2" },
  { command: "stats", description: "Abonnés, commandes et chiffre du jour" },
  { command: "commandes", description: "Liste des commandes du jour" },
  { command: "statut", description: "La boutique est-elle ouverte ?" },
  { command: "nettoyer", description: "Supprimer les vieux messages clients" },
  { command: "aide", description: "Toutes les commandes expliquées" },
];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await runScheduled(env);
      const minute = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
      if (minute < 5) await cleanup(env); // une fois par heure
    })());
  },
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

// ---------- Ouverture / fermeture de la boutique ----------
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
  if (r.ok) await setupCommands(env);
  return text(r.ok
    ? "✅ Bot connecté au serveur. Envoie maintenant /start à ton bot dans Telegram.\n\n" + checkConfig(env)
    : "❌ Erreur Telegram : " + (r.description || "inconnue") + "\nVérifie ton BOT_TOKEN.");
}
async function setupCommands(env) {
  await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Ouvrir la boutique" }] });
  if (env.ADMIN_CHAT_ID)
    await tg(env, "setMyCommands", { commands: ADMIN_COMMANDS, scope: { type: "chat", chat_id: Number(env.ADMIN_CHAT_ID) } });
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
    .map(i => ({ name: str(i.name, 80), qty: clamp(Math.round((parseFloat(i.qty) || 0) * 1000) / 1000, 0, 999), label: str(i.label, 40), price: money(i.price) }))
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
    ...items.map(i => i.label ? `• ${esc(i.name)} — ${esc(i.label)} — ${eur(i.price)}` : `• ${String(i.qty).replace(".", ",")} × ${esc(i.name)} — ${eur(i.price)}`),
    "",
    `💶 <b>Total : ${eur(total)}</b>` + (disc > 0 ? ` (parrainage −${eur(disc)}, code ${esc(ref)})` : ""),
  ];
  if (mode === "pickup") lines.push(`🏪 <b>Retrait sur place</b> à ${hour(slot)}`);
  else lines.push(`🛵 <b>Livraison</b>`, `📍 ${esc(addr)}`, `📞 ${esc(tel)}`);
  lines.push("", "💬 <i>Réponds à ce message pour écrire au client.</i>");

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
  if (env.RL) {
    // Pour /stats et /commandes (gardé 8 jours)
    await env.RL.put(`ord:${pad(now)}:${num}`, "1", {
      expirationTtl: 8 * 86400,
      metadata: { n: name.slice(0, 30), t: total, m: mode, s: slot },
    });
    // Pour pouvoir répondre au client en répondant à la notification (gardé 7 jours)
    if (sent.result && sent.result.message_id)
      await env.RL.put(`map:${sent.result.message_id}`, String(user.id), { expirationTtl: 7 * 86400 });
  }

  // 5) Confirmation au client (s'il a autorisé le bot à lui écrire)
  await sendToCustomer(env, "sendMessage", {
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
  if (!isAdmin) await track(env, chat_id, m.message_id);
  const send = isAdmin ? tg : sendToCustomer;
  const shopButton = env.WEBAPP_URL ? { inline_keyboard: [[{ text: "🛒 Ouvrir la boutique", web_app: { url: env.WEBAPP_URL } }]] } : undefined;

  if (msg.startsWith("/start")) {
    let t = "🛒 <b>Bienvenue chez Panier de la Street !</b>\nCommande en quelques secondes, en retrait sur place ou en livraison.";
    if (!env.ADMIN_CHAT_ID)
      t += `\n\n🔧 <b>Réglage</b> : ton identifiant Telegram est <code>${m.from.id}</code>\nMets-le dans la variable ADMIN_CHAT_ID sur Cloudflare.`;
    if (isAdmin) {
      t += "\n\n👑 Tu es l'administrateur. Tape « / » pour voir tes commandes, ou envoie /aide.";
      await setupCommands(env);
    }
    await send(env, "sendMessage", { chat_id, text: t, parse_mode: "HTML", reply_markup: shopButton });
    return;
  }

  if (!isAdmin) {
    await send(env, "sendMessage", { chat_id, text: "Pour commander, appuie sur le bouton ci-dessous 👇", reply_markup: shopButton });
    return;
  }

  // ===================== À partir d'ici : uniquement toi (admin) =====================

  // Réponse à une notification de commande → message envoyé au client
  if (m.reply_to_message && !msg.startsWith("/") && env.RL) {
    const customer = await env.RL.get("map:" + m.reply_to_message.message_id);
    if (customer) {
      const body = "💬 Message de Panier de la Street :\n\n";
      let r;
      if (m.photo) r = await sendToCustomer(env, "sendPhoto", { chat_id: customer, photo: m.photo[m.photo.length - 1].file_id, caption: body + (m.caption || "") });
      else r = await sendToCustomer(env, "sendMessage", { chat_id: customer, text: body + msg });
      await tg(env, "sendMessage", {
        chat_id, reply_to_message_id: m.message_id,
        text: r.ok ? "✅ Message envoyé au client." : "❌ Message non envoyé : le client n'a pas autorisé le bot à lui écrire. Contacte-le directement.",
      });
      return;
    }
  }

  // Message transféré depuis le canal : le bot donne l'identifiant du canal
  const fwd = (m.forward_origin && m.forward_origin.chat) || m.forward_from_chat;
  if (fwd) {
    await tg(env, "sendMessage", {
      chat_id, parse_mode: "HTML",
      text: `📢 Canal « ${esc(fwd.title || "")} »\nIdentifiant : <code>${fwd.id}</code>\n\n` +
        `Mets <code>${fwd.username ? "@" + esc(fwd.username) : fwd.id}</code> dans la variable CHANNEL sur Cloudflare, puis Déployer.`,
    });
    return;
  }

  // ----- Publications : /enligne, /offline, /annonce, /programmer -----
  const pendingKey = "pending:" + chat_id;
  const cmd = (msg.match(/^\/(enligne|offline|annonce)(@\w+)?(?=\s|$)/) || [])[1];
  if (cmd) {
    const rest = msg.replace(/^\/\w+(@\w+)?\s*/, "");
    if (rest || m.photo || m.video || m.animation) {
      if (env.RL) await env.RL.delete(pendingKey);
      await publish(env, chat_id, cmd, contentFrom(m, rest, msg.length - rest.length));
      return;
    }
    if (!env.RL) {
      await tg(env, "sendMessage", { chat_id, text: `Écris ton message juste après la commande, par exemple :\n/${cmd} Ton texte ici` });
      return;
    }
    await env.RL.put(pendingKey, cmd, { expirationTtl: 900 });
    const label = cmd === "enligne" ? "🟢 Ouverture" : cmd === "offline" ? "🔴 Fermeture" : "📣 Annonce";
    await askContent(env, chat_id, label, cmd !== "annonce" ? `⏭ /passer : ${cmd === "enligne" ? "ouvrir" : "fermer"} sans rien publier` : "");
    return;
  }

  if (msg.startsWith("/programmer")) {
    const arg = msg.replace(/^\/programmer(@\w+)?\s*/, "").trim();
    const when = parseWhen(arg);
    if (!when) {
      await tg(env, "sendMessage", {
        chat_id, parse_mode: "HTML",
        text: "📅 <b>Programmer un post</b>\n\nIndique l'heure, ou la date et l'heure :\n<code>/programmer 18:30</code>\n<code>/programmer 08/11 12:00</code>\n\nLe bot te demandera ensuite le message à publier.",
      });
      return;
    }
    if (!env.RL) { await tg(env, "sendMessage", { chat_id, text: "❌ Il faut la liaison KV « RL » pour programmer des posts." }); return; }
    await env.RL.put(pendingKey, "prog:" + when, { expirationTtl: 900 });
    await askContent(env, chat_id, `📅 Post programmé pour ${fmtWhen(when)}`, "");
    return;
  }

  const pending = env.RL ? await env.RL.get(pendingKey) : null;
  if (pending) {
    if (msg.startsWith("/annuler")) {
      await env.RL.delete(pendingKey);
      await tg(env, "sendMessage", { chat_id, text: "❌ Annulé, rien n'a changé." });
      return;
    }
    if (msg.startsWith("/passer") && (pending === "enligne" || pending === "offline")) {
      await env.RL.delete(pendingKey);
      await setOpen(env, pending === "enligne");
      await tg(env, "sendMessage", { chat_id, text: pending === "enligne" ? "🟢 Boutique ouverte (rien publié dans le canal)." : "🔴 Boutique fermée (rien publié dans le canal)." });
      return;
    }
    if (!msg.startsWith("/")) {
      await env.RL.delete(pendingKey);
      const c = contentFrom(m, msg, 0);
      if (pending.startsWith("prog:")) await schedulePost(env, chat_id, Number(pending.slice(5)), c);
      else await publish(env, chat_id, pending, c);
      return;
    }
  }

  // ----- Autres commandes -----
  if (msg.startsWith("/sondage")) {
    const parts = msg.replace(/^\/sondage(@\w+)?\s*/, "").split(/\s*\|\s*|\n+/).map(s => s.trim()).filter(Boolean);
    const question = parts[0], options = parts.slice(1);
    if (!question || options.length < 2 || options.length > 10) {
      await tg(env, "sendMessage", {
        chat_id, parse_mode: "HTML",
        text: "📊 <b>Sondage</b>\n\nSépare la question et les choix par des barres | :\n<code>/sondage Prochain drop ? | Baskets | Doudounes | Sacs</code>\n\nDe 2 à 10 choix.",
      });
      return;
    }
    if (!env.CHANNEL) { await tg(env, "sendMessage", { chat_id, text: "❌ Il manque CHANNEL dans les variables Cloudflare." }); return; }
    const r = await tg(env, "sendPoll", {
      chat_id: env.CHANNEL, question: question.slice(0, 300),
      options: options.map(t => ({ text: t.slice(0, 100) })), is_anonymous: true,
    });
    await tg(env, "sendMessage", {
      chat_id,
      text: r.ok ? "✅ Sondage publié dans le canal." : "❌ Sondage non publié.\n" + channelHelp(env, r.description),
      reply_markup: r.ok ? postButtons(r.result.message_id) : undefined,
    });
    return;
  }

  if (msg.startsWith("/programmes")) {
    if (!env.RL) return;
    const list = await env.RL.list({ prefix: "sched:" });
    if (!list.keys.length) { await tg(env, "sendMessage", { chat_id, text: "📅 Aucun post programmé.\nUtilise /programmer 18:30 pour en créer un." }); return; }
    for (const k of list.keys.slice(0, 20)) {
      const ts = Number(k.name.split(":")[1]);
      const preview = (k.metadata && k.metadata.p) || "";
      await tg(env, "sendMessage", {
        chat_id, text: `📅 ${fmtWhen(ts)}\n${preview}`,
        reply_markup: { inline_keyboard: [[{ text: "❌ Annuler ce post", callback_data: "us:" + k.name.slice(6) }]] },
      });
    }
    return;
  }

  if (msg.startsWith("/stats")) {
    const now = Date.now(), dayStart = startOfDay(now), weekStart = now - 7 * 86400e3;
    let today = 0, todaySum = 0, week = 0, weekSum = 0, sched = 0;
    if (env.RL) {
      const orders = await listAll(env, "ord:");
      for (const k of orders) {
        const ts = Number(k.name.split(":")[1]), t = (k.metadata && k.metadata.t) || 0;
        if (ts >= weekStart) { week++; weekSum += t; }
        if (ts >= dayStart) { today++; todaySum += t; }
      }
      sched = (await env.RL.list({ prefix: "sched:" })).keys.length;
    }
    const subs = env.CHANNEL ? await tg(env, "getChatMemberCount", { chat_id: env.CHANNEL }) : null;
    await tg(env, "sendMessage", {
      chat_id, parse_mode: "HTML",
      text: "📊 <b>Statistiques</b>\n\n" +
        (subs && subs.ok ? `👥 Abonnés au canal : <b>${subs.result}</b>\n` : "") +
        ((await isOpen(env)) ? "🟢 Boutique ouverte\n" : "🔴 Boutique fermée\n") +
        `\n🛒 Aujourd'hui : <b>${today}</b> commande${today > 1 ? "s" : ""} · ${eur(todaySum)}` +
        `\n📅 7 derniers jours : <b>${week}</b> commande${week > 1 ? "s" : ""} · ${eur(weekSum)}` +
        `\n🗓 Posts programmés : ${sched}`,
    });
    return;
  }

  if (msg.startsWith("/commandes")) {
    if (!env.RL) return;
    const dayStart = startOfDay(Date.now());
    const orders = (await listAll(env, "ord:")).filter(k => Number(k.name.split(":")[1]) >= dayStart);
    if (!orders.length) { await tg(env, "sendMessage", { chat_id, text: "🛒 Aucune commande aujourd'hui pour l'instant." }); return; }
    let sum = 0;
    const rows = orders.slice(-50).map(k => {
      const [, ts, num] = k.name.split(":"), md = k.metadata || {};
      sum += md.t || 0;
      return `• ${hour(Number(ts))} · <b>${esc(num)}</b> · ${esc(md.n || "")} · ${eur(md.t || 0)} · ` +
        (md.m === "pickup" ? `🏪 ${md.s ? hour(md.s) : ""}` : "🛵");
    });
    await tg(env, "sendMessage", {
      chat_id, parse_mode: "HTML",
      text: `🛒 <b>Commandes du jour</b> (${orders.length})\n\n${rows.join("\n")}\n\n💶 Total : <b>${eur(sum)}</b>`,
    });
    return;
  }

  if (msg.startsWith("/nettoyer")) {
    const n = await cleanup(env);
    await tg(env, "sendMessage", { chat_id, text: `🧹 ${n} message(s) client de plus de 24 h supprimé(s).` });
    return;
  }

  if (msg.startsWith("/statut")) {
    await tg(env, "sendMessage", { chat_id, text: (await isOpen(env)) ? "🟢 La boutique est ouverte." : "🔴 La boutique est fermée." });
    return;
  }

  if (msg.startsWith("/aide")) {
    await setupCommands(env);
    await tg(env, "sendMessage", {
      chat_id, parse_mode: "HTML",
      text: "👑 <b>Tes commandes</b> (tape « / » pour le menu)\n\n" +
        "🟢 <b>/enligne</b> : ouvre les commandes. Le bot te demande ensuite ton message pour le canal (texte, photo ou vidéo).\n" +
        "🔴 <b>/offline</b> : ferme les commandes, même fonctionnement.\n" +
        "📣 <b>/annonce</b> : publie un post avec le bouton « Commander ».\n" +
        "📅 <b>/programmer 18:30</b> : publie un post plus tard (ou <code>/programmer 08/11 12:00</code>).\n" +
        "🗓 <b>/programmes</b> : voir et annuler les posts programmés.\n" +
        "📊 <b>/sondage Question | Choix 1 | Choix 2</b> : sondage dans le canal.\n\n" +
        "📈 <b>/stats</b> : abonnés, commandes et chiffre du jour et de la semaine.\n" +
        "🛒 <b>/commandes</b> : la liste des commandes du jour.\n" +
        "ℹ️ <b>/statut</b> : boutique ouverte ou fermée ?\n" +
        "🧹 <b>/nettoyer</b> : supprime les messages clients de plus de 24 h (automatique toutes les heures).\n\n" +
        "💡 Après chaque publication : boutons 📌 Épingler et 🗑 Supprimer.\n" +
        "💬 <b>Réponds</b> à une notification de commande pour écrire directement au client.\n" +
        "🛒 Boutons « Prête » / « Annuler » sur chaque commande : le client est prévenu.",
    });
    return;
  }

  await tg(env, "sendMessage", { chat_id, text: "Commande inconnue. Tape « / » pour voir le menu, ou envoie /aide." });
}

async function askContent(env, chat_id, label, extra) {
  await tg(env, "sendMessage", {
    chat_id, parse_mode: "HTML",
    text: `${label}\n\n✍️ <b>Envoie maintenant ton message</b> pour le canal : un texte, ou une photo / une vidéo avec ta légende.` +
      (extra ? `\n\n${extra}` : "") + "\n❌ /annuler : ne rien faire",
  });
}

// ---------- Boutons ----------
async function onButton(cq, env) {
  const answer = (t, alert) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: t, show_alert: !!alert });
  if (!env.ADMIN_CHAT_ID || String(cq.from.id) !== String(env.ADMIN_CHAT_ID)) { await answer(); return; }
  const p = String(cq.data || "").split(":");
  const msgRef = cq.message ? { chat_id: cq.message.chat.id, message_id: cq.message.message_id } : null;
  const appendToMessage = async (line, keep) => {
    if (!msgRef) return;
    await tg(env, "editMessageText", {
      ...msgRef, text: (cq.message.text || "") + "\n\n" + line, entities: cq.message.entities || [],
      reply_markup: keep ? cq.message.reply_markup : undefined,
    });
  };

  if (p[0] === "pin") {
    const r = await tg(env, "pinChatMessage", { chat_id: env.CHANNEL, message_id: Number(p[1]) });
    if (r.ok) { await answer("📌 Épinglé dans le canal"); return; }
    await answer("Impossible d'épingler. Donne au bot le droit « Modifier les messages » dans le canal.", true);
    return;
  }
  if (p[0] === "rm") {
    const r = await tg(env, "deleteMessage", { chat_id: env.CHANNEL, message_id: Number(p[1]) });
    if (r.ok) { await appendToMessage("🗑 Supprimé du canal"); await answer("🗑 Supprimé"); return; }
    await answer("Impossible de supprimer : " + (r.description || ""), true);
    return;
  }
  if (p[0] === "us") {
    if (env.RL) await env.RL.delete(`sched:${p[1]}:${p[2]}`);
    await appendToMessage("❌ Programmation annulée");
    await answer("Programmation annulée");
    return;
  }

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
    await answer();
    return;
  }
  const r = await sendToCustomer(env, "sendMessage", { chat_id: customer, text: toCustomer });
  await appendToMessage(label + (r.ok ? " · client prévenu" : " · client non prévenu (il n'a pas autorisé le bot)"));
  await answer(label);
}

// ---------- Publier dans le canal ----------
function contentFrom(m, text, prefixLen) {
  return {
    text: text || "",
    entities: shiftEntities(m.photo || m.video || m.animation ? m.caption_entities : m.entities, prefixLen),
    photo: m.photo ? m.photo[m.photo.length - 1].file_id : undefined,
    video: m.video ? m.video.file_id : undefined,
    animation: m.animation ? m.animation.file_id : undefined,
  };
}
const hasContent = c => !!(c.text || c.photo || c.video || c.animation);
async function postToChannel(env, kind, c) {
  const reply_markup = kind === "offline" ? undefined : { inline_keyboard: [[{ text: "🛒 Commander", url: env.APP_LINK }]] };
  const media = { chat_id: env.CHANNEL, caption: c.text, caption_entities: c.entities, reply_markup };
  if (c.photo) return tg(env, "sendPhoto", { ...media, photo: c.photo });
  if (c.video) return tg(env, "sendVideo", { ...media, video: c.video });
  if (c.animation) return tg(env, "sendAnimation", { ...media, animation: c.animation });
  return tg(env, "sendMessage", { chat_id: env.CHANNEL, text: c.text, entities: c.entities, reply_markup });
}
async function publish(env, chat_id, cmd, c) {
  if (!env.CHANNEL || (cmd !== "offline" && !env.APP_LINK)) {
    await tg(env, "sendMessage", { chat_id, text: "❌ Il manque CHANNEL ou APP_LINK dans les variables Cloudflare." });
    return;
  }
  if (!hasContent(c)) {
    await tg(env, "sendMessage", { chat_id, text: "Ton message est vide. Recommence avec du texte, une photo ou une vidéo." });
    return;
  }
  const r = await postToChannel(env, cmd, c);
  if (!r.ok) {
    await tg(env, "sendMessage", { chat_id, text: "❌ Publication impossible.\n" + channelHelp(env, r.description) + "\n\nLa boutique n'a pas changé d'état." });
    return;
  }
  let state = "";
  if (cmd === "enligne") { await setOpen(env, true); state = "\n🟢 Boutique ouverte : les commandes sont acceptées."; }
  if (cmd === "offline") { await setOpen(env, false); state = "\n🔴 Boutique fermée : plus aucune commande n'est acceptée."; }
  await tg(env, "sendMessage", { chat_id, text: "✅ Publié dans le canal." + state, reply_markup: postButtons(r.result && r.result.message_id) });
}
function postButtons(id) {
  if (!id) return undefined;
  return { inline_keyboard: [[{ text: "📌 Épingler", callback_data: `pin:${id}` }, { text: "🗑 Supprimer", callback_data: `rm:${id}` }]] };
}
function shiftEntities(list, prefixLen) {
  if (!Array.isArray(list)) return undefined;
  const out = list.filter(e => e.type !== "bot_command" && e.offset >= prefixLen).map(e => ({ ...e, offset: e.offset - prefixLen }));
  return out.length ? out : undefined;
}
function channelHelp(env, description) {
  const d = String(description || "");
  if (/chat not found/i.test(d))
    return `Le bot ne trouve pas le canal « ${env.CHANNEL} ». Transfère-moi n'importe quel message de ton canal : je te donnerai la bonne valeur à mettre dans CHANNEL.`;
  if (/not enough rights|administrator|forbidden|kicked|not a member/i.test(d))
    return "Le bot n'a pas le droit de publier. Dans les infos du canal : Administrateurs → ton bot → active « Publier des messages ».";
  return "Détail : " + d;
}

// ---------- Posts programmés ----------
async function schedulePost(env, chat_id, when, c) {
  if (!env.CHANNEL || !env.APP_LINK) {
    await tg(env, "sendMessage", { chat_id, text: "❌ Il manque CHANNEL ou APP_LINK dans les variables Cloudflare." });
    return;
  }
  if (!hasContent(c)) {
    await tg(env, "sendMessage", { chat_id, text: "Ton message est vide. Recommence avec /programmer." });
    return;
  }
  const id = Math.random().toString(36).slice(2, 8);
  const preview = (c.photo ? "📸 " : c.video ? "🎬 " : c.animation ? "🎞 " : "") + (c.text || "").slice(0, 60);
  const ttl = Math.max(120, Math.ceil((when - Date.now()) / 1000) + 2 * 86400);
  await env.RL.put(`sched:${pad(when)}:${id}`, JSON.stringify(c), { expirationTtl: ttl, metadata: { p: preview } });
  await tg(env, "sendMessage", {
    chat_id,
    text: `📅 C'est programmé pour ${fmtWhen(when)}.\nLe post sera publié avec le bouton « Commander ».`,
    reply_markup: { inline_keyboard: [[{ text: "❌ Annuler ce post", callback_data: `us:${pad(when)}:${id}` }]] },
  });
}
async function runScheduled(env) {
  if (!env.RL || !env.BOT_TOKEN || !env.CHANNEL) return 0;
  const now = Date.now();
  const list = await env.RL.list({ prefix: "sched:" });
  let n = 0;
  for (const k of list.keys) {
    if (Number(k.name.split(":")[1]) > now) break; // triées par date
    const raw = await env.RL.get(k.name);
    await env.RL.delete(k.name);
    if (!raw) continue;
    let c; try { c = JSON.parse(raw); } catch (e) { continue; }
    const r = await postToChannel(env, "annonce", c);
    if (env.ADMIN_CHAT_ID)
      await tg(env, "sendMessage", {
        chat_id: env.ADMIN_CHAT_ID,
        text: r.ok ? "📅 Ton post programmé vient d'être publié." : "❌ Ton post programmé n'a pas pu être publié.\n" + channelHelp(env, r.description),
        reply_markup: r.ok ? postButtons(r.result && r.result.message_id) : undefined,
      });
    n++;
  }
  return n;
}
function parseWhen(arg) {
  const mt = String(arg || "").match(/^(?:(\d{1,2})\/(\d{1,2})\s+)?(\d{1,2})\s*[:hH]\s*(\d{2})$/);
  if (!mt) return null;
  const h = +mt[3], mi = +mt[4];
  if (h > 23 || mi > 59) return null;
  const now = Date.now(), p = parisParts(now);
  let ts;
  if (mt[1]) {
    const d = +mt[1], mo = +mt[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    ts = parisToTs(p.y, mo, d, h, mi);
    if (ts < now) ts = parisToTs(p.y + 1, mo, d, h, mi);
  } else {
    ts = parisToTs(p.y, p.m, p.d, h, mi);
    if (ts <= now + 60e3) ts = parisToTs(p.y, p.m, p.d + 1, h, mi);
  }
  if (ts - now > 60 * 86400e3) return null; // 60 jours maximum
  return ts;
}

// ---------- Suppression des messages clients au bout de 24 h ----------
async function sendToCustomer(env, method, body) {
  const r = await tg(env, method, body);
  if (r.ok && r.result && r.result.message_id) await track(env, body.chat_id, r.result.message_id);
  return r;
}
async function track(env, chatId, messageId) {
  if (!env.RL || !chatId || !messageId) return;
  if (env.ADMIN_CHAT_ID && String(chatId) === String(env.ADMIN_CHAT_ID)) return; // jamais tes messages à toi
  await env.RL.put(`del:${pad(Date.now() + DELETE_AFTER_H * 3600e3)}:${chatId}:${messageId}`, "1", { expirationTtl: 47 * 3600 });
}
async function cleanup(env) {
  if (!env.RL || !env.BOT_TOKEN) return 0;
  const now = Date.now();
  let cursor, done = 0;
  for (let page = 0; page < 5; page++) {
    const list = await env.RL.list({ prefix: "del:", cursor });
    for (const k of list.keys) {
      const [, due, chatId, msgId] = k.name.split(":");
      if (Number(due) > now) return done; // triées par date : le reste est plus récent
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: Number(msgId) });
      await env.RL.delete(k.name);
      done++;
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return done;
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

// ---------- Dates (heure de Paris) ----------
function parisParts(ts) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
function parisToTs(y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = parisParts(guess);
  return guess - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - guess);
}
function startOfDay(ts) { const p = parisParts(ts); return parisToTs(p.y, p.m, p.d, 0, 0); }
const fmtWhen = ts => new Date(ts).toLocaleString("fr-FR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const hour = ts => new Date(ts).toLocaleTimeString("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

// ---------- Outils ----------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: false }));
}
async function listAll(env, prefix) {
  const out = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const l = await env.RL.list({ prefix, cursor });
    out.push(...l.keys);
    if (l.list_complete) break;
    cursor = l.cursor;
  }
  return out;
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
const pad = n => String(Math.round(n)).padStart(14, "0");
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const money = v => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n >= 0 && n < 100000 ? n : 0; };
const eur = n => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const text = t => new Response(t, { headers: { "content-type": "text/plain; charset=utf-8" } });
function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type");
  return new Response(res.body, { status: res.status, headers: h });
}
