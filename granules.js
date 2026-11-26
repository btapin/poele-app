/* ============================================================
   Granulés : stock, achats, sacs brûlés, entretiens, statistiques, météo
   Données : granules.json (branche principale du dépôt), écrit par le relais Cloudflare.
   Météo : Open-Meteo (gratuit, sans clé), gardée en cache une journée sur le téléphone.
   Utilise les fonctions de l'appli : $, gh, relais, toast, esc, cfg, store.
   ============================================================ */
(() => {
const C_HEURES = "#d9a441";
const C_SALON = "#e0631a", C_CUISINE = "#4a98e0", C_EUROS = "#8f7fd6", C_PASSE = "#5d6178", C_TEMP = "#2bb3a3";
const COULEUR = { salon: C_SALON, cuisine: C_CUISINE };
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MOIS_COURT = ["Janv", "Févr", "Mars", "Avr", "Mai", "Juin", "Juil", "Août", "Sept", "Oct", "Nov", "Déc"];
const MOIS_LONG = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const JOURS = ["Dim.", "Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam."];
const TYPES_ENT = { annuel: "Entretien annuel", regulier: "Entretien régulier", vitre: "Nettoyage vitre", annexe: "Dépense annexe" };
const ICONE_ENT = { annuel: "🛠️", regulier: "🧹", vitre: "✨", annexe: "🧩" };
const VILLE_DEFAUT = { nom: "Bouhet", lat: 46.166, lon: -0.859 };
const BASE_DJU = 18;

let D = null, chauffes = null, meteo = null, reservoir = null;
let ecriture = false;
const infos = {};            // textes affichés au toucher d'une barre / d'un point
const etat = {
  vue: "tableau",
  poele: store.get("g.poele") || "tous",
  portee: store.get("g.portee") || "saison",
  graphe: store.get("g.graphe") || "7j", moyenne: "7j", filtreHisto: "tous", saisonStats: null, ouverts: new Set(),
  entPoele: "salon", heatMode: store.get("g.heat") || "sacs", meteoGraphe: store.get("g.meteoGraphe") !== "non", statSaison: "brules", statMois: "sacs",
};

/* ---------- Outils ---------- */
const nb = (v, d = 1) => { const n = Math.round(v * 10 ** d) / 10 ** d; return String(n).replace(".", ","); };
const euros = v => `${(Math.round(v * 100) / 100).toFixed(2).replace(".", ",")} €`;
const sacsTxt = n => `${nb(n)} sac${Math.abs(n) >= 2 ? "s" : ""}`;
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const aujourdhui = () => iso(new Date());
const date = s => { const [y, m, j] = s.split("-").map(Number); return new Date(y, m - 1, j); };
const ajouterJours = (s, n) => { const d = date(s); d.setDate(d.getDate() + n); return iso(d); };
const ecartJours = (a, b) => Math.round((date(b) - date(a)) / 864e5);
const dateCourte = s => { const d = date(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
const dateLongue = s => { const d = date(s); return `${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}`; };
const R = () => D.reglages;
const nomPoele = id => ((D.poeles || []).find(p => p.id === id) || { nom: id }).nom;
const courtPoele = id => nomPoele(id).replace(/^Poêle\s+/i, "").replace(/^./, c => c.toUpperCase());
const somme = (l, f = e => e.sacs) => l.reduce((x, e) => x + (f(e) || 0), 0);
const prixAchat = a => (a.prixSac || 0) * a.sacs;
const temp = t => t === null || t === undefined || isNaN(t) ? "--" : `${nb(t)} °C`;

/* Saisons : « 2026/27 » va du mois de début (octobre 2026) au mois de fin (avril 2027).
   Les mois creux sont partagés : la première moitié termine la saison, la seconde est la pré-saison suivante. */
function anneeSaison(s) {
  const d = date(s), m = d.getMonth() + 1, deb = R().saisonDebut, fin = R().saisonFin;
  if (deb <= fin) return d.getFullYear();
  const creux = deb - fin - 1, coupure = fin + Math.floor(creux / 2) + 1;
  return m >= coupure ? d.getFullYear() : d.getFullYear() - 1;
}
const nomSaison = a => R().saisonDebut <= R().saisonFin ? String(a) : `${a}/${String(a + 1).slice(2)}`;
function moisSaison(a) {
  const out = []; let y = a, m = R().saisonDebut;
  for (let i = 0; i < 12; i++) { out.push({ a: y, m }); if (m === R().saisonFin) break; m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const debutSaison = a => `${a}-${pad(R().saisonDebut)}-01`;
function finSaison(a) { const l = moisSaison(a).pop(); return `${l.a}-${pad(l.m)}-${pad(new Date(l.a, l.m, 0).getDate())}`; }
const enSaison = (e, a) => e.date >= debutSaison(a) && e.date <= finSaison(a);
const saisonCourante = () => anneeSaison(aujourdhui());
const dansPortee = e => etat.portee === "toujours" || anneeSaison(e.date) === saisonCourante();
const dePoele = (e, p = etat.poele) => p === "tous" || e.poele === p;
const libellePortee = () => etat.portee === "toujours" ? "depuis toujours" : `saison ${nomSaison(saisonCourante())}`;

/* ---------- Calculs ---------- */
function stockParMarque() {
  const s = {};
  for (const [m, n] of Object.entries(R().stockInitial || {})) s[m] = (s[m] || 0) + Number(n || 0);
  for (const a of D.achats) s[a.marque] = (s[a.marque] || 0) + a.sacs;
  for (const b of D.brulages) s[b.marque] = (s[b.marque] || 0) - b.sacs;
  return s;
}
const stockTotal = () => Object.values(stockParMarque()).reduce((x, y) => x + y, 0);
function consoMoyenne() {          // sacs par jour, deux poêles, pour l'autonomie
  const auj = aujourdhui(), sc = saisonCourante();
  const saison = D.brulages.filter(b => anneeSaison(b.date) === sc);
  if (saison.length) return somme(saison) / Math.max(7, ecartJours(saison[0].date, auj) + 1);
  const recents = D.brulages.filter(b => ecartJours(b.date, auj) < 30);
  return recents.length ? somme(recents) / 30 : 0;
}
function moyenneKgJour(periode) {
  const auj = aujourdhui();
  let debut;
  if (periode === "7j") debut = ajouterJours(auj, -6);
  else if (periode === "mois") debut = auj.slice(0, 8) + "01";
  else {
    const l = D.brulages.filter(b => anneeSaison(b.date) === saisonCourante() && dePoele(b));
    debut = l.length ? l[0].date : auj;
  }
  const l = D.brulages.filter(b => b.date >= debut && b.date <= auj && dePoele(b));
  const jours = ecartJours(debut, auj) + 1, kg = somme(l) * R().kgSac;
  return { kg: kg / jours, total: kg, jours, sacs: somme(l), debut };
}
/** Coût de chaque sac brûlé : les sacs les plus anciens d'une marque partent en premier (premier acheté, premier brûlé).
    Renvoie une Map id du brûlage -> coût en €. Le stock initial (sans prix) est compté au prix moyen. */
function coutsBrulages() {
  const pm = prixMoyenGlobal() || 0, lots = {}, couts = new Map();
  for (const [m, n] of Object.entries(R().stockInitial || {})) (lots[m] = lots[m] || []).push({ reste: Number(n) || 0, prix: pm });
  const evts = [...D.achats.map(a => ({ t: 0, e: a })), ...D.brulages.map(b => ({ t: 1, e: b }))]
    .sort((x, y) => x.e.date < y.e.date ? -1 : x.e.date > y.e.date ? 1 : x.t - y.t);
  for (const { t, e } of evts) {
    const l = lots[e.marque] = lots[e.marque] || [];
    if (t === 0) { l.push({ reste: e.sacs, prix: e.prixSac ?? pm }); continue; }
    let besoin = e.sacs, cout = 0;
    while (besoin > 1e-9 && l.length) {
      const lot = l[0], pris = Math.min(lot.reste, besoin);
      cout += pris * lot.prix; lot.reste -= pris; besoin -= pris;
      if (lot.reste <= 1e-9) l.shift();
    }
    cout += besoin * pm;            // sacs sans achat correspondant : prix moyen
    couts.set(e.id, cout);
  }
  return couts;
}
const coutDe = (liste, couts = coutsBrulages()) => liste.reduce((x, b) => x + (couts.get(b.id) || 0), 0);
function prixMoyenGlobal() {
  const l = D.achats.filter(a => a.prixSac); const s = somme(l);
  return s ? somme(l, prixAchat) / s : null;
}
function moyennePrix(achats) {
  const l = achats.filter(a => a.prixSac); const s = somme(l);
  return s ? somme(l, prixAchat) / s : null;
}
const estPreSaison = a => a.date < debutSaison(anneeSaison(a.date));
function rendementSalon() {
  const liste = (chauffes && chauffes.liste) || [];
  if (!liste.length) return { parSac: null, parMarque: {}, depuis: null };
  const debutJournal = liste.reduce((m, c) => c.debut < m ? c.debut : m, liste[0].debut).slice(0, 10);
  const brul = D.brulages.filter(b => b.poele === "salon");
  const minutesEntre = (a, b) => liste.filter(c => { const j = c.debut.slice(0, 10); return j > a && j <= b; })
    .reduce((x, c) => x + (c.minutes || 0), 0);
  const parMarque = {}; let min = 0, sacs = 0;
  for (let i = 1; i < brul.length; i++) {
    if (brul[i - 1].date < debutJournal) continue;
    const m = minutesEntre(brul[i - 1].date, brul[i].date);
    const pm = parMarque[brul[i].marque] = parMarque[brul[i].marque] || { min: 0, sacs: 0 };
    pm.min += m; pm.sacs += brul[i].sacs; min += m; sacs += brul[i].sacs;
  }
  // Moyenne globale : toutes les heures de chauffe ÷ tous les sacs brûlés au salon depuis le début du journal.
  // Les écarts du début et de la fin (granules restant dans le réservoir) se compensent avec le temps.
  const sacsTot = somme(brul.filter(b => b.date >= debutJournal));
  const minTot = liste.filter(c => c.debut.slice(0, 10) >= debutJournal).reduce((x, c) => x + (c.minutes || 0), 0)
    + (chauffes.enCours ? Math.max(0, Math.round((Date.now() - Date.parse(chauffes.enCours.debut)) / 60000)) : 0);
  return { parSac: sacsTot ? minTot / 60 / sacsTot : null, sacs: sacsTot, heures: minTot / 60, parMarque, depuis: debutJournal };
}

/* ---------- Temps de chauffe (poêle salon, journal chauffes.json) ---------- */
function minutesChauffe(debut, fin) {      // minutes de chauffe dont le début tombe entre deux dates (incluses)
  if (!chauffes) return null;
  let m = 0;
  for (const c of chauffes.liste || []) { const j = iso(new Date(c.debut)); if (j >= debut && j <= fin) m += c.minutes || 0; }
  const e = chauffes.enCours;
  if (e) { const j = iso(new Date(e.debut)); if (j >= debut && j <= fin) m += Math.max(0, Math.round((Date.now() - Date.parse(e.debut)) / 60000)); }
  return m;
}
const debutJournal = () => {
  if (!chauffes) return null;
  const l = (chauffes.liste || []).map(c => c.debut).concat(chauffes.enCours ? [chauffes.enCours.debut] : []);
  return l.length ? iso(new Date(l.sort()[0])) : null;
};
const duree = m => m === null || m === undefined ? "--" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)}`;
const avecChauffe = () => etat.poele !== "cuisine" && !!debutJournal();
/** Petit graphique « heures de chauffe » aligné sous un graphique de sacs (même découpage) */
function panneauHeures(periodes, { cle, etiquettes = true } = {}) {
  const dj = debutJournal();
  const cols = periodes.map(([deb, fin, lab, fort]) => {
    const m = fin < dj ? null : minutesChauffe(deb, fin);
    return { lab, fort, valeurs: { h: m ? Math.round(m / 6) / 10 : 0 }, info: m === null ? "" : `${duree(m)} de chauffe` };
  });
  return `<div class="gtit gpetit" style="margin-top:8px">⏱️ Heures de chauffe · Salon</div>${barres(cols, { cle, cles: ["h"], couleurs: { h: C_HEURES }, hauteur: 74, etiquettes, unite: "h" })}`;
}

/* ---------- Météo (Open-Meteo) ---------- */
const ville = () => (D && R().ville) || VILLE_DEFAUT;
async function chargerMeteo() {
  const v = ville(), auj = aujourdhui(), cle = `${v.lat},${v.lon}`;
  let cache = null;
  try { cache = JSON.parse(store.get("g.meteo") || "null"); } catch {}
  if (cache && cache.cle === cle && cache.jour === auj && Date.now() - cache.le < 3 * 3600e3) { meteo = cache; return; }
  if (cache && cache.cle === cle) meteo = cache;                       // affiché en attendant la mise à jour
  const debut = `${saisonCourante() - 6}-${pad(R().saisonDebut)}-01`;
  const base = `latitude=${v.lat}&longitude=${v.lon}&daily=temperature_2m_mean&timezone=Europe%2FParis`;
  try {
    const [arch, prev] = await Promise.all([
      (cache && cache.cle === cle && cache.jour === auj ? Promise.resolve(null)
        : fetch(`https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${debut}&end_date=${auj}`).then(r => r.ok ? r.json() : null).catch(() => null)),
      fetch(`https://api.open-meteo.com/v1/forecast?${base}&past_days=14&forecast_days=8&current=temperature_2m`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    const jours = { ...((cache && cache.cle === cle && cache.jours) || {}) }, prevision = {};
    for (const k of Object.keys(jours)) if (k > auj) delete jours[k];            // anciennes prévisions : jamais dans l'historique
    for (const src of [arch, prev]) {
      if (!src || !src.daily) continue;
      src.daily.time.forEach((t, i) => { const x = src.daily.temperature_2m_mean[i]; if (x === null || x === undefined) return;
        if (t > auj) prevision[t] = Math.round(x * 10) / 10; else jours[t] = Math.round(x * 10) / 10; });
    }
    if (!Object.keys(jours).length) return;
    meteo = { cle, jour: auj, le: Date.now(), jours, prevision: Object.keys(prevision).length ? prevision : ((cache && cache.prevision) || {}),
      actuelle: prev && prev.current ? prev.current.temperature_2m : (cache && cache.actuelle) };
    try { store.set("g.meteo", JSON.stringify(meteo)); } catch {}
  } catch {}
}
function tempMoyenne(debut, fin) {
  if (!meteo) return null;
  let s = 0, n = 0;
  for (let j = debut; j <= fin; j = ajouterJours(j, 1)) { const t = meteo.jours[j]; if (t !== undefined) { s += t; n++; } }
  return n ? s / n : null;
}
function dju(debut, fin) {          // degrés-jours de chauffage (base 18 °C) : mesure du froid de la période
  if (!meteo) return null;
  let s = 0, n = 0;
  for (let j = debut; j <= fin; j = ajouterJours(j, 1)) { const t = meteo.jours[j]; if (t !== undefined) { s += Math.max(0, BASE_DJU - t); n++; } }
  return n ? s : null;
}
const tempMois = (a, m) => tempMoyenne(`${a}-${pad(m)}-01`, `${a}-${pad(m)}-${pad(new Date(a, m, 0).getDate())}`);
function ressenti(t) {
  if (t === null || t === undefined) return "";
  return t < 0 ? "Glacial" : t < 5 ? "Très froid" : t < 10 ? "Froid" : t < 15 ? "Frais" : t < 20 ? "Doux" : "Chaud";
}

/* ---------- Réservoir du salon ---------- */
/** Minutes de chauffe depuis un instant (ms) */
function minutesEntre2(debut, fin) {
  if (!chauffes) return 0;
  let m = 0;
  const seg = (d, f) => { const a = Math.max(d, debut), b = Math.min(f, fin); if (b > a) m += (b - a) / 60000; };
  for (const c of chauffes.liste || []) seg(Date.parse(c.debut), Date.parse(c.fin));
  if (chauffes.enCours) seg(Date.parse(chauffes.enCours.debut), Date.now());
  return Math.round(m);
}
function minutesDepuis(ms) {
  if (!chauffes) return 0;
  let m = 0;
  const seg = (d, f) => { const a = Math.max(d, ms), b = Math.min(f, Date.now()); if (b > a) m += (b - a) / 60000; };
  for (const c of chauffes.liste || []) seg(Date.parse(c.debut), Date.parse(c.fin));
  if (chauffes.enCours) seg(Date.parse(chauffes.enCours.debut), Date.now());
  return Math.round(m);
}
/** État du réservoir : dernier remplissage (bouton ou sac déclaré), heures de chauffe depuis, autonomie estimée */
function etatReservoir() {
  if (!D) return null;
  const capa = Number(R().reservoir) || 0.5;
  const sacsSalon = D.brulages.filter(b => b.poele === "salon" && b.cree);
  const pleins = ((reservoir && reservoir.recharges) || []).map(x => ({ le: x.le, qui: x.qui, type: "rempli" }))
    .concat(sacsSalon.map(b => ({ le: b.cree, qui: b.qui, type: "sac" }))).sort((a, b) => a.le < b.le ? 1 : -1);
  const dernier = pleins[0];
  // Autonomie : d'abord ce qui a été observé entre deux « Rempli » consécutifs (médiane des 6 derniers),
  // sinon l'estimation à partir des sacs déclarés. S'ajuste donc à chaque remplissage.
  const rs = rendementSalon(), hps = rs.parSac;
  const autonomie = hps ? hps * capa : null;
  const source = hps ? "sacs" : null, nbObs = rs.sacs || 0;
  const heures = dernier ? minutesDepuis(Date.parse(dernier.le)) / 60 : null;
  const dernierSac = sacsSalon.map(b => b.cree).sort().pop() || "";
  const depuisSac = ((reservoir && reservoir.recharges) || []).filter(x => x.le > dernierSac).length;
  const reste = autonomie !== null && heures !== null ? Math.max(0, 1 - heures / autonomie) : null;
  const depasse = autonomie !== null && heures !== null && heures > autonomie ? heures - autonomie : 0;
  return { capa, dernier, heures, autonomie, reste, depasse, source, nbObs, depuisSac, parSac: Math.round(1 / capa) };
}
function couleurReservoir(reste) {
  return reste === null ? "#5d6178" : reste > .5 ? "#3fd29a" : reste > .25 ? "#f2d14b" : reste > .1 ? "#f0932b" : "#e04848";
}
/** Jauge du réservoir (utilisée dans Granulés et sur l'écran Poêle) : version compacte, détail au toucher */
function htmlReservoir(theme = "g") {
  const e = etatReservoir(); if (!e) return "";
  const pct = e.reste === null ? null : Math.round(e.reste * 100), coul = e.depasse ? "#8a8fa8" : couleurReservoir(e.reste);
  const restant = e.autonomie !== null && e.heures !== null ? Math.max(0, e.autonomie - e.heures) : null;
  const resume = e.autonomie === null ? "Autonomie en cours d'apprentissage"
    : e.depasse ? `Dépassé de ${duree(Math.round(e.depasse * 60))}`
    : restant !== null ? `${duree(Math.round(restant * 60))} restantes` : "Jamais rempli";
  return `<div class="gres ${theme}">
    <div class="gres-cuve"><i style="height:${e.depasse ? 8 : pct ?? 0}%;background:${coul}"></i><span>${pct === null || e.depasse ? "?" : pct + "%"}</span></div>
    <button class="gres-txt" data-gresdetail="1"><b>Réservoir${Number(R().coupureReservoir) ? ` <span class="gres-seuil">${Number(R().coupureReservoir)} %</span>` : ""}</b>
      <small>${resume} <span class="gres-plus">ⓘ</span></small></button>
    <div class="gres-actions"><button class="gres-maj" data-gresmaj="1" aria-label="Actualiser la jauge">↻</button><button class="gres-btn" data-gremplir="1">🪣 Rempli</button></div></div>
    ${reservoir && reservoir.coupe ? `<div class="gres-coupe">⛔ Poêle éteint : réservoir presque vide. Remplis-le puis touche « Rempli ».</div>` : ""}`;
}
function detailReservoir() {
  const e = etatReservoir(); if (!e) return;
  const rs = rendementSalon(), ligne = (a, b) => `<div class="gdl"><span>${a}</span><span>${b}</span></div>`;
  const quand = e.dernier ? new Date(e.dernier.le) : null;
  const lib = quand ? `${quand.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" })} à ${quand.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }).replace(":", "h")}` : "--";
  const restant = e.autonomie !== null && e.heures !== null ? Math.max(0, e.autonomie - e.heures) : null;
  ouvrirFeuille(`<div class="gmodtete">${ic("🪣", "vert grand")}<h2>Réservoir du salon</h2></div>
    <div class="gbloc">${ligne("Dernier remplissage", `<b>${lib}</b>`)}${e.dernier && e.dernier.qui ? ligne("Par", esc(e.dernier.qui)) : ""}
      ${ligne("Chauffe depuis", e.heures !== null ? duree(Math.round(e.heures * 60)) : "--")}
      ${ligne("Autonomie estimée", e.autonomie !== null ? duree(Math.round(e.autonomie * 60)) : "--")}
      ${ligne(e.depasse ? "Dépassement" : "Reste", e.depasse ? duree(Math.round(e.depasse * 60)) : restant !== null ? `<b>≈ ${duree(Math.round(restant * 60))}</b>` : "--")}
      ${ligne("Remplissages pour ce sac", `${e.depuisSac} / ${e.parSac}`)}</div>
    <div class="gbloc"><div class="gtit">Calcul</div>
      <div class="sub">${rs.parSac ? `${nb(rs.heures, 0)} h de chauffe pour ${sacsTxt(rs.sacs)} brûlés au salon depuis le ${dateCourte(rs.depuis)}, soit <b>${nb(rs.parSac)} h par sac</b>. Le réservoir tient ${e.capa === 0.5 ? "½" : nb(e.capa, 2)} sac, donc environ ${duree(Math.round(e.autonomie * 60))}.` : "Il faut au moins un sac déclaré au salon depuis le début du journal des chauffes."}
      ${rs.sacs && rs.sacs < 4 ? "<br>Encore peu de données : l'estimation s'affinera avec les prochains sacs." : ""}</div></div>
    ${Number(R().coupureReservoir) ? `<div class="gbloc"><div class="sub">⛔ Le poêle s'éteint si le réservoir passe sous <b>${Number(R().coupureReservoir)} %</b> (à partir de 4 sacs de données). Réglable dans ⚙︎.</div></div>` : ""}
    <button type="button" class="gbouton" style="background:linear-gradient(135deg,#2bc48a,#1d9468)" data-oubli>✎ Rempli plus tôt ? Corriger les remplissages</button>
    <div class="gpied"><button type="button" class="glien vert" data-gfermer>Fermer</button></div>`, d => {
    d.querySelector("[data-oubli]").addEventListener("click", () => feuilleRemplissages());
  }, "centre");
}
/* Remplissage oublié : choisir la date et l'heure, ou supprimer un remplissage noté par erreur */
function feuilleRemplissages() {
  const pad2 = n => String(n).padStart(2, "0"), d = new Date();
  const liste = ((reservoir && reservoir.recharges) || []).slice(0, 8);
  const lib = x => { const t = new Date(x.le); return `${t.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} à ${t.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }).replace(":", "h")}`; };
  ouvrirFeuille(`${tete("🪣", "Remplissage oublié")}
    <p class="sub" style="font-size:14px">Indique quand tu as réellement rempli le réservoir (7 derniers jours au plus).</p>
    <div class="two">${champ("Date", `<input type="date" name="jour" value="${iso(d)}">`)}${champ("Heure", `<input type="time" name="heure" value="${pad2(d.getHours())}:${pad2(Math.floor(d.getMinutes() / 5) * 5)}">`)}</div>
    <button class="gvalider vert" type="submit">🪣 Noter ce remplissage</button>
    ${liste.length ? `<div class="gtit" style="margin-top:18px">Derniers remplissages</div><div class="glist">${liste.map(x => `<div class="gitem vert"><span class="gic vert">🪣</span><div class="gitxt"><b>${lib(x)}</b><small>${x.qui ? esc(x.qui) : ""}${x.corrige ? " · noté après coup" : ""}</small></div><button type="button" class="gbtn-ic" data-suppr="${esc(x.le)}" aria-label="Supprimer">🗑</button></div>`).join("")}</div>` : ""}`, dlg => {
    if (window.ameliorerChamp) ameliorerChamp(dlg.querySelector('input[name="heure"]'), { theme: "g", titre: "Heure du remplissage", pas: 5 });
    const f = dlg.querySelector("form");
    f.addEventListener("submit", async ev => {
      ev.preventDefault();
      const [h, m] = f.heure.value.split(":").map(Number), quand = date(f.jour.value); quand.setHours(h, m, 0, 0);
      if (quand > new Date()) return toast("Ce moment est dans le futur");
      if (Date.now() - quand > 7 * 864e5) return toast("7 jours maximum");
      const b = f.querySelector(".gvalider"); b.disabled = true;
      try { const j = await relais("/reservoir", { qui: cfg.qui || "", le: quand.toISOString() }); reservoir = j.reservoir; dlg.close(); rendre(); window.dispatchEvent(new Event("reservoir")); toast("✓ Remplissage noté"); }
      catch (err) { toast(err.message); b.disabled = false; }
    });
    dlg.querySelectorAll("[data-suppr]").forEach(b => b.addEventListener("click", async () => {
      b.disabled = true;
      try { const j = await relais("/reservoir", { action: "supprimer", le: b.dataset.suppr }); reservoir = j.reservoir; rendre(); window.dispatchEvent(new Event("reservoir")); b.closest(".gitem").remove(); toast("✓ Remplissage supprimé"); }
      catch (err) { toast(err.message); b.disabled = false; }
    }));
  });
}
let majRes = false;
async function actualiserReservoir() {
  if (majRes) return; majRes = true;
  document.querySelectorAll("[data-gresmaj]").forEach(b => b.classList.add("tourne"));
  try { await charger(); toast("✓ Jauge actualisée"); }
  finally { majRes = false; setTimeout(() => document.querySelectorAll("[data-gresmaj]").forEach(b => b.classList.remove("tourne")), 300); }
}
let remplissageEnCours = false;
/** « Rempli » instantané : la jauge et la question « Sac terminé ? » s'affichent tout de suite,
    l'enregistrement part en arrière-plan ; en cas d'échec, tout est annulé avec un message. */
async function remplirReservoir() {
  if (!cfg.relais) return toast("Nécessite le relais Cloudflare");
  if (remplissageEnCours) return;
  const avant = reservoir ? JSON.parse(JSON.stringify(reservoir)) : null;
  const liste = (reservoir && reservoir.recharges) || [];
  if (liste[0] && Date.now() - Date.parse(liste[0].le) < 3 * 60000) return toast("Remplissage déjà noté il y a moins de 3 min");
  remplissageEnCours = true;
  reservoir = { ...(reservoir || {}), recharges: [{ le: new Date().toISOString(), qui: cfg.qui || "" }, ...liste] };
  delete reservoir.coupe;
  rendre(); window.dispatchEvent(new Event("reservoir"));
  const e = etatReservoir();
  if (e && e.depuisSac >= e.parSac) {
    ouvrirFeuille(`${tete("🔥", "Sac terminé ?")}
      <p class="sub" style="font-size:15px">C'est le ${e.depuisSac}ᵉ remplissage depuis le dernier sac déclaré (un sac = ${e.parSac} remplissages). Déclarer un sac brûlé au salon ?</p>
      <button class="gvalider orange" type="button" data-oui>🔥 Oui, 1 sac brûlé au salon</button>
      <button class="save" type="button" data-gfermer>Pas encore</button>`, d => {
      d.querySelector("[data-oui]").addEventListener("click", async ev => {
        ev.target.disabled = true; ev.target.textContent = "Enregistrement…";
        try { await envoiRemplissage; await envoyer({ op: "ajouter", liste: "brulages", element: { date: aujourdhui(), poele: "salon", marque: marqueParDefaut(), sacs: 1, note: "" } }); d.close(); toast("✓ Sac déclaré"); window.dispatchEvent(new Event("reservoir")); }
        catch (err) { toast(err.message); ev.target.disabled = false; ev.target.textContent = "🔥 Oui, 1 sac brûlé au salon"; }
      });
    });
  } else toast(`✓ Réservoir rempli${e ? ` (${e.depuisSac}/${e.parSac} pour ce sac)` : ""}`);
  const envoiRemplissage = relais("/reservoir", { qui: cfg.qui || "" });
  try {
    const j = await envoiRemplissage;
    if (j && j.reservoir) { reservoir = j.reservoir; rendre(); window.dispatchEvent(new Event("reservoir")); }
  } catch (err) {
    reservoir = avant; rendre(); window.dispatchEvent(new Event("reservoir"));
    toast(`⚠️ Remplissage non enregistré : ${err.message}`);
  } finally { remplissageEnCours = false; }
}

/* ---------- Statistiques avancées ---------- */
/** Sacs par degré-jour (DJU), pour prévoir à froid égal : saison en cours, sinon la précédente */
function sacsParDju() {
  const essai = a => {
    const l = D.brulages.filter(b => anneeSaison(b.date) === a && dePoele(b));
    if (somme(l) < 2) return null;
    const deb = l[0].date, fin = a === saisonCourante() ? aujourdhui() : l[l.length - 1].date, dj = dju(deb, fin);
    return dj ? { ratio: somme(l) / dj, saison: a } : null;
  };
  return essai(saisonCourante()) || essai(saisonCourante() - 1);
}
function prevision7j() {
  if (!meteo || !meteo.prevision) return null;
  const jours = Object.keys(meteo.prevision).sort().slice(0, 7);
  const s = sacsParDju();
  if (!jours.length || !s) return null;
  const lignes = jours.map(j => { const t = meteo.prevision[j], dj = Math.max(0, BASE_DJU - t); return { j, t, sacs: dj * s.ratio }; });
  return { lignes, sacs: lignes.reduce((x, l) => x + l.sacs, 0), tMoy: lignes.reduce((x, l) => x + l.t, 0) / lignes.length, base: s };
}
/** Chauffes du journal (terminées), avec la date locale de début */
const chauffesListe = () => ((chauffes && chauffes.liste) || []).map(c => ({ ...c, jour: iso(new Date(c.debut)) }));
function projectionSaison() {
  const sc = saisonCourante(), auj = aujourdhui(), couts = coutsBrulages();
  const l = D.brulages.filter(b => anneeSaison(b.date) === sc && dePoele(b));
  if (!l.length) return null;
  const depense = coutDe(l, couts), sacs = somme(l), finS = finSaison(sc);
  if (auj >= finS) return { depense, sacs, totalEuros: depense, totalSacs: sacs, methode: "terminee" };
  const djFait = dju(l[0].date, auj), djReste = dju(ajouterJours(auj, -364), ajouterJours(finS, -365));
  if (djFait && djReste !== null) {
    const k = djReste / djFait;
    return { depense, sacs, totalEuros: depense * (1 + k), totalSacs: sacs * (1 + k), methode: "meteo", djReste };
  }
  const jFait = Math.max(7, ecartJours(l[0].date, auj) + 1), jReste = ecartJours(auj, finS);
  return { depense, sacs, totalEuros: depense / jFait * (jFait + jReste), totalSacs: sacs / jFait * (jFait + jReste), methode: "lineaire" };
}

/* ---------- Graphiques (SVG faits main, sans double axe) ---------- */
function barres(cols, { cle, hauteur = 130, couleurs = COULEUR, cles = null, etiquettes = true, unite = "", temperatures = null, largeur = null } = {}) {
  const valsT = temperatures ? temperatures.flatMap(s => s.pts).filter(v => v !== null && v !== undefined) : [];
  const avecT = valsT.length > 0;
  const W = largeur || (avecT ? 290 : 320), H = hauteur, bas = 18, haut = 14;
  const k = cles || Object.keys(couleurs);
  const tot = c => k.reduce((x, kk) => x + (c.valeurs[kk] || 0), 0);
  const avecFantome = cols.some(c => c.fantome !== undefined);
  const max = Math.max(1, ...cols.map(tot), ...cols.map(c => c.fantome || 0));
  const pas = W / cols.length;
  const larg = avecFantome ? Math.min(15, pas * .34) : Math.min(26, pas * .62);
  const y0 = H - bas, echelle = v => (v / max) * (H - bas - haut);
  if (cle) infos[cle] = cols.map(c => c.info || "");
  let svg = `<svg viewBox="0 0 ${avecT ? W + 30 : W} ${H}" class="gsvg"${largeur ? ` style="width:${avecT ? W + 30 : W}px"` : ""}>`;
  for (let i = 1; i <= 3; i++) svg += `<line x1="0" x2="${W}" y1="${y0 - (H - bas - haut) * i / 3}" y2="${y0 - (H - bas - haut) * i / 3}" class="ggrille"/>`;
  svg += `<line x1="0" x2="${W}" y1="${y0 + .5}" y2="${y0 + .5}" class="gaxe"/>`;
  cols.forEach((c, i) => {
    const centre = i * pas + pas / 2;
    let x = avecFantome ? centre + 1 : centre - larg / 2;
    if (avecFantome && c.fantome) {
      const h = Math.max(2, echelle(c.fantome));
      svg += `<rect x="${centre - 1 - larg}" y="${y0 - h}" width="${larg}" height="${h}" rx="4" fill="${C_PASSE}"/>`;
    }
    let y = y0; const t = tot(c);
    k.forEach((kk, j) => {
      const v = c.valeurs[kk] || 0; if (!v) return;
      const h = Math.max(2, echelle(v)), dernier = !k.slice(j + 1).some(z => c.valeurs[z]);
      y -= h;
      svg += `<rect x="${x}" y="${y}" width="${larg}" height="${dernier ? h : h - 2}" rx="${dernier ? 4 : 1}" fill="${couleurs[kk]}"/>`;
    });
    if (t && etiquettes) svg += `<text x="${x + larg / 2}" y="${y - 4}" class="gval">${nb(t)}${unite}</text>`;
    svg += `<text x="${centre}" y="${H - 4}" class="glab${c.fort ? " fort" : ""}">${esc(c.lab)}</text>`;
  });
  if (avecT) {      // courbe de température superposée, avec sa propre échelle en °C à droite
    let tmin = Math.floor(Math.min(...valsT) / 5) * 5 - 5, tmax = Math.ceil(Math.max(...valsT) / 5) * 5 + 5;
    const yt = v => haut + (1 - (v - tmin) / (tmax - tmin)) * (y0 - haut);
    svg += `<line x1="${W + 4}" x2="${W + 4}" y1="${haut}" y2="${y0}" class="gaxe"/>`;
    for (let v = tmin; v <= tmax; v += 10) svg += `<line x1="${W + 4}" x2="${W + 8}" y1="${yt(v)}" y2="${yt(v)}" class="gaxe"/><text x="${W + 10}" y="${yt(v) + 3}" class="glab gauche ttemp">${v}°</text>`;
    for (const s of temperatures) {
      let d = "", seg = false;
      s.pts.forEach((v, i) => { if (v === null || v === undefined) { seg = false; return; } d += `${seg ? "L" : "M"}${i * pas + pas / 2},${yt(v)} `; seg = true; });
      svg += `<path d="${d}" fill="none" stroke="${s.couleur}" stroke-width="${s.tirets ? 2 : 2.5}" stroke-linecap="round" ${s.tirets ? 'stroke-dasharray="4 4" opacity=".8"' : ""}/>`;
      if (!s.tirets) s.pts.forEach((v, i) => { if (v !== null && v !== undefined) svg += `<circle cx="${i * pas + pas / 2}" cy="${yt(v)}" r="4" fill="${s.couleur}" stroke="#181c2c" stroke-width="2"/>`; });
    }
  }
  if (cle) cols.forEach((c, i) => { svg += `<rect x="${i * pas}" y="0" width="${pas}" height="${H}" fill="transparent" data-gtap="${cle}:${i}" class="gzone"/>`; });
  return svg + `</svg>${cle ? `<div class="ginfo" id="info-${cle}"></div>` : ""}`;
}
/** Petit graphique de température aligné sous des barres (même axe horizontal, échelle propre) */
function courbes(series, n, { cle, hauteur = 92 } = {}) {
  const W = 320, H = hauteur, pas = W / n, gauche = 0;
  const vals = series.flatMap(s => s.pts).filter(v => v !== null && v !== undefined);
  if (!vals.length) return `<div class="sub gpetit">Météo indisponible pour l'instant.</div>`;
  let min = Math.floor(Math.min(...vals) / 5) * 5, max = Math.ceil(Math.max(...vals) / 5) * 5;
  if (max - min < 10) max = min + 10;
  const y = v => 8 + (1 - (v - min) / (max - min)) * (H - 16);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="gsvg gcourbe">`;
  for (let v = min; v <= max; v += 5) svg += `<line x1="${gauche}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="ggrille"/><text x="${W - 2}" y="${y(v) - 3}" class="glab droite">${v}°</text>`;
  for (const s of series) {
    let d = "", seg = false;
    s.pts.forEach((v, i) => { if (v === null || v === undefined) { seg = false; return; } d += `${seg ? "L" : "M"}${i * pas + pas / 2},${y(v)} `; seg = true; });
    svg += `<path d="${d}" fill="none" stroke="${s.couleur}" stroke-width="2" ${s.tirets ? 'stroke-dasharray="4 4"' : ""}/>`;
    s.pts.forEach((v, i) => { if (v !== null && v !== undefined && !s.tirets) svg += `<circle cx="${i * pas + pas / 2}" cy="${y(v)}" r="4" fill="${s.couleur}" stroke="var(--gcarte)" stroke-width="2"/>`; });
  }
  if (cle) for (let i = 0; i < n; i++) svg += `<rect x="${i * pas}" y="0" width="${pas}" height="${H}" fill="transparent" data-gtap="${cle}:${i}" class="gzone"/>`;
  return svg + "</svg>";
}
const pastille = (couleur, txt, tirets) => `<span><i style="${tirets ? `background:none;border-top:2px dashed ${couleur};height:0;border-radius:0;width:14px` : `background:${couleur}`}"></i>${esc(txt)}</span>`;
const legende = items => items.length ? `<div class="gleg">${items.join("")}</div>` : "";
const clesPoeles = () => etat.poele === "tous" ? D.poeles.map(p => p.id) : [etat.poele];
const legendePoeles = () => clesPoeles().length > 1 ? clesPoeles().map(k => pastille(COULEUR[k], courtPoele(k))) : [];
function valeursPoeles(liste) { const v = {}; for (const b of liste) v[b.poele] = (v[b.poele] || 0) + b.sacs; return v; }
const ic = (emoji, teinte) => `<span class="gic ${teinte}">${emoji}</span>`;

/* ---------- Rendu ---------- */
function rendre() {
  const z = $("vueGranules");
  if (!D) { z.innerHTML = `<section class="gcarte"><div class="sub">Chargement des granulés…</div></section>`; return; }
  const h = `<div class="gfiltres">
    <div class="gchips">${[["tous", "Les deux"], ...D.poeles.map(p => [p.id, courtPoele(p.id)])].map(([id, l]) =>
      `<button data-gpoele="${id}" class="${etat.poele === id ? "sel" : ""}">${id !== "tous" ? `<i style="background:${COULEUR[id]}"></i>` : ""}${esc(l)}</button>`).join("")}</div>
    <button class="gbtn-ic" id="gReglages" aria-label="Réglages des granulés">⚙︎</button>
  </div>` + { tableau: vueTableau, historique: vueHistorique, stats: vueStats, entretiens: vueEntretiens }[etat.vue]()
    + `<button class="gfab" id="gPlus" aria-label="Ajouter">＋</button>`;
  z.innerHTML = h;
}

/** Ne redessine qu'un bloc (le reste de l'écran ne bouge pas) */
function rendreBloc(nom) {
  const ancien = $("vueGranules").querySelector(`[data-bloc="${nom}"]`);
  if (!ancien) return rendre();
  const tmp = document.createElement("div");
  tmp.innerHTML = { tableau: vueTableau, historique: vueHistorique, stats: vueStats, entretiens: vueEntretiens }[etat.vue]();
  const neuf = tmp.querySelector(`[data-bloc="${nom}"]`);
  if (!neuf) return rendre();
  neuf.classList.add("gfondu");
  ancien.replaceWith(neuf);
}
function vueTableau() {
  const stock = stockTotal(), cap = R().capacite || 90, pct = Math.max(0, Math.min(100, stock / cap * 100));
  const niveau = pct < R().seuilRouge ? "rouge" : pct < R().seuilOrange ? "orange" : "ok";
  const conso = consoMoyenne(), jours = conso > 0 ? Math.floor(stock / conso) : null;
  const fin = jours !== null ? ajouterJours(aujourdhui(), jours) : null;
  const achats = D.achats.filter(dansPortee), brul = D.brulages.filter(e => dansPortee(e) && dePoele(e));
  const moy = moyenneKgJour(etat.moyenne);
  const libMoy = { "7j": "7 jours", mois: "Mois", saison: "Saison" }[etat.moyenne];
  const t = meteo && meteo.actuelle;
  let h = `<div class="gseg">
      <button data-gportee="saison" class="${etat.portee === "saison" ? "sel" : ""}">📅 Saison ${nomSaison(saisonCourante())}</button>
      <button data-gportee="toujours" class="${etat.portee === "toujours" ? "sel" : ""}">Depuis toujours</button></div>
    <button class="gcarte gstock ${niveau}" data-gdetail="stock">
      <div class="gligne2"><div>${ic("📦", "bleu")} <span class="gtit">Stock</span><div class="gbig">${nb(stock)}<small> sacs</small></div></div>
      <div class="adroite">${ic("⏳", "bleu")} <span class="gtit">Autonomie estimée</span>
        <div class="gfin">${fin ? `${dateLongue(fin)} <span class="gbadge bleu">${jours} j</span>` : "--"}</div></div></div>
      <div class="gjauge"><span style="width:${pct}%"></span></div>
      <div class="gligne2 gpetit"><span>${Math.round(pct)} % rempli</span><span>Capacité : ${cap} sacs</span></div>
    </button>
    <div class="gtuiles">
      <button class="gtuile violet" data-gdetail="meteo">${ic("🌡️", "violet")}<div><b class="gmoy">${t !== undefined && t !== null ? `${Math.round(t)} °C` : "--"}</b><div class="gpetit">${esc(ressenti(t))}${t !== undefined && t !== null ? " · " : ""}📍 ${esc(ville().nom)}</div></div></button>
      <button class="gtuile bleu" data-gdetail="achats">${ic("🛒", "bleu")}<span class="gtit">Achetés</span><div><b>${nb(somme(achats))}</b> <small>sacs</small></div></button>
      <button class="gtuile orange" data-gdetail="brules">${ic("🔥", "orange")}<span class="gtit">Brûlés${etat.poele !== "tous" ? ` · ${esc(courtPoele(etat.poele))}` : ""}</span><div><b>${nb(somme(brul))}</b> <small>sacs</small></div></button>
      <button class="gtuile cyan" data-gdetail="depenses">${ic("💶", "cyan")}<span class="gtit">Dépenses totales</span><div><b>${euros(somme(achats, prixAchat))}</b></div></button>
      <button class="gtuile ambre" data-gdetail="moyenne">${ic("📈", "ambre")}<span class="gtit">Moyenne ${libMoy}</span><div><b>${nb(moy.kg)}</b> <small>kg/j</small></div></button>`;
  if (etat.poele !== "cuisine") h += htmlReservoir("g");
  if (avecChauffe()) {
    const m7 = minutesChauffe(ajouterJours(aujourdhui(), -6), aujourdhui()), mj = minutesChauffe(aujourdhui(), aujourdhui());
    h += `<button class="gtuile ambre large" data-gdetail="chauffe">${ic("🔥", "ambre")}<span class="gtit">Temps de chauffe · Salon</span>
      <div class="gligne2"><div><b>${duree(mj)}</b> <small>aujourd'hui</small></div><div class="adroite"><b style="font-size:19px">${duree(m7)}</b> <small>sur 7 jours</small></div></div></button>`;
  }
  if (etat.poele !== "cuisine") {
    const r = rendementSalon();
    h += `<button class="gtuile vert large" data-gdetail="rendement">${ic("⏱️", "vert")}<span class="gtit">Chauffe par sac · Salon</span>${r.parSac
      ? `<div><b>${nb(r.parSac)}</b> <small>h de chauffe par sac</small></div>`
      : `<div class="gpetit">En attente : il faut deux sacs déclarés au salon depuis le ${r.depuis ? dateCourte(r.depuis) : "début du journal des chauffes"}.</div>`}</button>`;
  }
  h += `</div>`;

  // Graphique
  const choix = [["7j", "7 derniers jours"], ["4s", "4 dernières semaines"], ["mois", "Mois en cours"], ["30j", "30 derniers jours"], ["saison", "Cette saison"]];
  const auj = aujourdhui(), brAll = D.brulages.filter(e => dePoele(e));
  let cols = [], periodes = [];
  if (etat.graphe === "7j" || etat.graphe === "30j") {
    const n = etat.graphe === "7j" ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const j = ajouterJours(auj, -i), d = date(j), l = brAll.filter(b => b.date === j);
      cols.push({ lab: n === 7 ? JOURS[d.getDay()] : (i % 7 === 0 ? dateCourte(j) : ""), valeurs: valeursPoeles(l), fort: i === 0,
        info: infoJour(j, l) });
      periodes.push([j, j, cols[cols.length - 1].lab, i === 0]);
    }
  } else if (etat.graphe === "4s") {
    for (let s = 3; s >= 0; s--) {
      const fin = ajouterJours(auj, -7 * s), debut = ajouterJours(fin, -6);
      const l = brAll.filter(b => b.date >= debut && b.date <= fin);
      const mc = avecChauffe() && fin >= debutJournal() ? minutesChauffe(debut, fin) : null;
      cols.push({ lab: `${dateCourte(debut)}–${dateCourte(fin)}`, valeurs: valeursPoeles(l), fort: s === 0,
        info: `<b>Du ${dateCourte(debut)} au ${dateCourte(fin)}</b> : ${sacsTxt(somme(l))}${tempMoyenne(debut, fin) !== null ? ` · ${temp(tempMoyenne(debut, fin))} en moyenne` : ""}${mc !== null ? ` · ⏱️ ${duree(mc)} de chauffe` : ""}` });
      periodes.push([debut, fin, cols[cols.length - 1].lab, s === 0]);
    }
  } else if (etat.graphe === "mois") {
    const premier = auj.slice(0, 8) + "01", n = new Date(date(auj).getFullYear(), date(auj).getMonth() + 1, 0).getDate();
    for (let i = 0; i < n; i++) {
      const j = ajouterJours(premier, i), l = brAll.filter(b => b.date === j);
      cols.push({ lab: [1, 5, 10, 15, 20, 25, 30].includes(i + 1) ? String(i + 1) : "", valeurs: valeursPoeles(l), fort: j === auj, info: infoJour(j, l) });
      periodes.push([j, j, cols[cols.length - 1].lab, j === auj]);
    }
  } else {
    cols = moisSaison(saisonCourante()).map(({ a, m }) => {
      const l = brAll.filter(b => b.date.startsWith(`${a}-${pad(m)}`));
      const deb = `${a}-${pad(m)}-01`, fin = `${a}-${pad(m)}-${pad(new Date(a, m, 0).getDate())}`;
      periodes.push([deb, fin, MOIS_COURT[m - 1], false]);
      const mc = avecChauffe() && fin >= debutJournal() ? minutesChauffe(deb, fin) : null;
      return { lab: MOIS_COURT[m - 1], valeurs: valeursPoeles(l),
        info: `<b>${MOIS_LONG[m - 1]} ${a}</b> : ${sacsTxt(somme(l))}${tempMois(a, m) !== null ? ` · ${temp(tempMois(a, m))} en moyenne` : ""}${mc !== null ? ` · ⏱️ ${duree(mc)} de chauffe` : ""}` };
    });
  }
  const totalGraphe = cols.reduce((x, c) => x + Object.values(c.valeurs).reduce((a, b) => a + b, 0), 0);
  h += `<section class="gcarte orangee" data-bloc="graphe"><div class="gligne2">${ic("🔥", "orange")}<select class="gselect" id="gGraphe">${choix.map(([id, l]) => `<option value="${id}" ${etat.graphe === id ? "selected" : ""}>${l}</option>`).join("")}</select>
      <span class="gbadge orange">${sacsTxt(totalGraphe)}</span></div>
      ${barres(cols, { cle: "tab", cles: clesPoeles(), etiquettes: !["30j", "mois"].includes(etat.graphe) })}${legende(legendePoeles())}
      ${avecChauffe() ? panneauHeures(periodes, { cle: "tabh", etiquettes: !["30j", "mois"].includes(etat.graphe) }) : ""}</section>`;
  const pv = prevision7j();
  if (pv) {
    const t7 = tempMoyenne(ajouterJours(auj, -6), auj), pm = prixMoyenGlobal();
    const maxS = Math.max(.01, ...pv.lignes.map(l => l.sacs));
    h += `<section class="gcarte gprev"><div class="gtete">${ic("🔮", "violet")}<div><b>Les 7 prochains jours</b>
      <div class="gpetit">Prévisions à ${esc(ville().nom)}${t7 !== null ? ` · ${pv.tMoy < t7 - .5 ? "plus froid" : pv.tMoy > t7 + .5 ? "plus doux" : "comme"} que les 7 derniers jours` : ""}</div></div></div>
      <div class="gligne2" style="margin-top:12px"><div><b class="gbig" style="font-size:30px">≈ ${nb(pv.sacs)}</b> <small class="gpetit">sacs${etat.poele !== "tous" ? ` · ${esc(courtPoele(etat.poele))}` : ""}</small></div>
      <div class="adroite">${pm ? `<b>≈ ${euros(pv.sacs * pm)}</b><div class="gpetit">au prix moyen</div>` : ""}</div></div>
      <div class="gjours">${pv.lignes.map(l => `<div><span class="gpetit">${JOURS[date(l.j).getDay()].replace(".", "")}</span><i style="height:${Math.max(4, l.sacs / maxS * 46)}px"></i><b>${nb(l.t, 0)}°</b><small>${nb(l.sacs)}</small></div>`).join("")}</div>
      <div class="gpetit" style="margin-top:6px">Estimation à froid égal : ${nb(pv.base.ratio * 100)} sacs pour 100 degrés-jours (saison ${nomSaison(pv.base.saison)}).</div></section>`;
  }
  return h;
}
function infoJour(j, l) {
  const t = meteo && meteo.jours[j];
  const m = avecChauffe() && j >= debutJournal() ? minutesChauffe(j, j) : null;
  return `<b>${JOURS[date(j).getDay()].replace(".", "")} ${dateLongue(j)}</b> : ${sacsTxt(somme(l))}${l.length ? ` (${l.map(b => `${courtPoele(b.poele)} ${nb(b.sacs)}`).join(", ")})` : ""}${t !== undefined && t !== null ? ` · ${temp(t)}` : ""}${m !== null ? ` · ⏱️ ${duree(m)} de chauffe` : ""}`;
}

/* ---------- Détails des tuiles ---------- */
function detail(type) {
  const achats = D.achats.filter(dansPortee), brul = D.brulages.filter(e => dansPortee(e) && dePoele(e));
  const parMarque = (l, f = e => e.sacs) => { const o = {}; l.forEach(e => o[e.marque] = (o[e.marque] || 0) + f(e)); return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  const kg = n => `${nb(n * R().kgSac, 0)} kg`;
  const ligne = (g, d, cls = "") => `<div class="gdl ${cls}"><span>${g}</span><span>${d}</span></div>`;
  let ico, titre, teinte, corps;
  if (type === "stock") {
    const st = stockParMarque(), conso = consoMoyenne(), stock = stockTotal();
    ico = "📦"; titre = "Détail du stock"; teinte = "bleu";
    corps = `<div class="gbloc">${ligne("En stock", `<b>${sacsTxt(stock)}</b>`)}${ligne("Poids", kg(stock))}${ligne("Capacité", `${R().capacite} sacs`)}</div>
      <div class="gbloc"><div class="gtit">Par marque</div>${Object.entries(st).filter(([, n]) => n).map(([m, n]) => ligne(`🏷️ ${esc(m)}`, `${sacsTxt(n)} (${kg(n)})`)).join("") || '<div class="sub">--</div>'}</div>
      <div class="gbloc"><div class="gtit">Calcul de l'autonomie</div><div class="sub">Rythme des deux poêles depuis le premier sac de la saison : <b>${nb(conso, 2)} sac/j</b> (${nb(conso * R().kgSac)} kg/j).</div>
      <div class="gformule">${nb(stock)} sacs ÷ ${nb(conso, 2)} sac/j = ${conso ? Math.floor(stock / conso) : "--"} jours</div></div>`;
  } else if (type === "achats" || type === "depenses") {
    const pre = achats.filter(estPreSaison), sai = achats.filter(a => !estPreSaison(a));
    const f = type === "achats" ? (l => sacsTxt(somme(l))) : (l => euros(somme(l, prixAchat)));
    ico = type === "achats" ? "🛒" : "💶"; teinte = type === "achats" ? "bleu" : "cyan";
    titre = type === "achats" ? "Détail des achats" : "Détail des dépenses";
    corps = `<div class="gbloc">${ligne("☀️ Pré-saison (été)", `<b>${f(pre)}</b>`)}${ligne("❄️ Saison (hiver)", `<b>${f(sai)}</b>`)}</div>
      <div class="gbloc"><div class="gtit">${sacsTxt(somme(achats))} de ${R().kgSac} kg · ${kg(somme(achats))}</div>
      ${parMarque(achats).map(([m, n]) => ligne(`🏷️ ${esc(m)}`, type === "achats" ? `${sacsTxt(n)} (${kg(n)})` : `${euros(somme(achats.filter(a => a.marque === m), prixAchat))} · ${moyennePrix(achats.filter(a => a.marque === m)) ? euros(moyennePrix(achats.filter(a => a.marque === m))) + "/sac" : "--"}`)).join("")}</div>
      ${type === "depenses" ? `<div class="gtotal">Coût total : ${euros(somme(achats, prixAchat))}</div><div class="sub gcentre">Prix moyen : ${moyennePrix(achats) ? euros(moyennePrix(achats)) + " / sac" : "--"}</div>` : ""}`;
  } else if (type === "brules") {
    const pm = prixMoyenGlobal(), cout = D.achats.some(a => a.prixSac) ? coutDe(brul) : null;
    ico = "🔥"; titre = "Détail des brûlages"; teinte = "orange";
    corps = `<div class="gbloc">${ligne("🔥 Brûlés", `<b>${sacsTxt(somme(brul))}</b>`)}${ligne("⚖️ Poids", kg(somme(brul)))}${ligne("💶 Coût estimé", `<b class="vert">${cout !== null ? euros(cout) : "--"}</b>`)}</div>
      ${etat.poele === "tous" ? `<div class="gbloc"><div class="gtit">Par poêle</div>${D.poeles.map(p => ligne(`<i class="gpt" style="background:${COULEUR[p.id]}"></i>${esc(courtPoele(p.id))}`, sacsTxt(somme(brul.filter(b => b.poele === p.id))))).join("")}</div>` : ""}
      <div class="gbloc"><div class="gtit">Par marque</div>${parMarque(brul).map(([m, n]) => ligne(`🏷️ ${esc(m)}`, `${sacsTxt(n)} (${kg(n)})`)).join("") || '<div class="sub">--</div>'}</div>
      <div class="sub gpetit">Coût calculé au prix réellement payé : les sacs achetés en premier sont comptés comme brûlés en premier. Prix moyen payé : ${pm ? euros(pm) : "--"} / sac. Période : ${libellePortee()}.</div>`;
  } else if (type === "moyenne") {
    const m = moyenneKgJour(etat.moyenne);
    const lib = { "7j": "les 7 derniers jours", mois: "le mois en cours", saison: "la saison de chauffe" }[etat.moyenne];
    ico = "📈"; titre = `Moyenne ${{ "7j": "7 jours", mois: "Mois", saison: "Saison" }[etat.moyenne]}`; teinte = "ambre";
    corps = `<div class="gseg petit">${[["7j", "7 jours"], ["mois", "Mois"], ["saison", "Saison"]].map(([id, l]) => `<button type="button" data-gmoy="${id}" class="${etat.moyenne === id ? "sel" : ""}">${l}</button>`).join("")}</div>
      <p class="sub">Consommation moyenne de granulés sur ${lib}${etat.poele !== "tous" ? ` (poêle ${esc(courtPoele(etat.poele).toLowerCase())})` : ""}.</p>
      <div class="gbloc"><div class="gtit">Détails du calcul</div>${ligne("Période", `depuis le ${dateLongue(m.debut)}`)}${ligne("Total brûlé", `${nb(m.total, 0)} kg (${sacsTxt(m.sacs)})`)}${ligne("Jours", `${m.jours} jours`)}
      <div class="gformule">${nb(m.total, 0)} kg ÷ ${m.jours} jours = ${nb(m.kg)} kg/j</div></div>`;
  } else if (type === "meteo") {
    const v = ville(), sc = saisonCourante(), auj = aujourdhui();
    const debutC = debutSaison(sc), finC = auj < finSaison(sc) ? auj : finSaison(sc);
    const decal = s => ajouterJours(s, -365);
    const djuC = dju(debutC, finC), djuP = dju(decal(debutC), decal(finC));
    ico = "🌡️"; titre = `Météo · ${esc(v.nom)}`; teinte = "violet";
    corps = `<div class="gbloc">${ligne("Maintenant", `<b>${temp(meteo && meteo.actuelle)}</b> ${esc(ressenti(meteo && meteo.actuelle))}`)}
        ${ligne("7 derniers jours", temp(tempMoyenne(ajouterJours(auj, -6), auj)))}${ligne("Depuis le début de la saison", temp(tempMoyenne(debutC, finC)))}</div>
      <div class="gbloc"><div class="gtit">Froid de la saison (degrés-jours)</div>${ligne(`Saison ${nomSaison(sc)}`, `<b>${djuC !== null ? Math.round(djuC) : "--"} DJU</b>`)}${ligne(`Même période l'an dernier`, `${djuP !== null ? Math.round(djuP) : "--"} DJU`)}
      ${djuC && djuP ? `<div class="gformule">${djuC > djuP ? `Plus froid que l'an dernier (+${Math.round((djuC / djuP - 1) * 100)} %)` : `Plus doux que l'an dernier (${Math.round((djuC / djuP - 1) * 100)} %)`}</div>` : ""}</div>
      <p class="sub gpetit">Degrés-jours : chaque jour compte 18 °C moins la température moyenne du jour. Plus le total est élevé, plus il a fait froid. Données Open-Meteo.</p>`;
  } else if (type === "chauffe") {
    const auj = aujourdhui(), dj = debutJournal();
    const per = [["Aujourd'hui", auj, auj], ["Hier", ajouterJours(auj, -1), ajouterJours(auj, -1)], ["7 derniers jours", ajouterJours(auj, -6), auj],
      ["Mois en cours", auj.slice(0, 8) + "01", auj], ["Saison", debutSaison(saisonCourante()), auj]];
    const jours7 = Math.min(7, ecartJours(dj, auj) + 1);
    ico = "🔥"; titre = "Temps de chauffe · Salon"; teinte = "ambre";
    corps = `<div class="gbloc">${per.map(([l, a, b]) => ligne(l, b < dj ? "--" : `<b>${duree(minutesChauffe(a, b))}</b>`)).join("")}</div>
      <div class="gbloc">${ligne("Moyenne par jour (7 j)", duree(Math.round(minutesChauffe(ajouterJours(auj, -6), auj) / Math.max(1, jours7))))}
      ${ligne("Nombre de chauffes (7 j)", String((chauffes.liste || []).filter(c => iso(new Date(c.debut)) >= ajouterJours(auj, -6)).length + (chauffes.enCours ? 1 : 0)))}</div>
      <p class="sub gpetit">Mesuré par le relais à chaque allumage et extinction du poêle salon, depuis le ${dateLongue(dj)}. Le détail de chaque chauffe est dans l'onglet Poêle, historique « Temps de chauffe ».</p>`;
  } else if (type === "rendement") {
    const r = rendementSalon();
    ico = "⏱️"; titre = "Chauffe par sac · Salon"; teinte = "vert";
    corps = `<p class="sub">Heures de chauffe du poêle salon entre deux sacs déclarés au salon. C'est la mesure la plus juste pour comparer deux marques, car elle ne dépend pas de la météo.</p>
      <div class="gbloc">${ligne("Moyenne", `<b>${r.parSac ? nb(r.parSac) + " h / sac" : "--"}</b>`)}${Object.entries(r.parMarque).map(([m, x]) => ligne(`🏷️ ${esc(m)}`, x.sacs ? `${nb(x.min / 60 / x.sacs)} h / sac (${sacsTxt(x.sacs)})` : "--")).join("")}</div>
      <p class="sub gpetit">Journal des chauffes tenu depuis le ${r.depuis ? dateLongue(r.depuis) : "--"}.</p>`;
  }
  ouvrirFeuille(`<div class="gmodtete">${ic(ico, teinte + " grand")}<h2>${titre}</h2></div>${corps}
    <div class="gpied"><button type="button" class="glien ${teinte}" data-gfermer>Fermer</button></div>`, d => {
    d.querySelectorAll("[data-gmoy]").forEach(b => b.addEventListener("click", () => { etat.moyenne = b.dataset.gmoy; rendre(); d.close(); detail("moyenne"); }));
  }, "centre");
}

/* ---------- Historique ---------- */
function vueHistorique() {
  const f = etat.filtreHisto, items = [];
  if (f === "tous" || f === "achat") D.achats.forEach(e => items.push({ l: "achats", e }));
  if (f === "tous" || f === "brulage") D.brulages.filter(e => dePoele(e)).forEach(e => items.push({ l: "brulages", e }));
  if (f === "tous" || f === "entretien") D.entretiens.filter(e => dePoele(e)).forEach(e => items.push({ l: "entretiens", e }));
  items.sort((a, b) => a.e.date < b.e.date ? 1 : a.e.date > b.e.date ? -1 : (b.e.cree || "").localeCompare(a.e.cree || ""));
  const groupes = new Map();
  for (const it of items) { const k = it.e.date.slice(0, 7); if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(it); }
  let h = `<div class="gseg quatre">${[["tous", "Tous"], ["achat", "🛒 Achat"], ["brulage", "🔥 Brûlage"], ["entretien", "🧹 Entretien"]]
    .map(([id, l]) => `<button data-ghisto="${id}" class="${f === id ? "sel" : ""}">${l}</button>`).join("")}</div>`;
  const avenir = f === "tous" || f === "entretien" ? D.rdv.filter(e => dePoele(e) && e.date >= aujourdhui()) : [];
  if (avenir.length) h += `<section class="gcarte"><div class="gtit">📅 À venir</div><div class="glist">${avenir.map(e => ligneHisto("rdv", e)).join("")}</div></section>`;
  if (!items.length) return h + `<section class="gcarte"><div class="sub">Rien pour l'instant.</div></section>`;
  let premier = true;
  for (const [k, l] of groupes) {
    const [a, m] = k.split("-").map(Number);
    const ouvert = etat.ouverts.has(k) || (premier && !etat.ouverts.has("!" + k));
    const ach = somme(l.filter(x => x.l === "achats").map(x => x.e)), br = somme(l.filter(x => x.l === "brulages").map(x => x.e));
    h += `<details class="gcarte gmois" data-gmois="${k}" ${ouvert ? "open" : ""}><summary><div><b>${MOIS_LONG[m - 1]} ${a}</b>
      <div class="gpetit"><span class="tbleu">🛒 ${nb(ach)} achetés</span>, <span class="torange">🔥 ${nb(br)} brûlés</span>${avecChauffe() && `${k}-31` >= debutJournal() ? `, <span style="color:${C_HEURES}">⏱️ ${duree(minutesChauffe(`${k}-01`, `${k}-31`))}</span>` : ""}</div></div></summary><div class="glist">`;
    for (const { l: liste, e } of l) h += ligneHisto(liste, e);
    h += `</div></details>`;
    premier = false;
  }
  return h;
}
function ligneHisto(liste, e) {
  const qui = e.qui ? ` · ${esc(e.qui)}` : "", note = e.note ? ` · ${esc(e.note)}` : "";
  let icone, teinte, titre, sous = "", droite = "";
  if (liste === "achats") {
    icone = "🛒"; teinte = "bleu"; titre = `${dateCourte(e.date)} · ${e.prixSac ? euros(prixAchat(e)) : "Achat"}`;
    sous = `${esc(e.marque)}${e.prixSac ? ` · ${euros(e.prixSac)}/sac` : ""}${e.lieu ? ` · ${esc(e.lieu)}` : ""}`;
    droite = `<b>${nb(e.sacs)}</b> sacs <small>(${R().kgSac}kg)</small>`;
  } else if (liste === "brulages") {
    icone = "🔥"; teinte = "orange"; titre = dateCourte(e.date); sous = `<i class="gpt" style="background:${COULEUR[e.poele]}"></i>${esc(courtPoele(e.poele))} · ${esc(e.marque)}`;
    droite = `<b>${nb(e.sacs)}</b> sac${e.sacs >= 2 ? "s" : ""} <small>(${R().kgSac}kg)</small>`;
  } else if (liste === "rdv") {
    icone = "📅"; teinte = "vert"; titre = esc(e.libelle || TYPES_ENT[e.type]); sous = `${dateLongue(e.date)} · ${esc(courtPoele(e.poele))}`;
  } else {
    icone = ICONE_ENT[e.type] || "🧹"; teinte = e.type === "vitre" ? "bleu" : e.type === "annexe" ? "violet" : e.type === "annuel" ? "vert" : "ambre";
    titre = esc(e.type === "annexe" && e.libelle ? e.libelle : TYPES_ENT[e.type]);
    sous = `${dateLongue(e.date)} · ${esc(courtPoele(e.poele))}`; droite = e.cout ? `<b>${euros(e.cout)}</b>` : "";
  }
  return `<div class="gitem ${teinte}" data-gedit="${liste}:${e.id}">${ic(icone, teinte)}<div class="gitxt"><b>${titre}</b><small>${sous}${qui}${note}</small></div><div class="gidr">${droite}</div></div>`;
}

/* ---------- Statistiques ---------- */
function saisonsConnues() {
  const s = new Set([saisonCourante()]);
  [...D.achats, ...D.brulages].forEach(e => s.add(anneeSaison(e.date)));
  return [...s].sort();
}
function vueStats() {
  const saisons = saisonsConnues();
  const sel = etat.saisonStats && saisons.includes(etat.saisonStats) ? etat.saisonStats : saisonCourante();
  const prec = sel - 1;
  const cles = clesPoeles();
  const brS = D.brulages.filter(b => anneeSaison(b.date) === sel && dePoele(b));
  const acS = D.achats.filter(a => anneeSaison(a.date) === sel);
  const mois = moisSaison(sel), couts = coutsBrulages();
  const premierMois = (a, m) => `${a}-${pad(m)}`;
  let h = `<div class="gpilule"><span>📅</span><select id="gSaisonStats">${saisons.slice().reverse().map(a => `<option value="${a}" ${a === sel ? "selected" : ""}>Saison ${a === saisonCourante() ? "courante" : nomSaison(a)} : ${MOIS[R().saisonDebut - 1]} ${a} - ${MOIS[R().saisonFin - 1]} ${a + 1}</option>`).join("")}</select></div>`;

  // 1. Mois par mois, comparé à la saison précédente, avec la température
  const sacs = etat.statMois === "sacs";
  const cols = mois.map(({ a, m }) => {
    const k = premierMois(a, m), kp = premierMois(a - 1, m);
    const l = brS.filter(b => b.date.startsWith(k)), lp = D.brulages.filter(b => b.date.startsWith(kp) && dePoele(b));
    const ce = coutDe(l, couts), cp = coutDe(lp, couts);
    const finMois = `${a}-${pad(m)}-${pad(new Date(a, m, 0).getDate())}`, jours = Math.max(1, Math.min(new Date(a, m, 0).getDate(), ecartJours(`${a}-${pad(m)}-01`, aujourdhui()) + 1));
    const t = tempMois(a, m), tp = tempMois(a - 1, m);
    return sacs
      ? { lab: MOIS_COURT[m - 1], valeurs: valeursPoeles(l), fantome: somme(lp),
          info: `<b>${MOIS_LONG[m - 1]}</b><br>${nomSaison(sel)} : ${sacsTxt(somme(l))}${t !== null ? ` (${temp(t)})` : ""}${avecChauffe() && `${k}-31` >= debutJournal() ? ` · ⏱️ ${duree(minutesChauffe(`${k}-01`, `${k}-31`))} de chauffe` : ""}<br>${nomSaison(prec)} : ${sacsTxt(somme(lp))}${tp !== null ? ` (${temp(tp)})` : ""}` }
      : { lab: MOIS_COURT[m - 1], valeurs: { e: Math.round(ce) }, fantome: Math.round(cp),
          info: `<b>${MOIS_LONG[m - 1]}</b><br>${nomSaison(sel)} : ${euros(ce)} de granulés brûlés${ce && `${a}-${pad(m)}-01` <= aujourdhui() ? ` · soit ${euros(ce / (finMois <= aujourdhui() ? new Date(a, m, 0).getDate() : jours))} / jour` : ""}<br>${nomSaison(prec)} : ${euros(cp)}` };
  });
  h += `<section class="gcarte gagrandir" data-bloc="mois">
    <button class="gbtn-ic gplein" data-gagrandir="1" aria-label="Agrandir">⤢</button>
    <div class="gseg">${[["sacs", "🔥 Sacs brûlés"], ["euros", "€ Coût brûlé"]].map(([id, l]) => `<button data-gstatmois="${id}" class="${etat.statMois === id ? "sel" + (id === "euros" ? " bleu" : "") : ""}">${l}</button>`).join("")}</div>
    ${legende([pastille(C_PASSE, nomSaison(prec)), ...(sacs ? (cles.length > 1 ? cles.map(k => pastille(COULEUR[k], `${nomSaison(sel)} · ${courtPoele(k)}`)) : [pastille(COULEUR[cles[0]], nomSaison(sel))]) : [pastille(C_EUROS, nomSaison(sel))]),
      `<button class="gmeteo${etat.meteoGraphe ? " sel" : ""}" data-gmeteo="1">🌡️ Météo ${etat.meteoGraphe ? "✓" : ""}</button>`])}
    ${barres(cols, { cle: "mois", cles: sacs ? cles : ["e"], couleurs: sacs ? COULEUR : { e: C_EUROS }, unite: sacs ? "" : "€",
      temperatures: etat.meteoGraphe && meteo ? [{ pts: mois.map(({ a, m }) => tempMois(a - 1, m)), couleur: "#7f9cc9", tirets: true }, { pts: mois.map(({ a, m }) => tempMois(a, m)), couleur: C_TEMP }] : null })}
    ${etat.meteoGraphe && meteo ? legende([pastille("#7f9cc9", `°C ${nomSaison(prec)}`, true), pastille(C_TEMP, `°C ${nomSaison(sel)} (échelle à droite)`)]) : ""}
    ${avecChauffe() ? panneauHeures(mois.map(({ a, m }) => [`${a}-${pad(m)}-01`, `${a}-${pad(m)}-${pad(new Date(a, m, 0).getDate())}`, MOIS_COURT[m - 1], false]), { cle: "moish" }) : ""}
    <div class="sub gpetit gcentre">Touche un mois pour comparer.</div></section>`;

  // 2. Saisons
  const toutes = []; for (let a = saisonCourante() - 5; a <= saisonCourante(); a++) toutes.push(a);
  const brules = etat.statSaison === "brules";
  h += `<section class="gcarte" data-bloc="saisons"><div class="gseg">${[["brules", "🔥 Sacs brûlés"], ["achetes", "🛍️ Sacs achetés"]].map(([id, l]) => `<button data-gstatsaison="${id}" class="${etat.statSaison === id ? "sel" + (id === "achetes" ? " bleu" : "") : ""}">${l}</button>`).join("")}</div>
    ${barres(toutes.map(a => {
      const l = brules ? D.brulages.filter(b => anneeSaison(b.date) === a && dePoele(b)) : D.achats.filter(x => anneeSaison(x.date) === a);
      return { lab: nomSaison(a), valeurs: brules ? valeursPoeles(l) : { e: somme(l) }, fort: a === sel,
        info: `<b>Saison ${nomSaison(a)}</b> : ${sacsTxt(somme(l))}${brules ? "" : ` · ${euros(somme(l, prixAchat))}`}` };
    }), { cle: "saisons", cles: brules ? cles : ["e"], couleurs: brules ? COULEUR : { e: "#6f7cf0" } })}
    ${brules ? legende(legendePoeles()) : ""}</section>`;

  // 3. Hivers froids ou doux
  const auj = aujourdhui(), sc = saisonCourante();
  const lignesHiver = toutes.map(a => {
    const fin = a === sc ? auj : finSaison(a), deb = debutSaison(a);
    const t = tempMoyenne(deb, fin), dj = dju(deb, fin);
    const s = somme(D.brulages.filter(b => anneeSaison(b.date) === a && dePoele(b)));
    const mc = avecChauffe() && fin >= debutJournal() ? minutesChauffe(deb, fin) : null;
    return { a, t, dj, s, mc, partiel: a === sc };
  });
  const tMoy = lignesHiver.filter(x => x.t !== null && !x.partiel).map(x => x.t);
  const ref = tMoy.length ? tMoy.reduce((x, y) => x + y, 0) / tMoy.length : null;
  const qualif = t => t === null || ref === null ? "" : t < ref - 1 ? "très froid" : t < ref - .3 ? "froid" : t > ref + 1 ? "très doux" : t > ref + .3 ? "doux" : "normal";
  h += `<section class="gcarte"><div class="gtete">${ic("❄️", "bleu")}<div><b>Hivers froids ou doux ?</b><div class="gpetit">Température moyenne d'${MOIS_LONG[R().saisonDebut - 1].toLowerCase()} à ${MOIS_LONG[R().saisonFin - 1].toLowerCase()} à ${esc(ville().nom)}</div></div></div>
    ${meteo ? `<div class="ghivers">${lignesHiver.map(x => `<div class="ghiver${x.a === sel ? " sel" : ""}"><span>${nomSaison(x.a)}${x.partiel ? "*" : ""}</span>
      <span class="gtherm"><i style="width:${x.t === null ? 0 : Math.max(4, Math.min(100, (x.t + 2) / 16 * 100))}%"></i></span>
      <span><b>${temp(x.t)}</b> <small>${qualif(x.t)}</small></span>
      <span class="gpetit">${x.dj !== null ? Math.round(x.dj) + " DJU" : ""}${x.s && x.dj ? ` · ${nb(x.s / x.dj * 100)} sacs/100 DJU` : ""}${x.mc ? ` · ⏱️ ${Math.round(x.mc / 60)} h de chauffe salon${x.dj ? ` (${nb(x.mc / 60 / x.dj * 100)} h/100 DJU)` : ""}` : ""}</span></div>`).join("")}</div>
      <p class="sub gpetit">* saison en cours, jusqu'à aujourd'hui. DJU (degrés-jours) : mesure du froid ; « sacs/100 DJU » compare la consommation à froid égal.</p>`
    : `<div class="sub">Météo indisponible pour l'instant.</div>`}</section>`;

  // 4. Intensité hebdomadaire : sacs brûlés ou temps de chauffe (switch)
  const tranches = [[1, 7], [8, 14], [15, 21], [22, 31]];
  const modeChauffe = etat.heatMode === "chauffe" && avecChauffe();
  const dj = debutJournal();
  const cases = mois.map(({ a, m }) => tranches.map(([d1, d2]) => {
    const fin = Math.min(d2, new Date(a, m, 0).getDate());
    const deb = `${a}-${pad(m)}-${pad(d1)}`, finIso = `${a}-${pad(m)}-${pad(fin)}`;
    const l = brS.filter(b => b.date >= deb && b.date <= finIso);
    const mc = avecChauffe() && finIso >= dj ? minutesChauffe(deb, finIso) : null;
    return { a, m, d1, fin, deb, finIso, sacs: somme(l), l, mc, val: modeChauffe ? (mc || 0) : somme(l) };
  }));
  const maxCase = Math.max(1, ...cases.flat().map(c => c.val));
  const RAMPE = modeChauffe ? ["#c9f2d9", "#8fdcaf", "#4cc287", "#24955f", "#11643c"] : ["#ffd98a", "#ffb04d", "#f57a22", "#d9481a", "#a32616"];
  const texteClair = modeChauffe ? "#0f2a1c" : "#3a1a08";
  const couleurCase = v => RAMPE[Math.min(4, Math.max(0, Math.ceil(v / maxCase * 5) - 1))];
  infos.cases = cases.map(col => col.map(c => {
    const t = tempMoyenne(c.deb, c.finIso);
    return `<b>Du ${c.d1} au ${c.fin} ${MOIS_LONG[c.m - 1].toLowerCase()} ${c.a}</b> : ${sacsTxt(c.sacs)} · ${nb(c.sacs * R().kgSac, 0)} kg${t !== null ? ` · ${temp(t)}` : ""}`
      + (c.mc !== null ? ` · ⏱️ ${duree(c.mc)} de chauffe${c.sacs && c.mc ? ` (${nb(c.mc / 60 / c.sacs)} h par sac)` : ""}` : "")
      + (c.l.length ? "<br>" + c.l.map(b => `${dateCourte(b.date)} · ${esc(courtPoele(b.poele))} · ${esc(b.marque)} : ${nb(b.sacs)}`).join("<br>") : "");
  }));
  h += `<section class="gcarte" data-bloc="intensite"><div class="gtete">${ic(modeChauffe ? "⏱️" : "📊", modeChauffe ? "vert" : "orange")}<div><b>Intensité ${modeChauffe ? "de chauffe" : "de consommation"}</b><div class="gpetit">${modeChauffe ? "Heures de chauffe du salon, par semaine" : "Sacs brûlés, par semaine"}</div></div>
    <div class="gechelle">Moins<i style="background:var(--gcase)"></i>${RAMPE.map(c => `<i style="background:${c}"></i>`).join("")}Plus</div></div>
    ${avecChauffe() ? `<div class="gseg petit" style="margin:12px 0 0">${[["sacs", "🔥 Sacs brûlés"], ["chauffe", "⏱️ Temps de chauffe"]].map(([id, l]) => `<button data-gheat="${id}" class="${(modeChauffe ? "chauffe" : "sacs") === id ? "sel" + (id === "chauffe" ? " vert" : "") : ""}">${l}</button>`).join("")}</div>` : ""}
    <div class="gheat" style="grid-template-columns:repeat(${mois.length},1fr)">
    ${mois.map(({ a, m }) => `<div class="gh-t">${MOIS_COURT[m - 1]} '${String(a).slice(2)}</div>`).join("")}
    ${tranches.map((_, ti) => cases.map((col, mi) => {
      const c = col[ti], coul = c.val ? couleurCase(c.val) : null, clair = coul && RAMPE.indexOf(coul) < 2;
      return `<button class="gh-c${c.val ? " plein" : ""}" data-gcase="${mi}-${ti}" style="${coul ? `background:${coul};color:${clair ? texteClair : "#fff"}` : ""}">${c.d1}-${c.fin}</button>`;
    }).join("")).join("")}</div><div class="ginfo" id="info-cases"></div>
    ${modeChauffe ? `<div class="gpetit gcentre" style="margin-top:8px">Temps de chauffe mesuré depuis le ${dateLongue(dj)}.</div>` : ""}</section>`;

  // 5. Fin du stock
  if (sel === sc) {
    const stock = stockTotal(), conso = consoMoyenne(), jours = conso > 0 ? Math.floor(stock / conso) : null;
    h += `<section class="gcarte"><div class="gtete">${ic("⏳", "orange")}<div><b>Prédiction de fin de stock</b><div class="gpetit">Projection de votre réserve de sacs</div></div></div>
      <div class="gtuiles trois"><div class="gmini"><span>Stock actuel</span><b>${nb(stock)} sacs</b><small>${nb(stock * R().kgSac, 0)} kg</small></div>
      <div class="gmini accent"><span>Autonomie</span><b>${jours ?? "--"} jours</b><small>${jours !== null ? `Fin : ${dateLongue(ajouterJours(auj, jours))}` : ""}</small></div>
      <div class="gmini"><span>Conso moyenne</span><b>${nb(conso, 2)} sac/j</b><small>${nb(conso * R().kgSac)} kg/j</small></div></div>
      ${jours !== null ? projection(stock, conso, jours) : ""}</section>`;
  }

  // 5 bis. Projection de la saison
  if (sel === sc) {
    const pj = projectionSaison();
    if (pj) h += `<section class="gcarte"><div class="gtete">${ic("💶", "cyan")}<div><b>Projection de la saison</b><div class="gpetit">${pj.methode === "meteo" ? `Selon le froid de l'an dernier sur le reste de la saison` : pj.methode === "lineaire" ? "Au rythme actuel (météo indisponible)" : "Saison terminée"}</div></div></div>
      <div class="gtuiles trois"><div class="gmini"><span>Déjà brûlé</span><b>${euros(pj.depense)}</b><small>${sacsTxt(pj.sacs)}</small></div>
      <div class="gmini accent"><span>Fin de saison</span><b>≈ ${euros(Math.round(pj.totalEuros))}</b><small>≈ ${sacsTxt(Math.round(pj.totalSacs))}</small></div>
      <div class="gmini"><span>Reste</span><b>≈ ${euros(Math.max(0, Math.round(pj.totalEuros - pj.depense)))}</b><small>≈ ${sacsTxt(Math.max(0, Math.round(pj.totalSacs - pj.sacs)))}</small></div></div>
      <div class="gpetit">Recalculé chaque jour${etat.poele !== "tous" ? ` · poêle ${esc(courtPoele(etat.poele).toLowerCase())} uniquement` : ""}.</div></section>`;
  }

  // 5 ter. Allumages et vitesse de chauffe (journal du salon)
  if (avecChauffe()) {
    const ch = chauffesListe(), dj = debutJournal(), auj2 = aujourdhui();
    const jours14 = [...Array(14).keys()].map(k => ajouterJours(auj2, k - 13)).filter(j => j >= dj);
    const nbJour = j => ch.filter(c => c.jour === j).length + (chauffes.enCours && iso(new Date(chauffes.enCours.debut)) === j ? 1 : 0);
    const nbJours = Math.max(1, ecartJours(dj, auj2) + 1), total = ch.length + (chauffes.enCours ? 1 : 0);
    const dureeMoy = ch.length ? somme(ch, c => c.minutes) / ch.length : null;
    infos.allum = jours14.map(j => { const l = ch.filter(c => c.jour === j); return `<b>${JOURS[date(j).getDay()].replace(".", "")} ${dateLongue(j)}</b> : ${nbJour(j)} allumage${nbJour(j) > 1 ? "s" : ""}${l.length ? ` · ${duree(somme(l, c => c.minutes))} de chauffe` : ""}${meteo && meteo.jours[j] !== undefined ? ` · ${temp(meteo.jours[j])}` : ""}`; });
    h += `<section class="gcarte"><div class="gtete">${ic("🔁", "ambre")}<div><b>Allumages du poêle salon</b><div class="gpetit">Chaque allumage consomme un surplus de granulés et use la bougie d'allumage</div></div></div>
      <div class="gtuiles trois"><div class="gmini"><span>Par jour</span><b>${nb(total / nbJours)}</b><small>en moyenne</small></div>
      <div class="gmini"><span>Durée moyenne</span><b>${dureeMoy !== null ? duree(Math.round(dureeMoy)) : "--"}</b><small>par chauffe</small></div>
      <div class="gmini"><span>Total</span><b>${total}</b><small>depuis le ${dateCourte(dj)}</small></div></div>
      ${barres(jours14.map(j => ({ lab: dateCourte(j).slice(0, 2), valeurs: { n: nbJour(j) }, fort: j === auj2 })), { cle: "allum", cles: ["n"], couleurs: { n: "#f0932b" }, hauteur: 100 })}</section>`;

    // vitesse de montée en température (cycles complets avec températures de début et de fin)
    const cycles = ch.filter(c => typeof c.tempDebut === "number" && typeof c.tempFin === "number" && c.minutes >= 20 && c.tempFin > c.tempDebut);
    if (cycles.length >= 3) {
      const vit = c => (c.tempFin - c.tempDebut) / (c.minutes / 60);          // °C par heure
      const ext = c => meteo && meteo.jours[c.jour] !== undefined ? meteo.jours[c.jour] : null;
      const groupes = [["Dehors < 5 °C", c => ext(c) !== null && ext(c) < 5], ["5 à 10 °C", c => ext(c) !== null && ext(c) >= 5 && ext(c) < 10], ["≥ 10 °C", c => ext(c) !== null && ext(c) >= 10]];
      const moy = l => l.length ? l.reduce((x, c) => x + vit(c), 0) / l.length : null;
      const recents = cycles.filter(c => c.jour >= ajouterJours(auj2, -6)), anciens = cycles.filter(c => c.jour < ajouterJours(auj2, -6));
      const vR = moy(recents), vA = moy(anciens), vT = moy(cycles);
      const minPour = v => v ? Math.round(1.5 / v * 60) : null;
      h += `<section class="gcarte"><div class="gtete">${ic("📈", "vert")}<div><b>Vitesse de chauffe du salon</b><div class="gpetit">Degrés gagnés par heure de chauffe (${cycles.length} chauffes)</div></div></div>
        <div class="gtuiles trois"><div class="gmini"><span>En moyenne</span><b>+${nb(vT)} °C/h</b><small>${minPour(vT)} min pour +1,5 °C</small></div>
        <div class="gmini"><span>7 derniers jours</span><b>${vR ? `+${nb(vR)} °C/h` : "--"}</b><small>${vR && vA ? (vR < vA * .85 ? "⚠️ plus lent" : vR > vA * 1.15 ? "plus rapide" : "stable") : ""}</small></div>
        <div class="gmini"><span>Avant</span><b>${vA ? `+${nb(vA)} °C/h` : "--"}</b><small></small></div></div>
        ${meteo ? groupes.map(([lib, f]) => { const l = cycles.filter(f), v = moy(l); return `<div class="gdl"><span>${lib}</span><span>${v ? `<b>+${nb(v)} °C/h</b> · ${minPour(v)} min pour +1,5 °C <small class="gpetit">(${l.length})</small>` : '<span class="gpetit">pas encore de données</span>'}</span></div>`; }).join("") : ""}
        <div class="gpetit" style="margin-top:6px">Si la vitesse baisse nettement à température extérieure égale, le poêle s'encrasse peut-être (brasier, échangeur, vitre).</div></section>`;
    }
  }

  // 6. Prix moyen par saison + évolution
  if (D.achats.length) {
    const ms = [...new Set(D.achats.map(a => a.marque))];
    const marquePrix = ms.includes(etat.marquePrix) ? etat.marquePrix : "tous";
    const ach = D.achats.filter(a => marquePrix === "tous" || a.marque === marquePrix);
    h += `<section class="gcarte" data-bloc="prix"><div class="gtete">${ic("🏷️", "bleu")}<div><b>Prix moyen du sac par saison</b></div></div>
      <div class="gchips gcentre">${["tous", ...ms].map(m => `<button data-gmarqueprix="${esc(m)}" class="${marquePrix === m ? "sel bleu" : ""}">${m === "tous" ? "Tous" : esc(m)}</button>`).join("")}</div>
      ${barres(toutes.map(a => { const p = moyennePrix(ach.filter(x => anneeSaison(x.date) === a)); return { lab: nomSaison(a), valeurs: { e: p ? Math.round(p * 100) / 100 : 0 }, fort: a === sel, info: p ? `<b>${nomSaison(a)}</b> : ${euros(p)} / sac` : "" }; }),
        { cle: "prix", cles: ["e"], couleurs: { e: "#6f7cf0" }, unite: "€", hauteur: 110 })}
      <div class="gtit gpetit">📉 Évolution chronologique du prix</div>
      ${ach.filter(a => a.prixSac).length >= 2 ? courbesPrix(ach.filter(a => a.prixSac)) : `<div class="sub gpetit gcentre">Enregistre au moins 2 achats avec un prix pour afficher la courbe.</div>`}</section>`;
  }

  // 7. Marques
  const parMarque = {}; brS.forEach(b => parMarque[b.marque] = (parMarque[b.marque] || 0) + b.sacs);
  const totB = somme(brS) || 1, r = etat.poele !== "cuisine" ? rendementSalon() : null;
  h += `<section class="gcarte"><div class="gtete">${ic("🥧", "vert")}<div><b>Répartition par marques</b><div class="gpetit">Sacs brûlés cette saison</div></div></div>
  ${Object.keys(parMarque).length ? Object.entries(parMarque).sort((a, b) => b[1] - a[1]).map(([m, n]) => {
    const rm = r && r.parMarque[m];
    return `<div class="gmarque"><div class="gligne2"><b>${esc(m)}</b><span>${sacsTxt(n)} · ${Math.round(n / totB * 100)} %</span></div>
      <div class="gjauge fine vert"><span style="width:${n / totB * 100}%"></span></div>
      <div class="gpetit">${moyennePrix(D.achats.filter(a => a.marque === m)) ? `Prix moyen ${euros(moyennePrix(D.achats.filter(a => a.marque === m)))}/sac` : "Prix inconnu"}${rm && rm.sacs ? ` · ${nb(rm.min / 60 / rm.sacs)} h de chauffe par sac (salon)` : ""}</div></div>`;
  }).join("") : `<div class="sub">Aucun sac brûlé sur cette saison.</div>`}</section>`;

  // 8. Dépenses entretien & accessoires
  const ent = D.entretiens.filter(e => dePoele(e));
  h += `<section class="gcarte"><div class="gtete">${ic("🧩", "violet")}<div><b>Dépenses entretien & accessoires</b></div></div>
    ${barres(toutes.map(a => { const l = ent.filter(e => anneeSaison(e.date) === a); return { lab: nomSaison(a), valeurs: { e: Math.round(somme(l, e => e.cout)) }, fort: a === sel, info: `<b>${nomSaison(a)}</b> : ${euros(somme(l, e => e.cout))} (${l.filter(e => e.cout).length} dépense${l.filter(e => e.cout).length > 1 ? "s" : ""})` }; }),
      { cle: "entretien", cles: ["e"], couleurs: { e: C_EUROS }, unite: "€", hauteur: 100 })}</section>`;

  // 9. Durée des saisons
  h += `<section class="gcarte"><div class="gtete">${ic("📏", "orange")}<div><b>Durée des saisons de chauffe</b><div class="gpetit">Du premier au dernier sac déclaré</div></div></div>
    <div class="gdurees">${toutes.map(a => {
      const l = D.brulages.filter(b => anneeSaison(b.date) === a && dePoele(b));
      const deb = date(debutSaison(a)), total = ecartJours(debutSaison(a), finSaison(a)) + 1;
      if (!l.length) return `<div class="gduree"><span class="glab2">${nomSaison(a)}</span><span class="gpiste"></span></div>`;
      const x1 = ecartJours(iso(deb), l[0].date) / total * 100, x2 = (ecartJours(iso(deb), l[l.length - 1].date) + 1) / total * 100;
      return `<div class="gduree"><span class="glab2">${nomSaison(a)}</span><span class="gpiste"><i style="left:${x1}%;width:${Math.max(3, x2 - x1)}%"></i></span>
        <span class="gpetit">${dateCourte(l[0].date)} → ${dateCourte(l[l.length - 1].date)}</span></div>`;
    }).join("")}</div></section>`;
  return h;
}
/* ---------- Vue agrandie : la saison semaine par semaine ---------- */
function semainesSaison(a) {          // lundis de la saison, du début au dernier jour
  const deb = date(debutSaison(a)); deb.setDate(deb.getDate() - ((deb.getDay() + 6) % 7));
  const fin = finSaison(a), out = [];
  for (let d = iso(deb); d <= fin; d = ajouterJours(d, 7)) out.push(d);
  return out;
}
function vueGrand(d) {
  const saisons = saisonsConnues();
  const sel = etat.saisonStats && saisons.includes(etat.saisonStats) ? etat.saisonStats : saisonCourante();
  const prec = sel - 1, cles = clesPoeles(), sacs = etat.statMois === "sacs", couts = coutsBrulages();
  const sem = semainesSaison(sel), semP = semainesSaison(prec), auj = aujourdhui();
  const br = D.brulages.filter(b => dePoele(b));
  const PX = 30;
  const cols = sem.map((lundi, i) => {
    const fin = ajouterJours(lundi, 6), l = br.filter(b => b.date >= lundi && b.date <= fin);
    const lp0 = semP[i], lp = lp0 ? br.filter(b => b.date >= lp0 && b.date <= ajouterJours(lp0, 6)) : [];
    const t = tempMoyenne(lundi, fin), tp = lp0 ? tempMoyenne(lp0, ajouterJours(lp0, 6)) : null;
    const mc = avecChauffe() && fin >= debutJournal() ? minutesChauffe(lundi, fin) : null;
    const dl = date(lundi), nouveauMois = i === 0 || dl.getMonth() !== date(sem[i - 1]).getMonth();
    const val = sacs ? valeursPoeles(l) : { e: Math.round(coutDe(l, couts) * 100) / 100 };
    const valP = sacs ? somme(lp) : Math.round(coutDe(lp, couts));
    return { lab: nouveauMois ? MOIS_COURT[dl.getMonth()] : "", valeurs: val, fantome: valP, fort: lundi <= auj && auj <= fin,
      info: `<b>Semaine du ${dateCourte(lundi)} au ${dateCourte(fin)}</b><br>${nomSaison(sel)} : ${sacs ? sacsTxt(somme(l)) : euros(coutDe(l, couts))}${t !== null ? ` · ${temp(t)}` : ""}${mc !== null ? ` · ⏱️ ${duree(mc)} de chauffe` : ""}`
        + (lp0 ? `<br>${nomSaison(prec)} (${dateCourte(lp0)}) : ${sacs ? sacsTxt(somme(lp)) : euros(coutDe(lp, couts))}${tp !== null ? ` · ${temp(tp)}` : ""}` : "") };
  });
  const W = sem.length * PX;
  const temps = etat.meteoGraphe && meteo ? [
    { pts: sem.map((_, i) => semP[i] ? tempMoyenne(semP[i], ajouterJours(semP[i], 6)) : null), couleur: "#7f9cc9", tirets: true },
    { pts: sem.map(l => tempMoyenne(l, ajouterJours(l, 6))), couleur: C_TEMP }] : null;
  const dj = debutJournal();
  const heures = avecChauffe() ? barres(sem.map(l => { const fin = ajouterJours(l, 6), m = fin < dj ? null : minutesChauffe(l, fin);
    return { lab: "", valeurs: { h: m ? Math.round(m / 6) / 10 : 0 }, info: "" }; }), { cles: ["h"], couleurs: { h: C_HEURES }, hauteur: 80, unite: "h", largeur: W, etiquettes: true }) : "";
  const total = cols.reduce((x, c) => x + Object.values(c.valeurs).reduce((a, b) => a + b, 0), 0);
  d.querySelector("#gGrandCorps").innerHTML = `
    <div class="gseg">${[["sacs", "🔥 Sacs brûlés"], ["euros", "€ Coût brûlé"]].map(([id, l]) => `<button type="button" data-gstatmois="${id}" class="${etat.statMois === id ? "sel" + (id === "euros" ? " bleu" : "") : ""}">${l}</button>`).join("")}</div>
    <div class="gligne2"><div class="gpilule" style="margin:0"><span>📅</span><select id="gGrandSaison">${saisons.slice().reverse().map(a => `<option value="${a}" ${a === sel ? "selected" : ""}>Saison ${nomSaison(a)}</option>`).join("")}</select></div>
      <button type="button" class="gmeteo${etat.meteoGraphe ? " sel" : ""}" data-gmeteo="1">🌡️ Météo ${etat.meteoGraphe ? "✓" : ""}</button></div>
    ${legende([pastille(C_PASSE, nomSaison(prec)), ...(sacs ? cles.map(k => pastille(COULEUR[k], `${nomSaison(sel)}${cles.length > 1 ? " · " + courtPoele(k) : ""}`)) : [pastille(C_EUROS, nomSaison(sel))]),
      ...(temps ? [pastille("#7f9cc9", `°C ${nomSaison(prec)}`, true), pastille(C_TEMP, `°C ${nomSaison(sel)}`)] : [])])}
    <div class="gdefil" id="gDefil">
      ${barres(cols, { cle: "gw", cles: sacs ? cles : ["e"], couleurs: sacs ? COULEUR : { e: C_EUROS }, hauteur: 230, largeur: W, temperatures: temps, etiquettes: true, unite: sacs ? "" : "€" }).replace(/<div class="ginfo"[^>]*><\/div>$/, "")}
      ${heures ? `<div class="gtit gpetit" style="margin-top:10px">⏱️ Heures de chauffe · Salon</div>${heures}` : ""}
    </div>
    <div class="ginfo" id="info-gw">Touche une semaine pour le détail.</div>
    <div class="gpetit gcentre" style="margin-top:8px">Total de la saison : <b>${sacs ? sacsTxt(total) : euros(total)}</b> · fais glisser le graphique de côté</div>`;
  // place la semaine en cours au centre
  const defil = d.querySelector("#gDefil"), k = sem.findIndex((l, i) => l <= auj && auj <= ajouterJours(l, 6));
  if (k >= 0) defil.scrollLeft = Math.max(0, k * PX - defil.clientWidth / 2);
}
function ouvrirGrand() {
  ouvrirFeuille(`<div class="dhead"><div class="gtete">${ic("📊", "orange")}<h2>Semaine par semaine</h2></div><button class="gbtn-ic" data-gfermer type="button" aria-label="Fermer">✕</button></div><div id="gGrandCorps"></div>`, d => {
    vueGrand(d);
    const corps = d.querySelector("#gGrandCorps");
    corps.addEventListener("click", ev => {
      const z = ev.target.closest("[data-gtap]");
      if (z) { const [cle, i] = z.dataset.gtap.split(":"); const el = d.querySelector(`#info-${cle}`); if (el && infos[cle]) el.innerHTML = infos[cle][i] || ""; return; }
      const b = ev.target.closest("button"); if (!b) return;
      if (b.dataset.gstatmois) { etat.statMois = b.dataset.gstatmois; vueGrand(d); rendre(); }
      if (b.dataset.gmeteo) { etat.meteoGraphe = !etat.meteoGraphe; store.set("g.meteoGraphe", etat.meteoGraphe ? "oui" : "non"); vueGrand(d); rendre(); }
    });
    corps.addEventListener("change", ev => { if (ev.target.id === "gGrandSaison") { etat.saisonStats = Number(ev.target.value); vueGrand(d); rendre(); } });
  }, "plein");
}

function courbesPrix(ach) {
  const W = 320, H = 110, vals = ach.map(a => a.prixSac), min = Math.min(...vals), max = Math.max(...vals);
  const bas = min === max ? min - .5 : min - (max - min) * .2, haut = min === max ? max + .5 : max + (max - min) * .2;
  const x = i => 30 + i / Math.max(1, ach.length - 1) * (W - 44), y = v => 8 + (1 - (v - bas) / (haut - bas)) * (H - 30);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="gsvg">`;
  for (let k = 0; k <= 2; k++) { const v = bas + (haut - bas) * k / 2; svg += `<line x1="28" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="ggrille"/><text x="0" y="${y(v) + 3}" class="glab gauche">${nb(v, 2)}€</text>`; }
  svg += `<path d="${ach.map((a, i) => `${i ? "L" : "M"}${x(i)},${y(a.prixSac)}`).join(" ")}" stroke="#6f7cf0" stroke-width="2" fill="none"/>`;
  ach.forEach((a, i) => { svg += `<circle cx="${x(i)}" cy="${y(a.prixSac)}" r="4" fill="#6f7cf0" stroke="var(--gcarte)" stroke-width="2"><title>${dateLongue(a.date)} : ${euros(a.prixSac)}</title></circle>
    <text x="${x(i)}" y="${H - 6}" class="glab">${dateCourte(a.date)}</text>`; });
  return svg + "</svg>";
}
function projection(stock, conso, jours) {
  const W = 320, H = 130, n = Math.min(jours, 120), auj = aujourdhui();
  const x = j => 26 + j / n * (W - 34), y = v => 8 + (1 - v / Math.max(1, stock)) * (H - 30);
  const finVal = Math.max(0, stock - conso * n);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="gsvg">`;
  for (let k = 0; k <= 3; k++) { const v = Math.round(stock * k / 3); svg += `<line x1="24" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="ggrille"/><text x="0" y="${y(v) + 3}" class="glab gauche">${v}</text>`; }
  svg += `<defs><linearGradient id="gdeg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${C_SALON}" stop-opacity=".35"/><stop offset="1" stop-color="${C_SALON}" stop-opacity="0"/></linearGradient></defs>
    <path d="M${x(0)},${y(stock)} L${x(n)},${y(finVal)} L${x(n)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#gdeg)"/>
    <path d="M${x(0)},${y(stock)} L${x(n)},${y(finVal)}" stroke="${C_SALON}" stroke-width="2.5" fill="none"/>`;
  for (let k = 0; k <= 4; k++) { const j = Math.round(n * k / 4); svg += `<text x="${Math.min(W - 22, Math.max(30, x(j)))}" y="${H - 5}" class="glab">${dateCourte(ajouterJours(auj, j))}</text>`; }
  infos.proj = []; const pas = (W - 34) / 8;
  for (let k = 0; k < 8; k++) {
    const j = Math.round(n * (k + .5) / 8); infos.proj.push(`<b>${dateLongue(ajouterJours(auj, j))}</b> : ${nb(Math.max(0, stock - conso * j))} sacs restants (${nb(Math.max(0, stock - conso * j) * R().kgSac, 0)} kg)`);
    svg += `<rect x="${26 + k * pas}" y="0" width="${pas}" height="${H}" fill="transparent" data-gtap="proj:${k}" class="gzone"/>`;
  }
  return svg + `</svg><div class="ginfo" id="info-proj"></div>`;
}

/* ---------- Entretiens ---------- */
/** Couleur de la jauge : vert juste après l'entretien, puis jaune, orange, rouge foncé à l'échéance ;
    noir au-delà de 150 % de la fréquence (ex. plus de 10,5 jours pour un entretien tous les 7 jours). */
function couleurEntretien(ratio) {
  if (ratio > 1.5) return "#000";
  const etapes = [[0, [63, 210, 154]], [.4, [242, 209, 75]], [.7, [240, 147, 43]], [1, [158, 27, 27]]];
  const r = Math.min(1, Math.max(0, ratio));
  for (let k = 1; k < etapes.length; k++) {
    const [a, ca] = etapes[k - 1], [b, cb] = etapes[k];
    if (r <= b) { const t = (r - a) / (b - a); return `rgb(${ca.map((v, i) => Math.round(v + (cb[i] - v) * t)).join(",")})`; }
  }
  return "rgb(158,27,27)";
}
function vueEntretiens() {
  const p = etat.poele !== "tous" ? etat.poele : etat.entPoele;
  let h = etat.poele === "tous" ? `<div class="gseg">${D.poeles.map(x => `<button data-gentp="${x.id}" class="${p === x.id ? "sel" : ""}"><i class="gpt" style="background:${COULEUR[x.id]}"></i>${esc(courtPoele(x.id))}</button>`).join("")}</div>` : "";
  const ent = D.entretiens.filter(e => e.poele === p);
  const dernier = t => ent.filter(e => e.type === t).map(e => e.date).sort().pop() || null;
  const da = dernier("annuel");
  const rdv = D.rdv.filter(r => r.poele === p && r.type === "annuel").sort((a, b) => a.date < b.date ? -1 : 1).pop();
  h += `<button class="gcarte gent vert" data-gact="annuel-menu:${p}"><div class="gligne2"><div class="gtete">${ic("🛠️", "vert")}<b>Entretien annuel</b></div>${rdv ? `<span class="gbadge vert">RDV FIXÉ</span>` : `<span class="gbadge">À PLANIFIER</span>`}</div>
    <div class="gligne2" style="margin-top:12px"><div><div class="gpetit">Dernier entretien</div><b>${da ? dateLongue(da) : "Aucun"}</b></div>
    <div class="adroite"><div class="gpetit">Prochain</div><b class="tvert">📅 ${rdv ? dateLongue(rdv.date) : "--"}</b></div></div></button>`;
  for (const t of ["regulier", "vitre"]) {
    const d = dernier(t), freq = (R().frequences || {})[t] || (t === "vitre" ? 2 : 7);
    const depuis = d ? ecartJours(d, aujourdhui()) : null, aJour = depuis !== null && depuis <= freq;
    const ratio = depuis === null ? 2 : depuis / freq;
    const pct = Math.min(100, ratio * 100), coul = couleurEntretien(ratio), noir = ratio > 1.5;
    const teinte = t === "vitre" ? "bleu" : "orange";
    h += `<button class="gcarte gent ${teinte}" data-gact="fait:${t}:${p}"><div class="gligne2"><div class="gtete">${ic(ICONE_ENT[t], teinte)}<b>${TYPES_ENT[t]}</b></div>
      <span class="gbadge ${aJour ? "vert" : "orange"}">${aJour ? (t === "vitre" ? "Propre" : "À jour") : "À faire"}</span></div>
      <div class="gligne2" style="margin-top:10px"><div class="gtete"><span class="ganneau${noir ? " noir" : ""}" style="--p:${noir ? 100 : pct};--c:${coul}"></span><b>${depuis ?? "--"}</b><span class="gpetit">/ ${freq} jours</span></div>
      <span class="gpetit">${d ? `Fait ${depuis === 0 ? "aujourd'hui" : depuis === 1 ? "hier" : `il y a ${depuis} jours`}` : "Jamais fait"}</span></div></button>`;
  }
  const annexes = ent.filter(e => e.type === "annexe").slice().reverse();
  h += `<section class="gcarte gent violet"><div class="gligne2"><div class="gtete">${ic("🧩", "violet")}<b>Dépenses annexes</b></div></div>
    ${annexes.length ? `<div class="glist">${annexes.slice(0, 10).map(e => ligneHisto("entretiens", e)).join("")}</div>` : `<div class="gpetit" style="margin-top:8px">Brosses, aspirateur, joints… les petites dépenses du poêle.</div>`}
    <button class="gbouton violet" data-gact="annexe:${p}">＋ Ajouter</button></section>`;
  return h;
}

/* ---------- Fenêtres ---------- */
function ouvrirFeuille(html, init, style = "bas") {
  const d = $("gSheet");
  d.className = style;
  d.innerHTML = `<form method="dialog" class="gform">${html}</form>`;
  d.querySelectorAll("[data-gfermer]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); d.close(); }));
  document.documentElement.classList.add("bloque");
  if (!d.open) d.showModal();
  // Dates : calendrier maison aux couleurs de l'onglet Granulés
  if (window.ameliorerChamp) d.querySelectorAll('input[type="date"]').forEach(i => ameliorerChamp(i, { theme: "g", titre: "Date" }));
  if (init) init(d);
}
$("gSheet").addEventListener("close", () => document.documentElement.classList.remove("bloque"));
$("gSheet").addEventListener("click", e => { if (e.target === $("gSheet")) $("gSheet").close(); });
const tete = (icone, titre, teinte = "orange") => `<div class="dhead"><div class="gtete">${ic(icone, teinte)}<h2>${titre}</h2></div><button class="gbtn-ic" data-gfermer type="button" aria-label="Fermer">✕</button></div>`;
const champ = (lab, input) => `<label class="f">${lab}${input}</label>`;
const choixPoele = (sel, nom = "poele") => `<div class="gchips">${D.poeles.map(p => `<label class="gradio"><input type="radio" name="${nom}" value="${p.id}" ${p.id === sel ? "checked" : ""}><span><i style="background:${COULEUR[p.id]}"></i>${esc(courtPoele(p.id))}</span></label>`).join("")}</div>`;
function marques() {
  const s = new Set(R().marques || []);
  D.achats.forEach(a => s.add(a.marque)); D.brulages.forEach(b => s.add(b.marque));
  if (!s.size) s.add("Générique");
  return [...s];
}
const optMarques = (sel, avecStock) => {
  const st = stockParMarque();
  return marques().map(m => `<option value="${esc(m)}" ${m === sel ? "selected" : ""}>${esc(m)}${avecStock ? ` (${nb(st[m] || 0)} sacs)` : ""}</option>`).join("");
};
function poeleParDefaut() { return etat.poele !== "tous" ? etat.poele : "salon"; }   // le salon consomme le plus
// Entretien : le poêle filtré s'il y en a un, sinon le salon (le poêle du dernier brûlage n'a rien à voir)
function poeleEntretien() { return etat.poele !== "tous" ? etat.poele : "salon"; }
function marqueParDefaut() {
  const st = stockParMarque(), dern = D.brulages[D.brulages.length - 1];
  if (dern && (st[dern.marque] || 0) > 0) return dern.marque;
  return Object.entries(st).sort((a, b) => b[1] - a[1])[0]?.[0] || marques()[0];
}
function feuilleBrulage(e) {
  const modif = !!e; e = e || { date: aujourdhui(), sacs: 1, poele: poeleParDefaut(), marque: marqueParDefaut(), note: "" };
  ouvrirFeuille(`${tete("🔥", modif ? "Modifier le brûlage" : "Brûlage")}
    ${champ("Date", `<input type="date" name="date" value="${e.date}" required>`)}
    <div class="f">Poêle${choixPoele(e.poele)}</div>
    ${champ("Marque de granulés", `<select name="marque">${optMarques(e.marque, true)}</select>`)}
    <div class="gcompteur"><button type="button" data-pas="-0.5">−</button><output name="sacsAff">${nb(e.sacs)}</output><span>sacs</span><button type="button" data-pas="0.5">+</button><input type="hidden" name="sacs" value="${e.sacs}"></div>
    ${champ("Note (facultatif)", `<input type="text" name="note" value="${esc(e.note || "")}">`)}
    ${boutonsForm(modif, "Ajouter le brûlage", "orange")}`, d => {
    d.querySelectorAll("[data-pas]").forEach(b => b.addEventListener("click", () => {
      const f = d.querySelector("form"), v = Math.max(.5, Number(f.sacs.value) + Number(b.dataset.pas));
      f.sacs.value = v; f.sacsAff.value = nb(v);
    }));
    brancherForm(d, "brulages", e, f => ({ date: f.date.value, poele: f.poele.value, marque: f.marque.value, sacs: Number(f.sacs.value), note: f.note.value }),
      el => store.set("g.dernierPoele", el.poele));
  });
}
function feuilleAchat(e) {
  const modif = !!e; e = e || { date: aujourdhui(), sacs: "", marque: marqueParDefaut(), prixSac: "", lieu: "", note: "" };
  ouvrirFeuille(`${tete("🛒", modif ? "Modifier l'achat" : "Achat", "bleu")}
    ${champ("Date", `<input type="date" name="date" value="${e.date}" required>`)}
    ${champ("Marque de granulés", `<select name="marque">${optMarques(e.marque)}<option value="__nouvelle">＋ Nouvelle marque…</option></select>`)}
    <label class="f" id="gNouvelleMarque" hidden>Nom de la marque<input type="text" name="nouvelle" autocapitalize="words"></label>
    <div class="f">Nombre de sacs<div class="gsacs"><input type="number" name="sacs" inputmode="decimal" min="0.5" step="0.5" value="${e.sacs}" placeholder="sacs" required>
      ${[1, 5, 10].map(n => `<button type="button" class="gpetitbtn" data-plus="${n}">+${n}</button>`).join("")}</div></div>
    <div class="two">${champ("Prix unitaire (€)", `<input type="number" name="prixSac" inputmode="decimal" step="0.01" min="0" value="${e.prixSac ?? ""}">`)}
      ${champ("Prix total (€)", `<input type="number" name="total" inputmode="decimal" step="0.01" min="0" value="${e.prixSac && e.sacs ? (e.prixSac * e.sacs).toFixed(2) : ""}">`)}</div>
    ${champ("Lieu d'achat (facultatif)", `<input type="text" name="lieu" value="${esc(e.lieu || "")}">`)}
    ${champ("Note (facultatif)", `<input type="text" name="note" value="${esc(e.note || "")}">`)}
    ${boutonsForm(modif, "Ajouter l'achat", "bleu")}`, d => {
    const f = d.querySelector("form");
    f.marque.addEventListener("change", () => { $("gNouvelleMarque").hidden = f.marque.value !== "__nouvelle"; });
    const majTotal = () => { if (f.prixSac.value && f.sacs.value) f.total.value = (f.prixSac.value * f.sacs.value).toFixed(2); };
    d.querySelectorAll("[data-plus]").forEach(b => b.addEventListener("click", () => { f.sacs.value = (Number(f.sacs.value) || 0) + Number(b.dataset.plus); majTotal(); }));
    f.prixSac.addEventListener("input", majTotal); f.sacs.addEventListener("input", majTotal);
    f.total.addEventListener("input", () => { if (f.total.value && Number(f.sacs.value)) f.prixSac.value = (f.total.value / f.sacs.value).toFixed(2); });
    brancherForm(d, "achats", e, f => {
      const marque = f.marque.value === "__nouvelle" ? f.nouvelle.value.trim() : f.marque.value;
      if (!marque) throw new Error("Indique le nom de la marque");
      return { date: f.date.value, marque, sacs: Number(f.sacs.value), prixSac: f.prixSac.value === "" ? null : Number(f.prixSac.value), lieu: f.lieu.value, note: f.note.value };
    });
  });
}
function feuilleEntretien(e, type, poele) {
  const modif = !!e; e = e || { date: aujourdhui(), type, poele: poele || poeleEntretien(), note: "", cout: null, libelle: "" };
  const annexe = e.type === "annexe", teinte = { annuel: "vert", regulier: "orange", vitre: "bleu", annexe: "violet" }[e.type];
  ouvrirFeuille(`${tete(ICONE_ENT[e.type], modif ? `Modifier : ${TYPES_ENT[e.type]}` : TYPES_ENT[e.type], teinte)}
    ${champ("Date", `<input type="date" name="date" value="${e.date}" required>`)}
    <div class="f">Poêle${choixPoele(e.poele)}</div>
    ${annexe ? champ("Quoi ?", `<input type="text" name="libelle" value="${esc(e.libelle || "")}" placeholder="ex. brosse, joint de porte…" required>`) : ""}
    ${annexe || e.type === "annuel" ? champ("Coût (€)", `<input type="number" name="cout" inputmode="decimal" step="0.01" min="0" value="${e.cout ?? ""}">`) : ""}
    ${champ("Note (facultatif)", `<input type="text" name="note" value="${esc(e.note || "")}" ${e.type === "annuel" ? 'placeholder="ex. nom du professionnel"' : ""}>`)}
    ${boutonsForm(modif, annexe ? "Ajouter la dépense" : e.type === "vitre" ? "C'est propre !" : "C'est fait !", teinte)}`, d => {
    brancherForm(d, "entretiens", e, f => ({ date: f.date.value, type: e.type, poele: f.poele.value, note: f.note.value,
      libelle: f.libelle ? f.libelle.value : "", cout: f.cout && f.cout.value !== "" ? Number(f.cout.value) : null }),
      async el => {
        if (e.type !== "annuel" || modif) return;
        const rdv = D.rdv.find(r => r.poele === el.poele && r.type === "annuel" && r.date <= ajouterJours(aujourdhui(), 60));
        if (rdv) await envoyer({ op: "supprimer", liste: "rdv", id: rdv.id }).catch(() => {});
      });
  });
}
function feuilleRdv(poele) {
  const rdv = D.rdv.find(r => r.poele === poele && r.type === "annuel");
  ouvrirFeuille(`${tete("📅", "Rendez-vous d'entretien annuel", "vert")}
    <div class="f">Poêle : <b style="color:var(--gtexte)">${esc(courtPoele(poele))}</b></div>
    ${champ("Date du rendez-vous", `<input type="date" name="date" value="${rdv ? rdv.date : ""}" required>`)}
    ${champ("Libellé", `<input type="text" name="libelle" value="${esc(rdv ? rdv.libelle || "" : "Ramonage")}">`)}
    ${champ("Note (facultatif)", `<input type="text" name="note" value="${esc(rdv ? rdv.note || "" : "")}" placeholder="ex. ramoneur, heure…">`)}
    <button class="gvalider vert" type="submit">Enregistrer</button>`, d => {
    brancherForm(d, "rdv", rdv, f => ({ date: f.date.value, type: "annuel", poele, note: f.note.value, libelle: f.libelle.value }));
  });
}
function menuAnnuel(poele) {
  const rdv = D.rdv.find(r => r.poele === poele && r.type === "annuel");
  const opt = (id, icone, t, s, cls = "") => `<button type="button" class="gmenu ${cls}" data-m="${id}"><span>${icone}</span><div><b>${t}</b><small>${s}</small></div></button>`;
  ouvrirFeuille(`<div class="gpoignee"></div>
    ${opt("passe", "🕘", "Noter un entretien passé", "Ajoute une entrée à l'historique")}
    ${rdv ? opt("fait", "✅", "Valider l'entretien (fait)", "Transforme ce rendez-vous en entrée d'historique") : ""}
    ${opt("rdv", "📅", rdv ? "Modifier le rendez-vous" : "Planifier un rendez-vous", "Planifie votre prochain entretien")}
    ${rdv ? opt("annuler", "🗑️", "Annuler le rendez-vous", "Supprime le rendez-vous futur", "rouge") : ""}`, d => {
    d.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", async () => {
      const m = b.dataset.m;
      if (m === "passe") return feuilleEntretien(null, "annuel", poele);
      if (m === "rdv") return feuilleRdv(poele);
      if (m === "fait") return feuilleEntretien({ date: rdv.date <= aujourdhui() ? rdv.date : aujourdhui(), type: "annuel", poele, note: rdv.note || "", libelle: rdv.libelle, cout: null }, "annuel", poele);
      if (m === "annuler") { d.close(); envoyer({ op: "supprimer", liste: "rdv", id: rdv.id }).then(() => toast("✓ Rendez-vous annulé")).catch(e => toast(e.message)); }
    }));
  });
}
function boutonsForm(modif, libelle, teinte = "orange") {
  return modif
    ? `<button class="gvalider ${teinte}" type="submit">Enregistrer</button>
       <button class="save danger" type="button" data-gsuppr>Supprimer</button>
       <div class="confirm" data-gconfirm><div>Supprimer définitivement cette ligne ?</div><div class="two">
         <button class="save" type="button" data-gnon>Annuler</button><button class="save danger-plein" type="button" data-goui>Oui, supprimer</button></div></div>`
    : `<button class="gvalider ${teinte}" type="submit">${libelle}</button>`;
}
function brancherForm(d, liste, e, lire, apres) {
  const f = d.querySelector("form"), modif = !!(e && e.id);
  f.addEventListener("submit", async ev => {
    ev.preventDefault();
    let el; try { el = lire(f); } catch (err) { return toast(err.message); }
    if (!el.date) return toast("Indique une date");
    const b = f.querySelector(".gvalider"); b.disabled = true; const txt = b.textContent; b.textContent = "Enregistrement…";
    try {
      await envoyer({ op: modif ? "modifier" : "ajouter", liste, id: modif ? e.id : undefined, element: el });
      if (apres) await apres(el);
      d.close(); toast(modif ? "✓ Modifié" : "✓ Enregistré");
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = txt; }
  });
  const s = f.querySelector("[data-gsuppr]");
  if (s) {
    s.addEventListener("click", () => { f.querySelector("[data-gconfirm]").classList.add("show"); s.hidden = true; });
    f.querySelector("[data-gnon]").addEventListener("click", () => { f.querySelector("[data-gconfirm]").classList.remove("show"); s.hidden = false; });
    f.querySelector("[data-goui]").addEventListener("click", async ev => {
      ev.target.disabled = true;
      try { await envoyer({ op: "supprimer", liste, id: e.id }); d.close(); toast("✓ Supprimé"); }
      catch (err) { toast(err.message); ev.target.disabled = false; }
    });
  }
}
/* Bouton + : éventail Brûlage (gauche) · Autres (haut) · Entretien (droite) */
const radial = document.createElement("div");
radial.className = "gradial";
radial.innerHTML = `<button class="gr-btn brulage" data-r="brulage"><i>🔥</i>Brûlage</button>
  <button class="gr-btn autres" data-r="autres"><i>⋯</i>Autres</button>
  <button class="gr-btn entretien" data-r="entretien"><i>🧹</i>Entretien</button>`;
document.body.appendChild(radial);
function basculerRadial(ouvrir) {
  const fab = $("gPlus");
  radial.classList.toggle("ouvert", ouvrir);
  if (fab) fab.classList.toggle("ouvert", ouvrir);
}
radial.addEventListener("click", e => {
  const b = e.target.closest("[data-r]");
  basculerRadial(false);
  if (!b) return;
  if (b.dataset.r === "brulage") feuilleBrulage();
  else if (b.dataset.r === "entretien") menuEntretien();
  else menuAutres();
});
const optMenu = (id, icone, t, s, teinte) => `<button type="button" class="gmenu" data-g="${id}">${ic(icone, teinte)}<div><b>${t}</b><small>${s}</small></div></button>`;
function menuEntretien() {
  ouvrirFeuille(`<div class="gpoignee"></div><div class="gtit" style="margin:0 4px 6px">Entretien</div>
    ${optMenu("regulier", "🧹", "Entretien régulier", "Brasier, cendres…", "orange")}
    ${optMenu("vitre", "✨", "Nettoyage vitre", "Vitre propre", "bleu")}
    ${optMenu("annuel", "🛠️", "Entretien annuel", "Ramonage, visite du professionnel", "vert")}`, d => {
    d.querySelectorAll("[data-g]").forEach(b => b.addEventListener("click", () => feuilleEntretien(null, b.dataset.g)));
  });
}
function menuAutres() {
  ouvrirFeuille(`<div class="gpoignee"></div><div class="gtit" style="margin:0 4px 6px">Autres</div>
    ${optMenu("achat", "🛒", "Achat de granulés", "Des sacs ajoutés au stock", "bleu")}
    ${optMenu("annexe", "🧩", "Dépense annexe", "Brosse, joint, aspirateur…", "violet")}
    ${optMenu("rdv", "📅", "Rendez-vous d'entretien annuel", "Planifier le ramonage", "vert")}`, d => {
    d.querySelectorAll("[data-g]").forEach(b => b.addEventListener("click", () => {
      const x = b.dataset.g;
      if (x === "achat") feuilleAchat(); else if (x === "annexe") feuilleEntretien(null, "annexe"); else feuilleRdv(poeleEntretien());
    }));
  });
}
function feuilleAjout() {
  const opt = (id, icone, t, s, teinte) => `<button type="button" class="gmenu" data-g="${id}">${ic(icone, teinte)}<div><b>${t}</b><small>${s}</small></div></button>`;
  ouvrirFeuille(`<div class="gpoignee"></div>
    ${opt("brulage", "🔥", "Brûlage", "Un ou plusieurs sacs mis dans un poêle", "orange")}
    ${opt("achat", "🛒", "Achat", "Des sacs ajoutés au stock", "bleu")}
    <div class="gtit gpetit" style="margin:12px 4px 4px">Entretien</div>
    ${opt("regulier", "🧹", "Entretien régulier", "Brasier, cendres…", "orange")}
    ${opt("vitre", "✨", "Nettoyage vitre", "Vitre propre", "bleu")}
    ${opt("annuel", "🛠️", "Entretien annuel", "Ramonage, visite du professionnel", "vert")}
    ${opt("annexe", "🧩", "Dépense annexe", "Brosse, joint, aspirateur…", "violet")}`, d => {
    d.querySelectorAll("[data-g]").forEach(b => b.addEventListener("click", () => {
      const g = b.dataset.g;
      if (g === "brulage") feuilleBrulage(); else if (g === "achat") feuilleAchat(); else feuilleEntretien(null, g);
    }));
  });
}
function feuilleReglages() {
  const r = R();
  const moisOpt = sel => MOIS_LONG.map((m, i) => `<option value="${i + 1}" ${i + 1 === sel ? "selected" : ""}>${m}</option>`).join("");
  const st = r.stockInitial || {};
  let villeChoisie = ville();
  ouvrirFeuille(`${tete("⚙︎", "Réglages des granulés", "bleu")}
    <div class="bloc"><h3>📅 Saison de chauffe</h3><div class="two">
      ${champ("Mois de début", `<select name="saisonDebut">${moisOpt(r.saisonDebut)}</select>`)}${champ("Mois de fin", `<select name="saisonFin">${moisOpt(r.saisonFin)}</select>`)}</div></div>
    <div class="bloc"><h3>📍 Ville des poêles (météo)</h3>
      <div class="gsacs"><input type="text" name="ville" value="${esc(villeChoisie.nom)}" autocapitalize="words"><button type="button" class="gpetitbtn" id="gVilleCherche">Chercher</button></div>
      <div id="gVilles"></div></div>
    <div class="bloc"><h3>📦 Stockage</h3><div class="two">
      ${champ("Capacité (sacs)", `<input type="number" name="capacite" min="1" value="${r.capacite}">`)}${champ("Poids d'un sac (kg)", `<input type="number" name="kgSac" min="1" step="0.5" value="${r.kgSac}">`)}</div>
      ${champ("Éteindre le poêle salon si le réservoir passe sous", `<select name="coupureReservoir">${[[0, "Jamais"], [5, "5 %"], [10, "10 %"], [15, "15 %"], [20, "20 %"]].map(([v, l]) => `<option value="${v}" ${(Number(r.coupureReservoir) || 0) === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
      ${champ("Réservoir du poêle salon (en sac)", `<select name="reservoir">${[[0.25, "¼ de sac"], [0.333, "⅓ de sac"], [0.5, "½ sac"], [1, "1 sac"]].map(([v, l]) => `<option value="${v}" ${Math.abs((Number(r.reservoir) || 0.5) - v) < .01 ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
      <div class="two">${champ("Jauge rouge sous (%)", `<input type="number" name="seuilRouge" min="0" max="100" value="${r.seuilRouge}">`)}${champ("Jauge orange sous (%)", `<input type="number" name="seuilOrange" min="0" max="100" value="${r.seuilOrange}">`)}</div></div>
    <div class="bloc"><h3>🏷️ Marques et stock initial</h3>
      <p class="hint">Stock initial : les sacs que tu avais avant de commencer à noter les achats.</p>
      ${marques().map(m => `<div class="gmarq gligne2"><span>${esc(m)}</span><input type="number" name="init:${esc(m)}" min="0" step="0.5" value="${st[m] || 0}" aria-label="Stock initial ${esc(m)}"></div>`).join("")}
      ${champ("Ajouter une marque", `<input type="text" name="nouvelle" placeholder="ex. Piveteau" autocapitalize="words">`)}</div>
    <div class="bloc"><h3>🧹 Fréquence des entretiens</h3><div class="two">
      ${champ("Entretien régulier (jours)", `<input type="number" name="regulier" min="1" value="${r.frequences.regulier}">`)}${champ("Vitre (jours)", `<input type="number" name="vitre" min="1" value="${r.frequences.vitre}">`)}</div></div>
    <button class="gvalider bleu" type="submit">Enregistrer</button>
    <button class="save" type="button" id="gExport">⬇️ Exporter mes données (CSV)</button>`, d => {
    d.querySelector("#gExport").addEventListener("click", exporter);
    const f = d.querySelector("form");
    d.querySelector("#gVilleCherche").addEventListener("click", async () => {
      const z = $("gVilles"); z.innerHTML = `<div class="sub gpetit">Recherche…</div>`;
      try {
        const j = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(f.ville.value.trim())}&count=5&language=fr&countryCode=FR`)).json();
        const res = j.results || [];
        z.innerHTML = res.length ? res.map((v, i) => `<button type="button" class="gmenu petit" data-v="${i}"><span>📍</span><div><b>${esc(v.name)}</b><small>${esc([v.admin2, v.admin1].filter(Boolean).join(", "))}</small></div></button>`).join("") : `<div class="sub gpetit">Aucune commune trouvée.</div>`;
        z.querySelectorAll("[data-v]").forEach(b => b.addEventListener("click", () => {
          const v = res[b.dataset.v]; villeChoisie = { nom: v.name, lat: Math.round(v.latitude * 1000) / 1000, lon: Math.round(v.longitude * 1000) / 1000 };
          f.ville.value = v.name; z.innerHTML = `<div class="sub gpetit">✓ ${esc(v.name)} sélectionnée</div>`;
        }));
      } catch { z.innerHTML = `<div class="sub gpetit err">Recherche impossible pour l'instant.</div>`; }
    });
    f.addEventListener("submit", async ev => {
      ev.preventDefault();
      const n = k => Number(f[k].value);
      const stockInitial = {};
      f.querySelectorAll('input[name^="init:"]').forEach(i => { if (Number(i.value)) stockInitial[i.name.slice(5)] = Number(i.value); });
      const ms = marques(); if (f.nouvelle.value.trim() && !ms.includes(f.nouvelle.value.trim())) ms.push(f.nouvelle.value.trim());
      const reglages = { saisonDebut: n("saisonDebut"), saisonFin: n("saisonFin"), capacite: n("capacite") || 90, kgSac: n("kgSac") || 15,
        seuilRouge: n("seuilRouge"), seuilOrange: n("seuilOrange"), marques: ms, stockInitial, ville: villeChoisie, reservoir: n("reservoir") || 0.5, coupureReservoir: n("coupureReservoir") || 0,
        frequences: { regulier: n("regulier") || 7, vitre: n("vitre") || 2 } };
      const b = f.querySelector(".gvalider"); b.disabled = true;
      try { await envoyer({ op: "reglages", reglages }); d.close(); toast("✓ Réglages enregistrés"); chargerMeteo().then(rendre); }
      catch (err) { toast(err.message); b.disabled = false; }
    });
  });
}
function exporter() {
  const l = ["ACHATS", "Date;Marque;Sacs;Prix par sac (EUR);Prix total (EUR);Lieu;Notes;Par"];
  D.achats.forEach(a => l.push([a.date, a.marque, a.sacs, a.prixSac ?? "", a.prixSac ? prixAchat(a).toFixed(2) : "", a.lieu, a.note, a.qui].join(";")));
  l.push("", "BRULAGES", "Date;Poele;Marque;Sacs;Notes;Par");
  D.brulages.forEach(b => l.push([b.date, nomPoele(b.poele), b.marque, b.sacs, b.note, b.qui].join(";")));
  l.push("", "ENTRETIENS", "Date;Poele;Type;Libelle;Cout (EUR);Notes;Par");
  D.entretiens.forEach(e => l.push([e.date, nomPoele(e.poele), TYPES_ENT[e.type], e.libelle, e.cout ?? "", e.note, e.qui].join(";")));
  const blob = new Blob(["﻿" + l.map(x => x.replace(/undefined|null/g, "")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `granules_${aujourdhui()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- Données ---------- */
function completer(d) {
  d = d || {};
  d.poeles = d.poeles && d.poeles.length ? d.poeles : [{ id: "salon", nom: "Poêle salon" }, { id: "cuisine", nom: "Poêle cuisine" }];
  d.reglages = { saisonDebut: 10, saisonFin: 4, capacite: 90, kgSac: 15, seuilRouge: 10, seuilOrange: 30, marques: [], stockInitial: {}, ville: VILLE_DEFAUT, ...(d.reglages || {}) };
  d.reglages.frequences = { regulier: 7, vitre: 2, ...(d.reglages.frequences || {}) };
  for (const l of ["achats", "brulages", "entretiens", "rdv"]) d[l] = (d[l] || []).slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return d;
}
async function envoyer(corps) {
  if (!cfg.relais) throw new Error("Nécessite le relais Cloudflare (Paramètres avancés)");
  if (ecriture) throw new Error("Un enregistrement est déjà en cours");
  ecriture = true;
  try { const j = await relais("/granules", { ...corps, qui: cfg.qui || "" }); D = completer(j.donnees); rendre(); }
  finally { ecriture = false; }
}
async function charger() {
  try {
    const [g, c, rv] = await Promise.all([
      gh(`/contents/granules.json?t=${Date.now()}`, { raw: true }).then(JSON.parse).catch(e => { if (e.notFound) return null; throw e; }),
      gh(`/contents/chauffes.json?ref=etat&t=${Date.now()}`, { raw: true }).then(JSON.parse).catch(() => null),
      gh(`/contents/reservoir.json?ref=etat&t=${Date.now()}`, { raw: true }).then(JSON.parse).catch(() => null),
    ]);
    D = completer(g); chauffes = c; reservoir = rv; rendre(); window.dispatchEvent(new Event("reservoir"));
    chargerMeteo().then(() => rendre());
  } catch (e) { $("vueGranules").innerHTML = `<section class="gcarte"><div class="sub err">${esc(e.message)}</div></section>`; }
}

/* ---------- Événements ---------- */
$("vueGranules").addEventListener("change", ev => {
  if (ev.target.id === "gGraphe") { etat.graphe = ev.target.value; store.set("g.graphe", etat.graphe); rendreBloc("graphe"); }
  if (ev.target.id === "gSaisonStats") { etat.saisonStats = Number(ev.target.value); rendre(); }
});
$("vueGranules").addEventListener("click", ev => {
  const z = ev.target.closest("[data-gtap]");
  if (z) {
    const [cle, i] = z.dataset.gtap.split(":"), el = $(`info-${cle}`);
    if (el && infos[cle]) { el.innerHTML = infos[cle][i] || ""; el.classList.toggle("vide", !infos[cle][i]); }
    return;
  }
  const t = ev.target.closest("button, [data-gedit], summary"); if (!t) return;
  const ds = t.dataset;
  if (ds.gpoele) { etat.poele = ds.gpoele; store.set("g.poele", ds.gpoele); return rendre(); }
  if (ds.gportee) { etat.portee = ds.gportee; store.set("g.portee", ds.gportee); return rendre(); }
  if (ds.ghisto) { etat.filtreHisto = ds.ghisto; return rendre(); }
  if (ds.gentp) { etat.entPoele = ds.gentp; store.set("g.entPoele", ds.gentp); return rendre(); }
  if (ds.gstatmois) { etat.statMois = ds.gstatmois; return rendreBloc("mois"); }
  if (ds.gstatsaison) { etat.statSaison = ds.gstatsaison; return rendreBloc("saisons"); }
  if (ds.gmeteo) { etat.meteoGraphe = !etat.meteoGraphe; store.set("g.meteoGraphe", etat.meteoGraphe ? "oui" : "non"); return rendreBloc("mois"); }
  if (ds.gheat) { etat.heatMode = ds.gheat; store.set("g.heat", ds.gheat); return rendreBloc("intensite"); }
  if (ds.gmarqueprix) { etat.marquePrix = ds.gmarqueprix; return rendreBloc("prix"); }
  if (ds.gdetail) return detail(ds.gdetail);
  if (ds.gagrandir) return ouvrirGrand();
  if (ds.gremplir) return remplirReservoir();
  if (ds.gresmaj) return actualiserReservoir();
  if (ds.gresoubli) return feuilleRemplissages();
  if (ds.gresdetail) return detailReservoir();
  if (t.id === "gPlus") return basculerRadial(!radial.classList.contains("ouvert"));
  if (t.id === "gReglages") return feuilleReglages();
  if (ds.gcase) {
    const [mi, ti] = ds.gcase.split("-").map(Number);
    $("vueGranules").querySelectorAll(".gh-c.sel").forEach(x => x.classList.remove("sel")); t.classList.add("sel");
    $("info-cases").innerHTML = infos.cases[mi][ti]; return;
  }
  if (ds.gact) {
    const [a, x, y] = ds.gact.split(":");
    if (a === "fait") return feuilleEntretien(null, x, y);
    if (a === "annexe") return feuilleEntretien(null, "annexe", x);
    if (a === "annuel-menu") return menuAnnuel(x);
  }
  if (ds.gedit) {
    const [liste, id] = ds.gedit.split(":"), e = D[liste].find(x => x.id === id); if (!e) return;
    if (liste === "achats") return feuilleAchat(e);
    if (liste === "brulages") return feuilleBrulage(e);
    if (liste === "rdv") return feuilleRdv(e.poele);
    return feuilleEntretien(e);
  }
});
$("vueGranules").addEventListener("toggle", ev => {
  const k = ev.target.dataset && ev.target.dataset.gmois; if (!k) return;
  if (ev.target.open) { etat.ouverts.add(k); etat.ouverts.delete("!" + k); } else { etat.ouverts.delete(k); etat.ouverts.add("!" + k); }
}, true);

/* Changement d'onglet en faisant glisser l'écran vers la gauche ou la droite */
const ORDRE = ["tableau", "historique", "stats", "entretiens"];
let toucheX = null, toucheY = null;
$("vueGranules").addEventListener("touchstart", e => {
  if (e.touches.length !== 1 || e.target.closest("select, input, .gzone, .gheat")) { toucheX = null; return; }
  toucheX = e.touches[0].clientX; toucheY = e.touches[0].clientY;
}, { passive: true });
$("vueGranules").addEventListener("touchend", e => {
  if (toucheX === null) return;
  const dx = e.changedTouches[0].clientX - toucheX, dy = e.changedTouches[0].clientY - toucheY;
  toucheX = null;
  if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
  const i = ORDRE.indexOf(etat.vue) + (dx < 0 ? 1 : -1);
  if (i < 0 || i >= ORDRE.length || typeof montrerVue !== "function") return;
  etat.sens = dx < 0 ? "gauche" : "droite";
  montrerVue(ORDRE[i]);
}, { passive: true });
function vue(v) {
  etat.vue = v; store.set("g.vue", v); rendre();
  const z = $("vueGranules");
  if (etat.sens) { z.classList.remove("gentre-gauche", "gentre-droite"); void z.offsetWidth; z.classList.add(`gentre-${etat.sens}`); etat.sens = null; }
}
window.granules = { charger, rendre, vue, vueActive: () => etat.vue, estCharge: () => !!D, htmlReservoir, remplirReservoir, actualiserReservoir, feuilleRemplissages, detailReservoir };
document.addEventListener("visibilitychange", () => { if (!document.hidden && cfg.token && !$("vueGranules").hidden && !ecriture) charger(); });
if (cfg.token) { if (!$("vueGranules").hidden) rendre(); charger(); }   // chargé dès le départ : la jauge du réservoir s'affiche aussi sur l'écran Poêle
})();
