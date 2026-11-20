/**
 * Relais Cloudflare pour le poêle Cola (module Wi-Fi Darwin / cloud Micronova Agua IOT).
 *
 * L'appli web l'appelle pour les actions immédiates (quelques secondes au lieu de 40) :
 *   GET  /etat                      -> lit le poêle en direct
 *   GET  /etat?journal=1&qui=Prénom -> idem, et note « Relevé demandé » dans l'historique
 *   POST /commande                  -> {"action":"on"|"off"|"regler", "qui":..., "texte":..., "valeurs":{...}}
 *
 *   GET  /widget?cle=...&format=texte -> état simplifié pour un widget (lecture seule)
 *   GET  /push/cle, POST /push/abonner, /push/desabonner, /push/test -> notifications
 * Toutes les 5 minutes (cron), il surveille le poêle et envoie les notifications
 * (allumage, extinction, alarmes, poêle injoignable).
 *
 * Le mode automatique (toutes les 30 min) reste sur GitHub.
 *
 * À configurer dans Cloudflare (Settings -> Variables and Secrets) :
 *   DARWIN_EMAIL, DARWIN_PASSWORD  (secrets) identifiants Darwin Evolution
 *   GITHUB_TOKEN                   (secret)  jeton GitHub avec Contents en lecture/écriture sur le dépôt Po-le
 *   GITHUB_REPO                    (dans wrangler.jsonc) ex. btapin/Po-le
 * Le compteur d'écritures en mémoire permanente est rangé dans eeprom.json (branche "etat").
 */

const API_URL = "https://cola.agua-iot.com";
const CUSTOMER_CODE = "475219";
const UNIQUE_ID = "c39adba4-278d-4e16-b454-a5a2313b336c";
const APP_ORIGIN = "https://btapin.github.io";

const READING_ERROR_VALUE = 0x8000;
const EEPROM_OFFSET = 32768;        // registres au-delà : mémoire permanente du poêle
const EEPROM_MAX_PAR_JOUR = 20;     // même limite que la bibliothèque Python
const HISTO_MAX = 100;

// Réglages modifiables depuis l'appli
const MODIFIABLES = {
  temp_air_set: "Consigne",
  power_set: "Puissance",
  vent_main_set: "Ventilation",
};

// ---------- Cache (conservé tant que le relais reste « chaud ») ----------
const cache = { token: null, exp: 0, refresh: null, device: null, registres: null, jetonsOk: new Map() };

// ============================================================
//  Petite calculatrice pour les formules des registres (#/2, #+30, IF(...)...)
//  (eval() est interdit dans Cloudflare Workers)
// ============================================================
function calculer(expr) {
  const tokens = expr.match(/\d+(?:\.\d+)?|[A-Za-z_]+|==|!=|>=|<=|[-+*/%(),<>]/g) || [];
  let i = 0;
  const voir = () => tokens[i];
  const prendre = () => tokens[i++];
  function primaire() {
    const t = prendre();
    if (t === undefined) throw new Error("Formule incomplète");
    if (t === "(") { const v = comparaison(); prendre(); return v; }
    if (t === "-") return -primaire();
    if (/^\d/.test(t)) return parseFloat(t);
    if (t === "IF" || t === "int") {
      prendre(); // (
      const args = [comparaison()];
      while (voir() === ",") { prendre(); args.push(comparaison()); }
      prendre(); // )
      if (t === "IF") return args[0] ? args[1] : args[2];
      return Math.trunc(args[0]);
    }
    throw new Error(`Formule inconnue : ${t}`);
  }
  function produit() {
    let v = primaire();
    while (["*", "/", "%"].includes(voir())) {
      const op = prendre(), d = primaire();
      v = op === "*" ? v * d : op === "/" ? v / d : v % d;
    }
    return v;
  }
  function somme() {
    let v = produit();
    while (["+", "-"].includes(voir())) {
      const op = prendre(), d = produit();
      v = op === "+" ? v + d : v - d;
    }
    return v;
  }
  function comparaison() {
    let v = somme();
    while (["==", "!=", ">=", "<=", ">", "<"].includes(voir())) {
      const op = prendre(), d = somme();
      v = { "==": v == d, "!=": v != d, ">=": v >= d, "<=": v <= d, ">": v > d, "<": v < d }[op] ? 1 : 0;
    }
    return v;
  }
  return comparaison();
}
const appliquerFormule = (formule, valeur) => calculer(String(formule).replaceAll("Mod", "%").replaceAll("#", String(valeur)));
const propre = v => (typeof v === "number" && Number.isFinite(v) && Math.round(v * 100) / 100 === Math.round(v) ? Math.round(v) : v);

// ============================================================
//  Cloud Micronova (Agua IOT)
// ============================================================
function entetes(extra = {}) {
  return {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json",
    Origin: "file://",
    id_brand: "1",
    customer_code: CUSTOMER_CODE,
    ...extra,
  };
}

function expirationJwt(jeton) {
  try {
    const b64 = jeton.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))).exp || 0;
  } catch { return 0; }
}

async function connexion(env) {
  const r1 = await fetch(API_URL + "/appSignup", {
    method: "POST", headers: entetes(),
    body: JSON.stringify({
      phone_type: "Android", phone_id: UNIQUE_ID, phone_version: "1.0", language: "en",
      id_app: UNIQUE_ID, push_notification_token: UNIQUE_ID, push_notification_active: false,
    }),
  });
  if (r1.status !== 201) throw new Error(`Micronova : enregistrement refusé (${r1.status})`);

  const r2 = await fetch(API_URL + "/userLogin", {
    method: "POST", headers: entetes({ local: "true", Authorization: UNIQUE_ID }),
    body: JSON.stringify({ email: env.DARWIN_EMAIL, password: env.DARWIN_PASSWORD }),
  });
  if (r2.status !== 200) throw new Error(`Micronova : identifiants Darwin refusés (${r2.status})`);
  const res = await r2.json();
  cache.token = res.token;
  cache.refresh = res.refresh_token;
  cache.exp = expirationJwt(res.token);
}

async function rafraichirJeton(env) {
  const r = await fetch(API_URL + "/refreshToken", {
    method: "POST", headers: entetes(), body: JSON.stringify({ refresh_token: cache.refresh }),
  });
  if (r.status !== 201) return connexion(env);
  const res = await r.json();
  cache.token = res.token;
  cache.exp = expirationJwt(res.token);
}

async function appel(env, methode, chemin, donnees, essai = 0) {
  if (!cache.token) await connexion(env);
  else if (Date.now() / 1000 > cache.exp - 30) await rafraichirJeton(env);
  const r = await fetch(API_URL + chemin, {
    method: methode,
    headers: entetes({ local: "false", Authorization: cache.token }),
    body: methode === "POST" ? JSON.stringify(donnees || {}) : undefined,
  });
  if (r.status === 401 && essai === 0) {
    cache.token = null;
    return appel(env, methode, chemin, donnees, 1);
  }
  if (r.status !== 200) throw new Error(`Micronova : ${chemin} a échoué (${r.status})`);
  return r.json();
}

async function preparer(env) {
  if (cache.device && cache.registres) return;
  const liste = await appel(env, "POST", "/deviceList", {});
  const dev = liste.device[0];
  if (!dev) throw new Error("Aucun poêle sur ce compte Darwin");
  const info = await appel(env, "POST", "/deviceGetInfo", { id_device: dev.id_device, id_product: dev.id_product });
  const idCarte = info.device_info[0].id_registers_map;
  const cartes = await appel(env, "POST", "/deviceGetRegistersMap", {
    id_device: dev.id_device, id_product: dev.id_product, last_update: "2018-06-03T08:59:54.043",
  });
  const registres = {};
  for (const carte of cartes.device_registers_map.registers_map) {
    if (carte.id === idCarte) for (const reg of carte.registers) registres[reg.reg_key.toLowerCase()] = reg;
  }
  cache.device = { id_device: dev.id_device, id_product: dev.id_product, nom: dev.name };
  cache.registres = registres;
}

/** Attend la réponse du poêle. Tant que ce n'est pas « completed » (waiting, Missing job answer...),
 *  on redemande : le module Wi-Fi met parfois quelques secondes à répondre. */
async function attendreTache(env, idRequest, delaiMax = 20000) {
  const fin = Date.now() + delaiMax;
  let pause = 1000, dernier = null;
  while (Date.now() < fin) {
    await new Promise(r => setTimeout(r, pause));
    let res;
    try { res = await appel(env, "GET", "/deviceJobStatus/" + idRequest); } catch { continue; }
    dernier = res;
    if (res.jobAnswerStatus === "completed") return res;
    pause = Math.min(pause + 500, 2000);
  }
  return dernier || { jobAnswerStatus: "pas de réponse" };
}

/** Lit toutes les valeurs du poêle : { nom_registre: valeur } (2 essais) */
async function lireRegistres(env) {
  await preparer(env);
  const d = cache.device;
  let res;
  for (let essai = 0; essai < 2; essai++) {
    const demande = await appel(env, "POST", "/deviceGetBufferReading", { id_device: d.id_device, id_product: d.id_product, BufferId: 1 });
    res = await attendreTache(env, demande.idRequest, essai === 0 ? 12000 : 15000);
    if (res.jobAnswerStatus === "completed") break;
  }
  if (res.jobAnswerStatus !== "completed") throw new Error(`Le poêle n'a pas répondu à la lecture (${res.jobAnswerStatus}), réessaie dans un instant`);
  const brut = {};
  res.jobAnswerData.Items.forEach((offset, i) => { brut[offset] = res.jobAnswerData.Values[i]; });

  const valeurs = {};
  for (const [cle, reg] of Object.entries(cache.registres)) {
    if (!("offset" in reg) || !(reg.offset in brut)) continue;
    const raw = Number(brut[reg.offset]);
    if (raw === READING_ERROR_VALUE) { valeurs[cle] = null; continue; }
    try { valeurs[cle] = propre(appliquerFormule(reg.formula, raw & reg.mask)); } catch { valeurs[cle] = null; }
  }
  return valeurs;
}

function description(cle, valeur, langue = "ENG") {
  const enc = cache.registres[cle] && cache.registres[cle].enc_val;
  if (!enc) return null;
  const item = enc.find(e => e.lang === langue && Number(e.value) === Number(valeur));
  return item ? item.description : null;
}

function valeurPourDescription(cle, desc, secours) {
  const enc = (cache.registres[cle] && cache.registres[cle].enc_val) || [];
  const item = enc.find(e => e.lang === "ENG" && e.description === desc);
  return item ? Number(item.value) : secours;
}

function valeurAEcrire(cle, valeur) {
  const reg = cache.registres[cle];
  if (!reg) throw new Error(`Réglage inconnu : ${cle}`);
  if (valeur < reg.set_min || valeur > reg.set_max) throw new Error(`${cle} : ${valeur} hors limites (${reg.set_min}-${reg.set_max})`);
  let v = Math.trunc(appliquerFormule(reg.formula_inverse, valeur));
  if (reg.is_hex) v = parseInt(String(v), 16);
  return v;
}

async function ecrire(env, valeursParCle) {
  await preparer(env);
  const d = cache.device;
  const cles = Object.keys(valeursParCle);
  const payload = {
    id_device: d.id_device, id_product: d.id_product, Protocol: "RWMSmaster",
    BitData: cles.map(() => 8), Endianess: cles.map(() => "L"),
    Items: cles.map(k => Number(cache.registres[k].offset)),
    Masks: cles.map(k => Number(cache.registres[k].mask)),
    Values: cles.map(k => valeurAEcrire(k, valeursParCle[k])),
  };
  const demande = await appel(env, "POST", "/deviceRequestWriting", payload);
  const res = await attendreTache(env, demande.idRequest);
  if (res.jobAnswerStatus !== "completed" || !res.jobAnswerData || !("Cmd" in res.jobAnswerData)) {
    throw new Error("Le poêle n'a pas confirmé la modification");
  }
}

// ---------- Limite d'écritures en mémoire permanente ----------
function jourParis() {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
}
async function reserverEeprom(env, nombre) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw new Error("Compteur de sécurité indisponible (GITHUB_TOKEN manquant) : modification refusée");
  const jour = jourParis();
  let refus = null;
  await ecrireFichier(env, "eeprom.json", ancien => {
    let c = {};
    try { c = JSON.parse(ancien || "{}"); } catch { c = {}; }
    const deja = c.jour === jour ? Number(c.ecritures) || 0 : 0;
    if (deja + nombre > EEPROM_MAX_PAR_JOUR) {
      refus = `Limite de ${EEPROM_MAX_PAR_JOUR} modifications de réglages par jour atteinte (protection de la mémoire du poêle)`;
      return null;  // rien à écrire
    }
    return JSON.stringify({ jour, ecritures: deja + nombre });
  });
  if (refus) throw new Error(refus);
}

// ============================================================
//  État au même format que etat.json
// ============================================================
function construireEtat(v, action) {
  const statut = v.status_get;
  const texte = description("status_get", statut) || (statut === 0 ? "OFF" : statut !== undefined ? String(statut) : null);
  const eteint = statut === null || statut === undefined ? null : statut === 0 || /off/i.test(texte || "");
  const enAlarme = statut === 8 || statut === 9;
  const codeAlarme = Number(v.alarms_get) || 0;
  return {
    nom: cache.device.nom,
    alarme: enAlarme ? { code: codeAlarme, texte: codeAlarme ? descriptionAlarme(codeAlarme) : (statut === 9 ? "Alarme mémorisée" : "Alarme") } : null,
    etat: texte,
    statut,
    eteint,
    temperature: v.temp_air_get ?? null,
    consigne: v.temp_air_set ?? null,
    puissance: v.power_set ?? null,
    puissance_reelle: v.real_power_get ?? null,
    ventilation: v.vent_main_set ?? null,
    fumees: v.temp_gas_flue_get ?? null,
    action,
    horodatage: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    source: "relais",
  };
}

// ============================================================
//  Publication sur GitHub (branche "etat"), pour l'historique commun
// ============================================================
const b64enc = txt => { const o = new TextEncoder().encode(txt); let s = ""; for (const c of o) s += String.fromCharCode(c); return btoa(s); };
const b64dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), c => c.charCodeAt(0)));

async function github(env, chemin, options = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${chemin}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "poele-relais",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

// Les écritures sur GitHub passent une par une : deux enregistrements simultanés sur la même
// branche sont refusés par GitHub (conflit), ce qui faisait perdre des lignes d'historique.
let fileGithub = Promise.resolve();
function ecrireFichier(env, nom, modifier, branche = "etat") {
  const tache = fileGithub.then(() => ecrireFichierDirect(env, nom, modifier, branche));
  fileGithub = tache.catch(() => {});
  return tache;
}

// branche = null : branche principale du dépôt (jamais réécrite par GitHub Actions, contrairement à "etat")
async function ecrireFichierDirect(env, nom, modifier, branche = "etat") {
  let dernier = "";
  for (let essai = 0; essai < 5; essai++) {
    if (essai) await new Promise(r => setTimeout(r, 400 * essai));
    const r = await github(env, `/contents/${nom}${branche ? `?ref=${branche}` : ""}`);
    let sha, contenu = null;
    if (r.ok) { const j = await r.json(); sha = j.sha; contenu = b64dec(j.content); }
    const nouveau = modifier(contenu);
    if (nouveau === null) return;
    const w = await github(env, `/contents/${nom}`, {
      method: "PUT",
      body: JSON.stringify({ message: branche ? "Etat du poele (relais)" : `${nom} (appli)`, content: b64enc(nouveau), ...(branche ? { branch: branche } : {}), ...(sha ? { sha } : {}) }),
    });
    if (w.ok) return;
    dernier = `${w.status}`;
    if ([401, 403, 404].includes(w.status)) break;   // problème de jeton : inutile d'insister
  }
  console.log(`GitHub ${nom} : échec (${dernier})`);
  throw new Error(`GitHub ${nom} : ${dernier}`);
}

async function lireFichier(env, nom, defaut) {
  const r = await github(env, `/contents/${nom}?ref=etat`);
  if (!r.ok) return defaut;
  try { return JSON.parse(b64dec((await r.json()).content)); } catch { return defaut; }
}

async function publier(env, etat, evenement) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
  let erreur = null;
  if (evenement) {                        // l'historique d'abord : c'est le plus important
    try {
      await ecrireFichier(env, "historique.json", ancien => {
        let h = [];
        try { h = JSON.parse(ancien || "[]"); if (!Array.isArray(h)) h = []; } catch { h = []; }
        h.unshift(evenement);
        return JSON.stringify(h.slice(0, HISTO_MAX));
      });
      console.log("historique :", evenement.texte);
    } catch (e) { erreur = e; console.log("historique NON enregistré :", evenement.texte, "-", e.message); }
  }
  if (etat) {
    try { await ecrireFichier(env, "etat.json", () => JSON.stringify(etat)); }
    catch (e) { erreur = erreur || e; console.log("etat.json NON enregistré -", e.message); }
  }
  if (erreur) throw erreur;
}

// ============================================================
//  Journal des chauffes (chauffes.json) : début, fin, durée, températures, origine
// ============================================================
const CHAUFFES_MAX = 300;
const isoMaintenant = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

function ouvrirChauffe(env, temperature, origine) {
  return ecrireFichier(env, "chauffes.json", ancien => {
    const c = (() => { try { return JSON.parse(ancien || "{}"); } catch { return {}; } })();
    if (c.enCours) return null;                       // déjà une chauffe ouverte
    c.enCours = { debut: isoMaintenant(), tempDebut: temperature ?? null, origineDebut: origine };
    c.liste = c.liste || [];
    return JSON.stringify(c);
  });
}

function fermerChauffe(env, temperature, origine) {
  return ecrireFichier(env, "chauffes.json", ancien => {
    const c = (() => { try { return JSON.parse(ancien || "{}"); } catch { return {}; } })();
    if (!c.enCours) return null;
    const fin = isoMaintenant();
    const minutes = Math.max(0, Math.round((Date.parse(fin) - Date.parse(c.enCours.debut)) / 60000));
    c.liste = [{ ...c.enCours, fin, minutes, tempFin: temperature ?? null, origineFin: origine }, ...(c.liste || [])].slice(0, CHAUFFES_MAX);
    c.enCours = null;
    return JSON.stringify(c);
  });
}

function evenement(type, texte, qui, temperature) {
  const e = { horodatage: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"), type, mode: "manuel", texte };
  if (qui) e.qui = String(qui).slice(0, 40);
  if (temperature !== null && temperature !== undefined) e.temperature = temperature;
  return e;
}

// ============================================================
//  Sécurité : seuls les jetons GitHub ayant accès au dépôt sont acceptés
// ============================================================
async function jetonValide(env, jeton) {
  if (!jeton) return false;
  const connu = cache.jetonsOk.get(jeton);
  if (connu && connu > Date.now()) return true;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/poele.yml`, {
    headers: { Authorization: `Bearer ${jeton}`, Accept: "application/vnd.github+json", "User-Agent": "poele-relais" },
  });
  if (r.ok) { cache.jetonsOk.set(jeton, Date.now() + 10 * 60 * 1000); return true; }
  return false;
}

// ============================================================
//  Routes
// ============================================================
function reponse(corps, statut = 200) {
  // 204 (réponse au « pré-contrôle » du navigateur) : pas de contenu autorisé
  return new Response(statut === 204 ? null : JSON.stringify(corps), {
    status: statut,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}

async function traiter(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return reponse({}, 204);
  if (url.pathname === "/") return reponse({ ok: true, message: "Relais du poêle opérationnel" });

  // ----- Widget (lecture seule, clé secrète dans l'adresse) -----
  if (url.pathname === "/widget" && request.method === "GET") {
    if (!env.WIDGET_CLE || url.searchParams.get("cle") !== env.WIDGET_CLE) return reponse({ erreur: "Clé refusée" }, 401);
    return widget(env, url.searchParams.get("format"));
  }

  const jeton = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await jetonValide(env, jeton))) return reponse({ erreur: "Jeton refusé" }, 401);

  // ----- Lecture -----
  if (url.pathname === "/etat" && request.method === "GET") {
    const journal = url.searchParams.get("journal") === "1";
    const v = await lireRegistres(env);
    const etat = construireEtat(v, journal ? "Relevé demandé" : "Lecture en direct");
    const ev = journal ? evenement("releve", "Relevé demandé", url.searchParams.get("qui"), etat.temperature) : null;
    ctx.waitUntil(publier(env, etat, ev).catch(e => console.log("publication", e.message)));
    return reponse({ ok: true, etat });
  }

  // ----- Commandes -----
  if (url.pathname === "/commande" && request.method === "POST") {
    const corps = await request.json().catch(() => ({}));
    const qui = corps.qui || "";
    const avant = await lireRegistres(env);
    const etatAvant = construireEtat(avant, "");
    let ev;

    if ((corps.action === "on" || corps.action === "off") && etatAvant.alarme) {
      return reponse({ erreur: `Poêle en alarme (${etatAvant.alarme.texte}) : il doit être réarmé directement sur le poêle` }, 409);
    }
    if (corps.action === "on" || corps.action === "off") {
      const allumer = corps.action === "on";
      if (allumer && etatAvant.eteint === false) ev = evenement("rien", "Allumage demandé, mais déjà allumé", qui, etatAvant.temperature);
      else if (!allumer && etatAvant.eteint === true) ev = evenement("rien", "Extinction demandée, mais déjà éteint", qui, etatAvant.temperature);
      else {
        const valeur = valeurPourDescription("status_managed_get", allumer ? "ON" : "OFF", allumer ? 85 : 170);
        // status_managed_get est en mémoire vive : pas de limite d'écriture
        const reg = cache.registres.status_managed_get;
        if (!reg) throw new Error("Commande marche/arrêt introuvable sur ce poêle");
        await ecrireBrut(env, "status_managed_get", valeur);
        ev = evenement(allumer ? "allumage" : "extinction", allumer ? "Allumage manuel" : "Extinction manuelle", qui, etatAvant.temperature);
        ctx.waitUntil(annoncerCommande(env, allumer, qui, corps.endpoint, etatAvant.temperature).catch(e => console.log("annonce", e.message)));
        const origine = qui ? `par ${qui}` : "manuel";
        ctx.waitUntil((allumer ? ouvrirChauffe(env, etatAvant.temperature, origine) : fermerChauffe(env, etatAvant.temperature, origine))
          .catch(e => console.log("chauffes", e.message)));
      }
    } else if (corps.action === "regler") {
      const demandees = corps.valeurs || {};
      const aEcrire = {};
      for (const [cle, val] of Object.entries(demandees)) {
        if (!(cle in MODIFIABLES)) return reponse({ erreur: `Réglage non autorisé : ${cle}` }, 400);
        const n = Number(val);
        if (!Number.isFinite(n)) return reponse({ erreur: `Valeur invalide pour ${cle}` }, 400);
        if (avant[cle] !== n) aEcrire[cle] = n;
      }
      const texte = String(corps.texte || "Réglages du poêle modifiés").slice(0, 200);
      if (!Object.keys(aEcrire).length) {
        ev = evenement("reglages", `${texte} (déjà en place)`, qui, etatAvant.temperature);
      } else {
        const eeprom = Object.keys(aEcrire).filter(k => Number(cache.registres[k].offset) >= EEPROM_OFFSET).length;
        if (eeprom) await reserverEeprom(env, eeprom);
        await ecrire(env, aEcrire);
        ev = evenement("reglages", texte, qui, etatAvant.temperature);
        ctx.waitUntil(annoncerReglages(env, qui, texte, corps.endpoint).catch(e => console.log("annonce", e.message)));
      }
    } else {
      return reponse({ erreur: "Action inconnue" }, 400);
    }

    let apres;
    try { apres = await lireRegistres(env); } catch { apres = avant; }
    const etat = construireEtat(apres, ev.texte);
    ctx.waitUntil(publier(env, etat, ev).catch(e => console.log("publication", e.message)));
    return reponse({ ok: true, etat, evenement: ev });
  }

  // ----- Granulés : achats, sacs brûlés, entretiens (fichier granules.json, branche principale) -----
  if (url.pathname === "/granules" && request.method === "POST") {
    const corps = await request.json().catch(() => ({}));
    let resultat = null, erreur = null;
    await ecrireFichier(env, "granules.json", ancien => {
      let d;
      try { d = JSON.parse(ancien || "null"); } catch { d = null; }
      try { resultat = modifierGranules(d, corps, String(corps.qui || "").slice(0, 40)); }
      catch (e) { erreur = e.message; return null; }
      return JSON.stringify(resultat, null, 1);
    }, null);
    if (erreur) return reponse({ erreur }, 400);
    return reponse({ ok: true, donnees: resultat });
  }

  // ----- Annonce d'un changement de réglage du mode automatique (fait par l'appli sur GitHub) -----
  if (url.pathname === "/annonce" && request.method === "POST") {
    const corps = await request.json().catch(() => ({}));
    const texte = String(corps.texte || "").slice(0, 200);
    if (!texte) return reponse({ erreur: "Texte manquant" }, 400);
    ctx.waitUntil(annoncerReglages(env, String(corps.qui || "").slice(0, 40), texte, corps.endpoint).catch(e => console.log("annonce", e.message)));
    return reponse({ ok: true });
  }

  // ----- Diagnostic (codes d'alarme, commandes disponibles) -----
  if (url.pathname === "/diag" && request.method === "GET") {
    const v = await lireRegistres(env);
    const interessant = k => /alarm|allarm|status|reset|start|accens|on_|off_/.test(k);
    const details = {};
    for (const [k, r] of Object.entries(cache.registres)) {
      if (!interessant(k)) continue;
      details[k] = {
        valeur: v[k] ?? null, type: r.reg_type, offset: r.offset, min: r.set_min, max: r.set_max,
        ...(r.enc_val ? { libelles: r.enc_val.filter(e => e.lang === "FRA" || e.lang === "ENG").map(e => `${e.lang} ${e.value}=${e.description}`) } : {}),
        ...(r.enable_val ? { autorise_si: r.enable_val.map(e => e.value) } : {}),
      };
    }
    return reponse({ ok: true, registres: Object.keys(cache.registres).sort(), details });
  }

  // ----- Notifications -----
  if (url.pathname === "/push/cle" && request.method === "GET") {
    return reponse({ ok: true, cle: (await clesVapid(env)).public });
  }
  if (url.pathname.startsWith("/push/") && request.method === "POST") {
    const corps = await request.json().catch(() => ({}));
    const ab = corps.abonnement || {};
    if (url.pathname === "/push/abonner") {
      if (!ab.endpoint || !ab.keys || !ab.keys.p256dh || !ab.keys.auth) return reponse({ erreur: "Abonnement invalide" }, 400);
      await clesVapid(env);
      await ecrireFichier(env, "push.json", ancien => {
        const p = JSON.parse(ancien || "{}");
        p.abonnes = (p.abonnes || []).filter(a => a.endpoint !== ab.endpoint);
        p.abonnes.push({
          endpoint: ab.endpoint, keys: { p256dh: ab.keys.p256dh, auth: ab.keys.auth },
          qui: String(corps.qui || "").slice(0, 40),
          prefs: { marche: corps.prefs?.marche !== false, alarmes: corps.prefs?.alarmes !== false, reglages: corps.prefs?.reglages !== false,
            tempBasse: seuilTemp(corps.prefs?.tempBasse), tempHaute: seuilTemp(corps.prefs?.tempHaute) },
        });
        return JSON.stringify(p);
      });
      return reponse({ ok: true });
    }
    if (url.pathname === "/push/desabonner") {
      await ecrireFichier(env, "push.json", ancien => {
        const p = JSON.parse(ancien || "{}");
        p.abonnes = (p.abonnes || []).filter(a => a.endpoint !== ab.endpoint);
        return JSON.stringify(p);
      });
      return reponse({ ok: true });
    }
    if (url.pathname === "/push/test") {
      const p = await lireFichier(env, "push.json", {});
      const cible = (p.abonnes || []).find(a => a.endpoint === ab.endpoint);
      if (!cible) return reponse({ erreur: "Ce téléphone n'est pas abonné" }, 404);
      await envoyerPush(cible, p.vapid, { titre: "🔔 Notifications du poêle", texte: "Tout fonctionne : tu recevras les alertes ici.", tag: "test" });
      return reponse({ ok: true });
    }
  }

  return reponse({ erreur: "Adresse inconnue" }, 404);
}

// ============================================================
//  Notifications Web Push (RFC 8291 + VAPID RFC 8292), sans bibliothèque
// ============================================================
const b64u = {
  enc(bytes) { let s = ""; for (const c of new Uint8Array(bytes)) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { const b = str.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), c => c.charCodeAt(0)); },
};
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const texte = s => new TextEncoder().encode(s);

async function hkdf(salt, ikm, info, octets) {
  const cle = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, cle, octets * 8));
}

/** Chiffre un message pour un abonné (aes128gcm). `essai` permet d'imposer clé et sel (tests). */
async function chiffrerPush(abonnement, message, essai = {}) {
  const uaPublic = b64u.dec(abonnement.keys.p256dh);
  const auth = b64u.dec(abonnement.keys.auth);

  let paire;
  if (essai.asPrive) {
    const pub = b64u.dec(essai.asPublic);
    const jwk = { kty: "EC", crv: "P-256", d: essai.asPrive, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true };
    paire = { privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) };
    paire.brut = pub;
  } else {
    paire = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    paire.brut = new Uint8Array(await crypto.subtle.exportKey("raw", paire.publicKey));
  }
  const cleUa = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const partage = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: cleUa }, paire.privateKey, 256));

  const ikm = await hkdf(auth, partage, concat(texte("WebPush: info\0"), uaPublic, paire.brut), 32);
  const sel = essai.sel ? b64u.dec(essai.sel) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(sel, ikm, texte("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(sel, ikm, texte("Content-Encoding: nonce\0"), 12);

  const cleAes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const clair = concat(typeof message === "string" ? texte(message) : message, new Uint8Array([2]));
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cleAes, clair));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(sel, rs, new Uint8Array([paire.brut.length]), paire.brut, chiffre);
}

/** Jeton VAPID signé (ES256) pour le service de notification de l'abonné */
async function jetonVapid(endpoint, vapid) {
  const entete = b64u.enc(texte(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corps = b64u.enc(texte(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "https://btapin.github.io/poele-app/",
  })));
  const cle = await crypto.subtle.importKey("jwk", vapid.prive, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cle, texte(`${entete}.${corps}`));
  return `${entete}.${corps}.${b64u.enc(signature)}`;
}

async function nouvellesClesVapid() {
  const paire = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    public: b64u.enc(await crypto.subtle.exportKey("raw", paire.publicKey)),
    prive: await crypto.subtle.exportKey("jwk", paire.privateKey),
  };
}

/** Envoie une notification. Renvoie false si l'abonnement n'existe plus (à supprimer). */
async function envoyerPush(abonnement, vapid, notif) {
  const corps = await chiffrerPush(abonnement, JSON.stringify(notif));
  const r = await fetch(abonnement.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${await jetonVapid(abonnement.endpoint, vapid)}, k=${vapid.public}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: notif.urgent ? "high" : "normal",
    },
    body: corps,
  });
  if (r.status === 404 || r.status === 410) return false;
  if (!r.ok) console.log("push", r.status, await r.text().catch(() => ""));
  return true;
}

/** Clés VAPID : créées une seule fois puis rangées dans push.json */
async function clesVapid(env) {
  const p = await lireFichier(env, "push.json", {});
  if (p.vapid && p.vapid.public && p.vapid.prive) return p.vapid;
  const nouvelles = await nouvellesClesVapid();
  let retenues = nouvelles;
  await ecrireFichier(env, "push.json", ancien => {
    const q = JSON.parse(ancien || "{}");
    if (q.vapid && q.vapid.public) { retenues = q.vapid; return null; } // créées entre-temps
    q.vapid = nouvelles;
    return JSON.stringify(q);
  });
  return retenues;
}

/** Envoie une notification aux abonnés intéressés ; retire les abonnements expirés. */
async function notifier(env, p, categorie, notif, sauf = null) {
  const morts = [];
  for (const a of p.abonnes || []) {
    if (a.prefs && a.prefs[categorie] === false) continue;
    if (sauf && a.endpoint === sauf) continue;
    try { if (!(await envoyerPush(a, p.vapid, notif))) morts.push(a.endpoint); } catch (e) { console.log("push", e.message); }
  }
  if (morts.length) p.abonnes = p.abonnes.filter(a => !morts.includes(a.endpoint));
  return morts.length > 0;
}

const seuilTemp = v => { const n = Number(v); return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n >= 5 && n <= 35 ? n : null; };
const virg = t => String(t).replace(".", ",");
/** Alertes température propres à chaque téléphone : une notification au franchissement du seuil,
    puis silence jusqu'à ce que la température soit revenue de 0,5 °C (évite les rafales autour du seuil). */
async function alertesTemperature(p, etat, avant) {
  const memo = { ...((avant && avant.alertesTemp) || {}) }, morts = [];
  const t = etat.temperature;
  for (const a of p.abonnes || []) {
    const cle = a.endpoint.slice(-32), st = { ...(memo[cle] || {}) }, pr = a.prefs || {};
    const envois = [];
    if (pr.tempBasse != null) {
      if (!st.bas && t < pr.tempBasse) { st.bas = true; envois.push({ titre: `🥶 ${virg(t)} °C au salon`, texte: `Sous ton seuil de ${virg(pr.tempBasse)} °C · poêle ${etat.eteint ? "éteint" : "en marche"}`, tag: "temp-bas" }); }
      else if (st.bas && t >= pr.tempBasse + .5) st.bas = false;
    } else delete st.bas;
    if (pr.tempHaute != null) {
      if (!st.haut && t > pr.tempHaute) { st.haut = true; envois.push({ titre: `🥵 ${virg(t)} °C au salon`, texte: `Au-dessus de ton seuil de ${virg(pr.tempHaute)} °C · poêle ${etat.eteint ? "éteint" : "en marche"}`, tag: "temp-haut" }); }
      else if (st.haut && t <= pr.tempHaute - .5) st.haut = false;
    } else delete st.haut;
    for (const n of envois) { try { if (!(await envoyerPush(a, p.vapid, n))) morts.push(a.endpoint); } catch (e) { console.log("push temp", e.message); } }
    if (Object.keys(st).length) memo[cle] = st; else delete memo[cle];
  }
  if (morts.length) p.abonnes = p.abonnes.filter(a => !morts.includes(a.endpoint));
  return { memo, modifies: morts.length > 0 };
}

const fmtTemp = t => (t !== null && t !== undefined ? ` · ${String(t).replace(".", ",")} °C` : "");

// ============================================================
//  Granulés
// ============================================================
const LISTES_GRANULES = ["achats", "brulages", "entretiens", "rdv"];
function granulesVides() {
  return {
    version: 1,
    poeles: [{ id: "salon", nom: "Poêle salon" }, { id: "cuisine", nom: "Poêle cuisine" }],
    reglages: { capacite: 90, kgSac: 15, frequences: { regulier: 7, vitre: 2 } },
    achats: [], brulages: [], entretiens: [], rdv: [],
  };
}
/** Applique une opération de l'appli ; lève une erreur lisible si la demande est invalide. */
function modifierGranules(d, corps, qui) {
  d = d && typeof d === "object" ? d : granulesVides();
  for (const l of LISTES_GRANULES) if (!Array.isArray(d[l])) d[l] = [];
  const op = corps.op, liste = corps.liste;
  if (op === "reglages") {
    const r = corps.reglages || {};
    d.reglages = { ...d.reglages, ...r, frequences: { ...(d.reglages || {}).frequences, ...(r.frequences || {}) } };
    return d;
  }
  if (!LISTES_GRANULES.includes(liste)) throw new Error("Liste inconnue");
  const brut = corps.element || {};
  if (JSON.stringify(brut).length > 2000) throw new Error("Élément trop long");
  if (op === "supprimer") {
    const avant = d[liste].length;
    d[liste] = d[liste].filter(e => e.id !== corps.id);
    if (d[liste].length === avant) throw new Error("Élément introuvable (déjà supprimé ?)");
    return d;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(brut.date || ""))) throw new Error("Date invalide");
  const nombre = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
  const texte = (v, n = 120) => String(v || "").trim().slice(0, n);
  const e = { date: brut.date, note: texte(brut.note, 300) };
  if (liste === "achats" || liste === "brulages") {
    e.sacs = nombre(brut.sacs, 0.5, 500); if (e.sacs === null) throw new Error("Nombre de sacs invalide");
    e.marque = texte(brut.marque, 60) || "Générique";
  }
  if (liste === "achats") { e.prixSac = nombre(brut.prixSac, 0, 100); e.lieu = texte(brut.lieu, 80); }
  if (liste !== "achats") {
    if (!(d.poeles || []).some(p => p.id === brut.poele)) throw new Error("Poêle inconnu");
    e.poele = brut.poele;
  }
  if (liste === "entretiens" || liste === "rdv") {
    e.type = ["annuel", "regulier", "vitre", "annexe"].includes(brut.type) ? brut.type : "annexe";
    e.libelle = texte(brut.libelle, 80);
    e.cout = nombre(brut.cout, 0, 100000);
  }
  if (op === "ajouter") {
    e.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    e.qui = qui; e.cree = new Date().toISOString();
    d[liste].push(e);
  } else if (op === "modifier") {
    const i = d[liste].findIndex(x => x.id === corps.id);
    if (i < 0) throw new Error("Élément introuvable (supprimé entre-temps ?)");
    d[liste][i] = { ...d[liste][i], ...e, modifiePar: qui };
  } else throw new Error("Opération inconnue");
  d[liste].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return d;
}

/** Notification quand quelqu'un change un réglage (poêle ou mode automatique), sauf sur son propre téléphone. */
async function annoncerReglages(env, qui, texte, endpointAuteur) {
  const p = await lireFichier(env, "push.json", {});
  if (!p.vapid || !(p.abonnes || []).length) return;
  const notif = { titre: `⚙️ ${qui || "Quelqu'un"} a modifié les réglages`, texte, tag: "reglages" };
  const morts = await notifier(env, p, "reglages", notif, endpointAuteur);
  if (morts) await ecrireFichier(env, "push.json", ancien => {
    const q = JSON.parse(ancien || "{}");
    q.abonnes = (q.abonnes || []).filter(a => p.abonnes.some(b => b.endpoint === a.endpoint));
    return JSON.stringify(q);
  });
}

/** Notification immédiate quand quelqu'un allume/éteint depuis l'appli (pas pour son propre téléphone). */
async function annoncerCommande(env, allumer, qui, endpointAuteur, temperature) {
  const p = await lireFichier(env, "push.json", {});
  if (!p.vapid || !(p.abonnes || []).length) return;
  const nom = (cache.device && cache.device.nom) || "Poêle";
  const auteur = qui || "Quelqu'un";
  const notif = allumer
    ? { titre: `🔥 ${auteur} a allumé le poêle`, texte: `${nom}${fmtTemp(temperature)}`, tag: "marche" }
    : { titre: `❄️ ${auteur} a éteint le poêle`, texte: `${nom}${fmtTemp(temperature)}`, tag: "marche" };
  const morts = await notifier(env, p, "marche", notif, endpointAuteur);
  // La surveillance ne doit pas renvoyer la même information quelques minutes plus tard
  await ecrireFichier(env, "push.json", ancien => {
    const q = JSON.parse(ancien || "{}");
    q.dernier = { ...(q.dernier || {}), annonce: allumer ? "allumage" : "extinction", annonceLe: Date.now() };
    if (allumer) { q.dernier.eteint = false; q.dernier.marche = true; }
    if (morts) q.abonnes = (q.abonnes || []).filter(a => p.abonnes.some(b => b.endpoint === a.endpoint));
    return JSON.stringify(q);
  });
}

/** Qui est à l'origine d'un changement détecté ? (mode automatique GitHub, sinon inconnu) */
async function origineChangement(env, type) {
  const histo = await lireFichier(env, "historique.json", []);
  const limite = Date.now() - 40 * 60 * 1000;
  const e = (Array.isArray(histo) ? histo : []).find(x => x.type === type && Date.parse(x.horodatage) > limite);
  return e && e.mode === "auto" ? e : null;
}

// ============================================================
//  Mode automatique (thermostat), exécuté toutes les 5 minutes
//  Réglages : variables du dépôt GitHub (modifiées depuis l'appli)
// ============================================================
const DEFAUTS_AUTO = { TEMP_MIN: "18", TEMP_MAX: "20", HEURE_DEBUT: "06:30", HEURE_FIN: "22:00", AUTO: "on" };
const enMinutes = hhmm => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
const nombre = x => parseFloat(String(x).replace(",", "."));
const fr = x => String(x).replace(".", ",");

async function lireReglagesAuto(env) {
  const r = await github(env, "/actions/variables?per_page=30");
  if (!r.ok) throw new Error(`réglages du mode automatique illisibles (GitHub ${r.status}) : ajoute la permission « Variables : lecture » au jeton du relais`);
  const d = { ...DEFAUTS_AUTO };
  for (const x of (await r.json()).variables || []) if (x.name in d && String(x.value).trim()) d[x.name] = String(x.value).trim();
  return d;
}

/** Décide et agit. Renvoie null (rien à faire) ou { allumer, texte, raison }. */
async function thermostatAuto(env, etat) {
  const r = await lireReglagesAuto(env);
  if (/^(off|0|non|false)$/i.test(r.AUTO)) return null;
  if (etat.alarme) return null;                       // le poêle refuse toute commande en alarme
  const st = Number(etat.statut);
  const enMarche = [4, 5, 7].includes(st);             // Work, Brazier Clean, Stand-by
  const eteint = st === 0;                             // OFF (pas pendant l'allumage ni le nettoyage final)
  const hm = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  const maintenant = enMinutes(hm), debut = enMinutes(r.HEURE_DEBUT), fin = enMinutes(r.HEURE_FIN);
  const min = nombre(r.TEMP_MIN), max = nombre(r.TEMP_MAX), temp = etat.temperature;
  let action = null;

  if (maintenant >= fin && maintenant < fin + 10) {
    if (enMarche) action = { allumer: false, raison: `fin de plage ${r.HEURE_FIN}` };
  } else if (maintenant >= debut && maintenant < fin && temp !== null && temp !== undefined) {
    if (temp < min && eteint) action = { allumer: true, raison: `${fr(temp)} °C < ${fr(min)} °C` };
    else if (temp > max && enMarche) action = { allumer: false, raison: `${fr(temp)} °C > ${fr(max)} °C` };
  }
  if (!action) return null;

  await ecrireBrut(env, "status_managed_get",
    valeurPourDescription("status_managed_get", action.allumer ? "ON" : "OFF", action.allumer ? 85 : 170));
  action.texte = `${action.allumer ? "Allumage" : "Extinction"} automatique (${action.raison})`;
  return action;
}

// ============================================================
//  Surveillance toutes les 5 minutes
// ============================================================
// Libellés en français des alarmes de ce poêle (codes relevés par le diagnostic)
const ALARMES_FR = {
  1: "AL 2 – Sonde de fumées", 2: "AL 3 – Fumées trop chaudes", 4: "AL 4 – Panne du ventilateur de fumées",
  8: "AL 5 – Échec d'allumage", 16: "AL 6 – Plus de granulés", 32: "AL A – Sécurité eau",
  64: "AL 7 – Sécurité thermique", 128: "AL 7 – Sécurité thermique", 129: "AL C – Sonde eau S1",
  130: "AL B – Défaut de la vis sans fin", 132: "AL d – Eau trop chaude S3", 136: "AL E – Pression d'eau",
  144: "AL 9 – Tirage insuffisant", 160: "AL F – Eau trop chaude S1", 192: "AL G – Sonde eau S2",
  224: "AL I – Eau trop chaude S2", 240: "AL H – Sonde eau S3", 255: "AL 1 – Coupure de courant",
};
function descriptionAlarme(code) {
  return ALARMES_FR[code] || description("alarms_get", code, "FRA") || description("alarms_get", code, "ENG") || `code ${code}`;
}

async function surveiller(env) {
  const p = await lireFichier(env, "push.json", {});
  const avecNotifs = !!(p.vapid && (p.abonnes || []).length);
  const avant = p.dernier || null;
  let maintenant, etat;
  try {
    const v = await lireRegistres(env);
    etat = construireEtat(v, "Surveillance");
    const alarme = Number(v.alarms_get) || 0;
    const st = Number(etat.statut);
    const marche = st === 0 ? false : [2, 3, 4, 5, 7].includes(st) ? true : (avant ? avant.marche : undefined);
    const hm = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const trace = [...((avant && avant.trace) || []), `${hm}:${Number.isFinite(st) ? st : "?"}`].slice(-12);  // journal pour diagnostic
    maintenant = { eteint: etat.eteint, marche, alarme: etat.alarme ? (alarme || -1) : 0, statut: etat.etat, st, echecs: 0, injoignable: false, trace };
    // Un poêle en marche ne passe jamais directement à « éteint » (il fait d'abord son nettoyage final) :
    // une lecture à 0 juste après un état de marche est le plus souvent un raté du cloud Micronova.
    // On attend la confirmation au passage suivant avant d'en tenir compte.
    if (st === 0 && avant && !avant.echecs && [2, 3, 4, 5, 7].includes(avant.st) && !avant.zeroDouteux) {
      console.log("lecture à 0 douteuse après l'état", avant.st, ": confirmation au prochain passage");
      maintenant = { ...avant, trace, zeroDouteux: true };
      etat = null;
    }
  } catch (e) {
    cache.device = null; cache.registres = null;
    maintenant = { ...(avant || {}), echecs: ((avant && avant.echecs) || 0) + 1 };
    if (!avant || !avant.echecs) maintenant.premierEchec = Date.now();
  }

  const nom = (cache.device && cache.device.nom) || "Poêle";
  const temp = etat && etat.temperature !== null ? ` · ${String(etat.temperature).replace(".", ",")} °C` : "";
  const aEnvoyer = [];
  const aNoter = [];   // événements détectés à ajouter à l'historique

  // ----- Mode automatique -----
  let decision = null;
  if (etat) {
    try {
      decision = await thermostatAuto(env, etat);
      maintenant.erreurAuto = null;
    } catch (e) {
      maintenant.erreurAuto = e.message;
      if (!avant || avant.erreurAuto !== e.message) {
        const evErr = evenement("erreur", `Mode automatique : ${e.message}`.slice(0, 200), "", etat.temperature);
        evErr.mode = "auto"; ctxPublier(env, evErr);
      }
    }
    if (decision) {
      await (decision.allumer ? ouvrirChauffe(env, etat.temperature, "auto") : fermerChauffe(env, etat.temperature, "auto"))
        .catch(e => console.log("chauffes", e.message));
      const ev = evenement(decision.allumer ? "allumage" : "extinction", decision.texte, "", etat.temperature);
      ev.mode = "auto";
      await publier(env, { ...etat, action: decision.texte }, ev).catch(e => console.log("historique", e.message));
      aEnvoyer.push(["marche", {
        titre: decision.allumer ? "🔥 Le mode automatique a allumé le poêle" : "❄️ Le mode automatique a éteint le poêle",
        texte: `${nom} · ${decision.raison}`, tag: "marche",
      }]);
    } else if (new Date().getUTCMinutes() % 30 < 5) {
      enAttente.push(publier(env, etat, null).catch(() => {}));   // état frais pour l'appli toutes les 30 min
    }
  }

  // ----- Journal des chauffes : ce que la surveillance constate -----
  if (etat && !decision) {
    try {
      const st = Number(etat.statut);
      const c = await lireFichier(env, "chauffes.json", {});
      const ouverteDepuis = c.enCours ? Date.now() - Date.parse(c.enCours.debut) : 0;
      if ([2, 3, 4, 5, 7].includes(st) && !c.enCours) await ouvrirChauffe(env, etat.temperature, "detecte");
      // fin de chauffe : nettoyage final, alarme, ou éteint (si l'allumage a eu le temps de démarrer)
      else if (c.enCours && ([1, 6, 8, 9].includes(st) || (st === 0 && ouverteDepuis > 10 * 60 * 1000))) {
        await fermerChauffe(env, etat.temperature, etat.alarme ? "alarme" : "detecte");
      }
    } catch (e) { console.log("chauffes", e.message); }
  }

  if (etat && avant && maintenant.echecs === 0 && !decision) {
    const annonceRecente = avant.annonce && Date.now() - (avant.annonceLe || 0) < 60 * 60 * 1000 ? avant.annonce : null;
    if (avant.marche === false && maintenant.marche === true && annonceRecente !== "allumage") {
      const auto = await origineChangement(env, "allumage");
      if (!auto) aNoter.push(evenement("allumage", "Le poêle s'est allumé (Darwin, panneau du poêle…)", "", etat.temperature));
      aEnvoyer.push(["marche", auto
        ? { titre: "🔥 Le mode automatique a allumé le poêle", texte: `${nom}${temp}`, tag: "marche" }
        : { titre: "🔥 Le poêle s'est allumé", texte: `${nom}${temp}`, tag: "marche" }]);
    }
    if (avant.marche === true && maintenant.marche === false && annonceRecente !== "extinction" && !avant.alarme) {
      const auto = await origineChangement(env, "extinction");
      if (!auto) aNoter.push(evenement("extinction", "Le poêle s'est éteint (Darwin, panneau du poêle…)", "", etat.temperature));
      aEnvoyer.push(["marche", auto
        ? { titre: "❄️ Le mode automatique a éteint le poêle", texte: `${nom}${temp}`, tag: "marche" }
        : { titre: "❄️ Le poêle s'est éteint", texte: `${nom}${temp}`, tag: "marche" }]);
    }
    if (maintenant.alarme && maintenant.alarme !== avant.alarme) {
      const desc = etat.alarme.texte;
      aEnvoyer.push(["alarmes", { titre: etat.alarme.code === 16 ? "⚠️ Alerte : plus de granulés" : "⚠️ Alarme du poêle", texte: `${nom} : ${desc}. Réarmement à faire sur le poêle.`, tag: "alarme", urgent: true }]);
      ctxPublier(env, evenement("erreur", `Alarme du poêle : ${desc}`, "", etat && etat.temperature));
    }
    if (avant.alarme && !maintenant.alarme) aEnvoyer.push(["alarmes", { titre: "✅ Poêle réarmé", texte: `${nom} est sorti de l'alarme${maintenant.eteint ? " (éteint, prêt à être rallumé)" : ""}`, tag: "alarme" }]);
    if (avant.injoignable) {
      const minutes = avant.premierEchec ? Math.round((Date.now() - avant.premierEchec) / 60000) : null;
      const duree = minutes === null ? "" : minutes < 60 ? ` (coupure d'environ ${minutes} min)` : ` (coupure d'environ ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")})`;
      aEnvoyer.push(["alarmes", { titre: "📡 Poêle de nouveau joignable", texte: `${nom}${duree}`, tag: "joignable" }]);
      const ev = evenement("reconnexion", `Poêle de nouveau joignable${duree}`, "", etat.temperature);
      ev.mode = "detecte"; aNoter.push(ev);
    }
  }
  if (avant && maintenant.echecs === 0) {
    const annonce = avant.annonce, garde = Date.now() - (avant.annonceLe || 0) < 60 * 60 * 1000;
    const fait = (annonce === "allumage" && maintenant.marche === true) || (annonce === "extinction" && maintenant.marche === false);
    if (garde && !fait) { maintenant.annonce = annonce; maintenant.annonceLe = avant.annonceLe; }
  }
  if (decision) {
    maintenant.annonce = decision.allumer ? "allumage" : "extinction";
    maintenant.annonceLe = Date.now();
    if (decision.allumer) { maintenant.eteint = false; maintenant.marche = true; }
  }
  if (maintenant.echecs === 3) {   // 15 minutes sans réponse
    maintenant.injoignable = true;
    const ev = evenement("injoignable", "Poêle injoignable depuis 15 minutes (Wi-Fi, courant ou cloud Micronova ?)", "");
    ev.mode = "detecte";
    await publier(env, null, ev).catch(e => console.log("historique", e.message));
    aEnvoyer.push(["alarmes", { titre: "📡 Poêle injoignable", texte: "Pas de réponse depuis 15 minutes (Wi-Fi, courant ou cloud Micronova ?)", tag: "joignable", urgent: true }]);
  } else if (maintenant.echecs > 3) maintenant.injoignable = true;

  for (const ev of aNoter) {
    ev.mode = ev.mode === "manuel" ? "detecte" : ev.mode;
    await publier(env, null, ev).catch(e => console.log("historique", e.message));
  }

  // Anti-doublon : un message identique n'est pas renvoyé dans les 20 minutes
  const envoyes = { ...((avant && avant.envoyes) || {}) };
  for (const k of Object.keys(envoyes)) if (Date.now() - envoyes[k] > 20 * 60 * 1000) delete envoyes[k];
  for (let i = aEnvoyer.length - 1; i >= 0; i--) {
    const cle = `${aEnvoyer[i][1].titre}|${aEnvoyer[i][1].texte}`;
    if (envoyes[cle]) aEnvoyer.splice(i, 1); else envoyes[cle] = Date.now();
  }
  maintenant.envoyes = envoyes;

  let abonnesModifies = false;
  if (avecNotifs && etat && etat.temperature !== null && etat.temperature !== undefined) {
    const r = await alertesTemperature(p, etat, avant);
    maintenant.alertesTemp = r.memo; abonnesModifies = r.modifies;
  } else if (avant && avant.alertesTemp) maintenant.alertesTemp = avant.alertesTemp;
  if (!avecNotifs) aEnvoyer.length = 0;
  for (const [categorie, notif] of aEnvoyer) abonnesModifies = (await notifier(env, p, categorie, notif)) || abonnesModifies;

  const change = JSON.stringify(avant) !== JSON.stringify(maintenant);
  if (change || abonnesModifies) {
    await ecrireFichier(env, "push.json", ancien => {
      const q = JSON.parse(ancien || "{}");
      q.dernier = maintenant;
      if (abonnesModifies) q.abonnes = (q.abonnes || []).filter(a => p.abonnes.some(b => b.endpoint === a.endpoint));
      return JSON.stringify(q);
    });
  }
  await Promise.all(enAttente.splice(0));
}

const enAttente = [];
function ctxPublier(env, ev) { enAttente.push(publier(env, null, ev).catch(() => {})); }

// ---------- Widget ----------
let widgetCache = null;   // { quand, etat } : évite d'interroger le poêle à chaque rafraîchissement
async function widget(env, format) {
  let etat = widgetCache && Date.now() - widgetCache.quand < 3 * 60 * 1000 ? widgetCache.etat : null;
  if (!etat) {
    try { etat = construireEtat(await lireRegistres(env), "Widget"); widgetCache = { quand: Date.now(), etat }; }
    catch { cache.device = null; cache.registres = null; etat = await lireFichier(env, "etat.json", null); }
  }
  if (!etat) return new Response("Poêle : pas de données", { headers: { "Content-Type": "text/plain; charset=utf-8" } });

  const t = v => (v === null || v === undefined ? "--" : String(v).replace(".", ","));
  const statut = etat.alarme ? `⚠️ ${etat.alarme.texte}` : etat.eteint === true ? "❄️ Éteint" : etat.eteint === false ? "🔥 En marche" : "❔ Inconnu";
  const heure = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(etat.horodatage));
  const donnees = {
    statut, temperature: `${t(etat.temperature)} °C`, consigne: `${t(etat.consigne)} °C`, heure,
    ligne1: `${statut} · ${t(etat.temperature)} °C`,
    ligne2: `Consigne ${t(etat.consigne)} °C · relevé ${heure}`,
  };
  if (format === "kwgt") {
    // Texte mis en forme pour KWGT ([b] et [c=#couleur] ; KWGT ne gère pas [size] dans un texte)
    const couleur = etat.alarme ? "#FF6B6B" : etat.eteint === false ? "#FF7A2F" : "#A8C8FF";
    const texteKwgt =
      `[b]${t(etat.temperature)} °C[/b]  [c=${couleur}][b]${statut}[/b][/c]\n` +
      `[c=#B8AA9A]Consigne ${t(etat.consigne)} °C · ${heure}[/c]`;
    return new Response(texteKwgt, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (format === "texte") {
    return new Response(`${donnees.ligne1}\n${donnees.ligne2}`, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return reponse(donnees);
}

/** Écriture d'une valeur déjà au format du poêle (marche/arrêt). */
async function ecrireBrut(env, cle, valeur) {
  const d = cache.device, reg = cache.registres[cle];
  let v = Math.trunc(appliquerFormule(reg.formula_inverse || "#", valeur));
  if (reg.is_hex) v = parseInt(String(v), 16);
  const demande = await appel(env, "POST", "/deviceRequestWriting", {
    id_device: d.id_device, id_product: d.id_product, Protocol: "RWMSmaster",
    BitData: [8], Endianess: ["L"], Items: [Number(reg.offset)], Masks: [Number(reg.mask)], Values: [v],
  });
  const res = await attendreTache(env, demande.idRequest);
  if (res.jobAnswerStatus !== "completed" || !res.jobAnswerData || !("Cmd" in res.jobAnswerData)) {
    throw new Error("Le poêle n'a pas confirmé la commande");
  }
}

export default {
  async scheduled(event, env, ctx) {
    // Chaque exécution repart d'une file d'écriture neuve : Cloudflare interdit de poursuivre
    // une opération réseau commencée pendant une exécution précédente.
    fileGithub = Promise.resolve();
    ctx.waitUntil(surveiller(env).catch(e => console.log("surveillance", e.message)));
  },
  async fetch(request, env, ctx) {
    fileGithub = Promise.resolve();
    try {
      return await traiter(request, env, ctx);
    } catch (err) {
      // En cas d'erreur, on repart d'une connexion propre la fois suivante
      cache.device = null; cache.registres = null;
      const ev = evenement("erreur", `Erreur (relais) : ${err.message}`.slice(0, 200));
      ctx.waitUntil(publier(env, null, ev).catch(() => {}));
      return reponse({ erreur: err.message }, 502);
    }
  },
};
