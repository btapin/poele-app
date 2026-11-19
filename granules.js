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

let D = null, chauffes = null, meteo = null;
let ecriture = false;
const infos = {};            // textes affichés au toucher d'une barre / d'un point
const etat = {
  vue: ["tableau", "historique", "stats", "entretiens"].includes(store.get("poele.vue")) ? store.get("poele.vue") : "tableau",
  poele: store.get("g.poele") || "tous",
  portee: store.get("g.portee") || "saison",
  graphe: store.get("g.graphe") || "7j", moyenne: "7j", filtreHisto: "tous", saisonStats: null, ouverts: new Set(),
  entPoele: store.get("g.entPoele") || "salon", statSaison: "brules", statMois: "sacs",
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
  return { parSac: sacs ? min / 60 / sacs : null, parMarque, depuis: debutJournal };
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
      fetch(`https://api.open-meteo.com/v1/forecast?${base}&past_days=14&forecast_days=1&current=temperature_2m`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    const jours = { ...((cache && cache.cle === cle && cache.jours) || {}) };
    for (const src of [arch, prev]) {
      if (!src || !src.daily) continue;
      src.daily.time.forEach((t, i) => { const x = src.daily.temperature_2m_mean[i]; if (x !== null && x !== undefined) jours[t] = Math.round(x * 10) / 10; });
    }
    if (!Object.keys(jours).length) return;
    meteo = { cle, jour: auj, le: Date.now(), jours, actuelle: prev && prev.current ? prev.current.temperature_2m : (cache && cache.actuelle) };
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

/* ---------- Graphiques (SVG faits main, sans double axe) ---------- */
function barres(cols, { cle, hauteur = 130, couleurs = COULEUR, cles = null, etiquettes = true, unite = "" } = {}) {
  const W = 320, H = hauteur, bas = 18, haut = 14;
  const k = cles || Object.keys(couleurs);
  const tot = c => k.reduce((x, kk) => x + (c.valeurs[kk] || 0), 0);
  const avecFantome = cols.some(c => c.fantome !== undefined);
  const max = Math.max(1, ...cols.map(tot), ...cols.map(c => c.fantome || 0));
  const pas = W / cols.length;
  const larg = avecFantome ? Math.min(15, pas * .34) : Math.min(26, pas * .62);
  const y0 = H - bas, echelle = v => (v / max) * (H - bas - haut);
  if (cle) infos[cle] = cols.map(c => c.info || "");
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="gsvg">`;
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
    if (cle) svg += `<rect x="${i * pas}" y="0" width="${pas}" height="${H}" fill="transparent" data-gtap="${cle}:${i}" class="gzone"/>`;
  });
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
  h += `<section class="gcarte orangee"><div class="gligne2">${ic("🔥", "orange")}<select class="gselect" id="gGraphe">${choix.map(([id, l]) => `<option value="${id}" ${etat.graphe === id ? "selected" : ""}>${l}</option>`).join("")}</select>
      <span class="gbadge orange">${sacsTxt(totalGraphe)}</span></div>
      ${barres(cols, { cle: "tab", cles: clesPoeles(), etiquettes: !["30j", "mois"].includes(etat.graphe) })}${legende(legendePoeles())}
      ${avecChauffe() ? panneauHeures(periodes, { cle: "tabh", etiquettes: !["30j", "mois"].includes(etat.graphe) }) : ""}</section>`;
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
    const pm = prixMoyenGlobal(), cout = pm ? somme(brul) * pm : null;
    ico = "🔥"; titre = "Détail des brûlages"; teinte = "orange";
    corps = `<div class="gbloc">${ligne("🔥 Brûlés", `<b>${sacsTxt(somme(brul))}</b>`)}${ligne("⚖️ Poids", kg(somme(brul)))}${ligne("💶 Coût estimé", `<b class="vert">${cout !== null ? euros(cout) : "--"}</b>`)}</div>
      ${etat.poele === "tous" ? `<div class="gbloc"><div class="gtit">Par poêle</div>${D.poeles.map(p => ligne(`<i class="gpt" style="background:${COULEUR[p.id]}"></i>${esc(courtPoele(p.id))}`, sacsTxt(somme(brul.filter(b => b.poele === p.id))))).join("")}</div>` : ""}
      <div class="gbloc"><div class="gtit">Par marque</div>${parMarque(brul).map(([m, n]) => ligne(`🏷️ ${esc(m)}`, `${sacsTxt(n)} (${kg(n)})`)).join("") || '<div class="sub">--</div>'}</div>
      <div class="sub gpetit">Coût estimé avec le prix moyen payé (${pm ? euros(pm) : "--"} / sac). Période : ${libellePortee()}.</div>`;
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
  const mois = moisSaison(sel);
  const premierMois = (a, m) => `${a}-${pad(m)}`;
  let h = `<div class="gpilule"><span>📅</span><select id="gSaisonStats">${saisons.slice().reverse().map(a => `<option value="${a}" ${a === sel ? "selected" : ""}>Saison ${a === saisonCourante() ? "courante" : nomSaison(a)} : ${MOIS[R().saisonDebut - 1]} ${a} - ${MOIS[R().saisonFin - 1]} ${a + 1}</option>`).join("")}</select></div>`;

  // 1. Mois par mois, comparé à la saison précédente, avec la température
  const sacs = etat.statMois === "sacs";
  const cols = mois.map(({ a, m }) => {
    const k = premierMois(a, m), kp = premierMois(a - 1, m);
    const l = brS.filter(b => b.date.startsWith(k)), lp = D.brulages.filter(b => b.date.startsWith(kp) && dePoele(b));
    const ac = acS.filter(x => x.date.startsWith(k)), acp = D.achats.filter(x => x.date.startsWith(kp));
    const t = tempMois(a, m), tp = tempMois(a - 1, m);
    return sacs
      ? { lab: MOIS_COURT[m - 1], valeurs: valeursPoeles(l), fantome: somme(lp),
          info: `<b>${MOIS_LONG[m - 1]}</b><br>${nomSaison(sel)} : ${sacsTxt(somme(l))}${t !== null ? ` (${temp(t)})` : ""}${avecChauffe() && `${k}-31` >= debutJournal() ? ` · ⏱️ ${duree(minutesChauffe(`${k}-01`, `${k}-31`))} de chauffe` : ""}<br>${nomSaison(prec)} : ${sacsTxt(somme(lp))}${tp !== null ? ` (${temp(tp)})` : ""}` }
      : { lab: MOIS_COURT[m - 1], valeurs: { e: Math.round(somme(ac, prixAchat)) }, fantome: Math.round(somme(acp, prixAchat)),
          info: `<b>${MOIS_LONG[m - 1]}</b><br>${nomSaison(sel)} : ${euros(somme(ac, prixAchat))}<br>${nomSaison(prec)} : ${euros(somme(acp, prixAchat))}` };
  });
  h += `<section class="gcarte">
    <div class="gseg">${[["sacs", "🔥 Sacs brûlés"], ["euros", "€ Dépenses"]].map(([id, l]) => `<button data-gstatmois="${id}" class="${etat.statMois === id ? "sel" + (id === "euros" ? " bleu" : "") : ""}">${l}</button>`).join("")}</div>
    ${legende([pastille(C_PASSE, nomSaison(prec)), ...(sacs ? (cles.length > 1 ? cles.map(k => pastille(COULEUR[k], `${nomSaison(sel)} · ${courtPoele(k)}`)) : [pastille(COULEUR[cles[0]], nomSaison(sel))]) : [pastille(C_EUROS, nomSaison(sel))])])}
    ${barres(cols, { cle: "mois", cles: sacs ? cles : ["e"], couleurs: sacs ? COULEUR : { e: C_EUROS }, unite: sacs ? "" : "€" })}
    <div class="gtit gpetit" style="margin-top:6px">🌡️ Température moyenne à ${esc(ville().nom)}</div>
    ${courbes([{ pts: mois.map(({ a, m }) => tempMois(a - 1, m)), couleur: "#8a8fa8", tirets: true }, { pts: mois.map(({ a, m }) => tempMois(a, m)), couleur: C_TEMP }], mois.length, { cle: "mois" })}
    ${legende([pastille("#8a8fa8", nomSaison(prec), true), pastille(C_TEMP, nomSaison(sel))])}
    ${avecChauffe() ? panneauHeures(mois.map(({ a, m }) => [`${a}-${pad(m)}-01`, `${a}-${pad(m)}-${pad(new Date(a, m, 0).getDate())}`, MOIS_COURT[m - 1], false]), { cle: "moish" }) : ""}
    <div class="sub gpetit gcentre">Touche un mois pour comparer.</div></section>`;

  // 2. Saisons
  const toutes = []; for (let a = saisonCourante() - 5; a <= saisonCourante(); a++) toutes.push(a);
  const brules = etat.statSaison === "brules";
  h += `<section class="gcarte"><div class="gseg">${[["brules", "🔥 Sacs brûlés"], ["achetes", "🛍️ Sacs achetés"]].map(([id, l]) => `<button data-gstatsaison="${id}" class="${etat.statSaison === id ? "sel" + (id === "achetes" ? " bleu" : "") : ""}">${l}</button>`).join("")}</div>
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

  // 4. Intensité hebdomadaire
  const tranches = [[1, 7], [8, 14], [15, 21], [22, 31]];
  const cases = mois.map(({ a, m }) => tranches.map(([d1, d2]) => {
    const fin = Math.min(d2, new Date(a, m, 0).getDate());
    const l = brS.filter(b => { const d = date(b.date); return d.getFullYear() === a && d.getMonth() + 1 === m && d.getDate() >= d1 && d.getDate() <= fin; });
    return { a, m, d1, fin, sacs: somme(l), l };
  }));
  const maxCase = Math.max(1, ...cases.flat().map(c => c.sacs));
  infos.cases = cases.map(col => col.map(c => `<b>Du ${c.d1} au ${c.fin} ${MOIS_LONG[c.m - 1].toLowerCase()} ${c.a}</b> : ${sacsTxt(c.sacs)} · ${nb(c.sacs * R().kgSac, 0)} kg${tempMoyenne(`${c.a}-${pad(c.m)}-${pad(c.d1)}`, `${c.a}-${pad(c.m)}-${pad(c.fin)}`) !== null ? ` · ${temp(tempMoyenne(`${c.a}-${pad(c.m)}-${pad(c.d1)}`, `${c.a}-${pad(c.m)}-${pad(c.fin)}`))}` : ""}`
    + (avecChauffe() && `${c.a}-${pad(c.m)}-${pad(c.fin)}` >= debutJournal() ? ` · ⏱️ ${duree(minutesChauffe(`${c.a}-${pad(c.m)}-${pad(c.d1)}`, `${c.a}-${pad(c.m)}-${pad(c.fin)}`))} de chauffe` : "")
    + (c.l.length ? "<br>" + c.l.map(b => `${dateCourte(b.date)} · ${esc(courtPoele(b.poele))} · ${esc(b.marque)} : ${nb(b.sacs)}`).join("<br>") : "")));
  h += `<section class="gcarte"><div class="gtete">${ic("📊", "orange")}<div><b>Intensité de consommation</b><div class="gpetit">Suivi hebdomadaire de la saison</div></div>
    <div class="gechelle">Moins${[0, .25, .5, .75, 1].map(x => `<i style="background:${x ? `rgba(224,99,26,${(.25 + .75 * x).toFixed(2)})` : "var(--gcase)"}"></i>`).join("")}Plus</div></div>
    <div class="gheat" style="grid-template-columns:repeat(${mois.length},1fr)">
    ${mois.map(({ a, m }) => `<div class="gh-t">${MOIS_COURT[m - 1]} '${String(a).slice(2)}</div>`).join("")}
    ${tranches.map((_, ti) => cases.map((col, mi) => {
      const c = col[ti], alpha = c.sacs ? .25 + .75 * c.sacs / maxCase : 0;
      return `<button class="gh-c${c.sacs ? " plein" : ""}" data-gcase="${mi}-${ti}" style="${c.sacs ? `background:rgba(224,99,26,${alpha.toFixed(2)})` : ""}">${c.d1}-${c.fin}</button>`;
    }).join("")).join("")}</div><div class="ginfo" id="info-cases"></div></section>`;

  // 5. Fin du stock
  if (sel === sc) {
    const stock = stockTotal(), conso = consoMoyenne(), jours = conso > 0 ? Math.floor(stock / conso) : null;
    h += `<section class="gcarte"><div class="gtete">${ic("⏳", "orange")}<div><b>Prédiction de fin de stock</b><div class="gpetit">Projection de votre réserve de sacs</div></div></div>
      <div class="gtuiles trois"><div class="gmini"><span>Stock actuel</span><b>${nb(stock)} sacs</b><small>${nb(stock * R().kgSac, 0)} kg</small></div>
      <div class="gmini accent"><span>Autonomie</span><b>${jours ?? "--"} jours</b><small>${jours !== null ? `Fin : ${dateLongue(ajouterJours(auj, jours))}` : ""}</small></div>
      <div class="gmini"><span>Conso moyenne</span><b>${nb(conso, 2)} sac/j</b><small>${nb(conso * R().kgSac)} kg/j</small></div></div>
      ${jours !== null ? projection(stock, conso, jours) : ""}</section>`;
  }

  // 6. Prix moyen par saison + évolution
  if (D.achats.length) {
    const ms = [...new Set(D.achats.map(a => a.marque))];
    const marquePrix = ms.includes(etat.marquePrix) ? etat.marquePrix : "tous";
    const ach = D.achats.filter(a => marquePrix === "tous" || a.marque === marquePrix);
    h += `<section class="gcarte"><div class="gtete">${ic("🏷️", "bleu")}<div><b>Prix moyen du sac par saison</b></div></div>
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
    const pct = depuis === null ? 100 : Math.min(100, depuis / freq * 100);
    const teinte = t === "vitre" ? "bleu" : "orange";
    h += `<button class="gcarte gent ${teinte}" data-gact="fait:${t}:${p}"><div class="gligne2"><div class="gtete">${ic(ICONE_ENT[t], teinte)}<b>${TYPES_ENT[t]}</b></div>
      <span class="gbadge ${aJour ? "vert" : "orange"}">${aJour ? (t === "vitre" ? "Propre" : "À jour") : "À faire"}</span></div>
      <div class="gligne2" style="margin-top:10px"><div class="gtete"><span class="ganneau" style="--p:${pct}"></span><b>${depuis ?? "--"}</b><span class="gpetit">/ ${freq} jours</span></div>
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
function poeleParDefaut() { return etat.poele !== "tous" ? etat.poele : store.get("g.dernierPoele") || "salon"; }
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
  const modif = !!e; e = e || { date: aujourdhui(), type, poele: poele || poeleParDefaut(), note: "", cout: null, libelle: "" };
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
        seuilRouge: n("seuilRouge"), seuilOrange: n("seuilOrange"), marques: ms, stockInitial, ville: villeChoisie,
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
    const [g, c] = await Promise.all([
      gh(`/contents/granules.json?t=${Date.now()}`, { raw: true }).then(JSON.parse).catch(e => { if (e.notFound) return null; throw e; }),
      gh(`/contents/chauffes.json?ref=etat&t=${Date.now()}`, { raw: true }).then(JSON.parse).catch(() => null),
    ]);
    D = completer(g); chauffes = c; rendre();
    chargerMeteo().then(() => rendre());
  } catch (e) { $("vueGranules").innerHTML = `<section class="gcarte"><div class="sub err">${esc(e.message)}</div></section>`; }
}

/* ---------- Événements ---------- */
$("vueGranules").addEventListener("change", ev => {
  if (ev.target.id === "gGraphe") { etat.graphe = ev.target.value; store.set("g.graphe", etat.graphe); rendre(); }
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
  if (ds.gstatmois) { etat.statMois = ds.gstatmois; return rendre(); }
  if (ds.gstatsaison) { etat.statSaison = ds.gstatsaison; return rendre(); }
  if (ds.gmarqueprix) { etat.marquePrix = ds.gmarqueprix; return rendre(); }
  if (ds.gdetail) return detail(ds.gdetail);
  if (t.id === "gPlus") return feuilleAjout();
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

function vue(v) { etat.vue = v; store.set("g.vue", v); rendre(); }
window.granules = { charger, rendre, vue, vueActive: () => etat.vue, estCharge: () => !!D };
document.addEventListener("visibilitychange", () => { if (!document.hidden && cfg.token && !$("vueGranules").hidden && !ecriture) charger(); });
if (cfg.token && !$("vueGranules").hidden) { rendre(); charger(); }
})();
