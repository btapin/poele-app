/* ============================================================
   Granulés : stock, achats, sacs brûlés, entretiens, statistiques
   Données : granules.json (branche principale du dépôt), écrit par le relais Cloudflare.
   Utilise les fonctions de l'appli : $, gh, relais, toast, esc, cfg, store.
   ============================================================ */
(() => {
const C_SALON = "#e0631a", C_CUISINE = "#4a98e0", C_EUROS = "#8f7fd6";
const COULEUR = { salon: C_SALON, cuisine: C_CUISINE };
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MOIS_LONG = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const JOURS = ["Dim.", "Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam."];
const TYPES_ENT = { annuel: "Entretien annuel", regulier: "Entretien régulier", vitre: "Nettoyage vitre", annexe: "Dépense annexe" };
const ICONE_ENT = { annuel: "🛠️", regulier: "🧹", vitre: "✨", annexe: "🧩" };

let D = null;               // données granules.json
let chauffes = null;        // journal des chauffes du poêle salon (chauffes.json)
let charge = false, ecriture = false;
const etat = {
  vue: store.get("g.vue") || "tableau",          // tableau | historique | stats | entretiens
  poele: store.get("g.poele") || "tous",         // tous | salon | cuisine
  portee: store.get("g.portee") || "saison",     // saison | toujours
  graphe: "7j", moyenne: "7j", filtreHisto: "tous", saisonStats: null, ouverts: new Set(),
  entPoele: store.get("g.entPoele") || "salon",
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

/* Saisons : une saison « 2026/27 » va du mois de début (ex. octobre 2026) au mois de fin (ex. avril 2027).
   Les mois creux sont partagés entre la saison qui finit et celle qui commence. */
function anneeSaison(s) {
  const d = date(s), m = d.getMonth() + 1, deb = R().saisonDebut, fin = R().saisonFin;
  if (deb <= fin) return d.getFullYear();
  const creux = deb - fin - 1, coupure = fin + Math.floor(creux / 2) + 1;   // premier mois rattaché à la saison suivante
  return m >= coupure ? d.getFullYear() : d.getFullYear() - 1;
}
const nomSaison = a => R().saisonDebut <= R().saisonFin ? String(a) : `${a}/${String(a + 1).slice(2)}`;
function moisSaison(a) {             // [{a, m}] du mois de début au mois de fin
  const out = []; let y = a, m = R().saisonDebut;
  for (let i = 0; i < 12; i++) { out.push({ a: y, m }); if (m === R().saisonFin) break; m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const saisonCourante = () => anneeSaison(aujourdhui());
const dansPortee = e => etat.portee === "toujours" || anneeSaison(e.date) === saisonCourante();
const dePoele = (e, p = etat.poele) => p === "tous" || e.poele === p;

/* ---------- Calculs ---------- */
function stockParMarque() {
  const s = {};
  for (const [m, n] of Object.entries(R().stockInitial || {})) s[m] = (s[m] || 0) + Number(n || 0);
  for (const a of D.achats) s[a.marque] = (s[a.marque] || 0) + a.sacs;
  for (const b of D.brulages) s[b.marque] = (s[b.marque] || 0) - b.sacs;
  return s;
}
const stockTotal = () => Object.values(stockParMarque()).reduce((x, y) => x + y, 0);
const somme = (l, f = e => e.sacs) => l.reduce((x, e) => x + (f(e) || 0), 0);
const prixAchat = a => (a.prixSac || 0) * a.sacs;

/** Consommation moyenne (sacs/jour) des deux poêles, pour estimer l'autonomie */
function consoMoyenne() {
  const auj = aujourdhui(), sc = saisonCourante();
  const saison = D.brulages.filter(b => anneeSaison(b.date) === sc);
  if (saison.length) {
    const debut = saison[0].date, jours = Math.max(7, ecartJours(debut, auj) + 1);
    return somme(saison) / jours;
  }
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
  const jours = ecartJours(debut, auj) + 1;
  return { kg: somme(l) * R().kgSac / jours, jours, sacs: somme(l) };
}
/** Heures de chauffe couvertes par chaque sac brûlé au salon (d'après le journal des chauffes) */
function rendementSalon() {
  const liste = (chauffes && chauffes.liste) || [];
  if (!liste.length) return { parSac: null, parMarque: {}, depuis: null };
  const debutJournal = liste.reduce((m, c) => c.debut < m ? c.debut : m, liste[0].debut).slice(0, 10);
  const brul = D.brulages.filter(b => b.poele === "salon").sort((a, b) => a.date < b.date ? -1 : 1);
  const minutesEntre = (a, b) => liste.filter(c => { const j = c.debut.slice(0, 10); return j > a && j <= b; })
    .reduce((x, c) => x + (c.minutes || 0), 0);
  const parMarque = {}; let min = 0, sacs = 0;
  for (let i = 1; i < brul.length; i++) {
    if (brul[i - 1].date < debutJournal) continue;      // période pas entièrement couverte par le journal
    const m = minutesEntre(brul[i - 1].date, brul[i].date);
    const pm = parMarque[brul[i].marque] = parMarque[brul[i].marque] || { min: 0, sacs: 0 };
    pm.min += m; pm.sacs += brul[i].sacs; min += m; sacs += brul[i].sacs;
  }
  return { parSac: sacs ? min / 60 / sacs : null, parMarque, depuis: debutJournal };
}

/* ---------- Graphiques (SVG faits main) ---------- */
/** Barres empilées par poêle. cols : [{lab, valeurs: {salon, cuisine}, titre}] */
function barres(cols, { hauteur = 120, unite = "sacs", couleurs = COULEUR, cles = null, valeurEtiquette = true } = {}) {
  const W = 320, H = hauteur, bas = 18, haut = 14;
  const k = cles || Object.keys(couleurs);
  const tot = c => k.reduce((x, kk) => x + (c.valeurs[kk] || 0), 0);
  const max = Math.max(1, ...cols.map(tot));
  const pas = W / cols.length, larg = Math.min(26, pas * .62);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="gsvg" role="img">`;
  svg += `<line x1="0" x2="${W}" y1="${H - bas + .5}" y2="${H - bas + .5}" stroke="var(--line)"/>`;
  cols.forEach((c, i) => {
    const x = i * pas + (pas - larg) / 2; let y = H - bas;
    const t = tot(c);
    const titre = esc(c.titre || `${c.lab} : ${nb(t)} ${unite}`);
    svg += `<g><title>${titre}</title><rect x="${i * pas}" y="0" width="${pas}" height="${H}" fill="transparent"/>`;
    k.forEach((kk, j) => {
      const v = c.valeurs[kk] || 0; if (!v) return;
      const h = Math.max(2, (v / max) * (H - bas - haut));
      const dernier = !k.slice(j + 1).some(z => c.valeurs[z]);
      y -= h;
      svg += `<rect x="${x}" y="${y}" width="${larg}" height="${dernier ? h : h - 2}" rx="${dernier ? 4 : 1}" fill="${couleurs[kk]}"/>`;
    });
    if (t && valeurEtiquette) svg += `<text x="${x + larg / 2}" y="${y - 3}" class="gval">${nb(t)}</text>`;
    svg += `<text x="${i * pas + pas / 2}" y="${H - 4}" class="glab${c.fort ? " fort" : ""}">${esc(c.lab)}</text></g>`;
  });
  return svg + "</svg>";
}
function legende(cles) {
  if (cles.length < 2) return "";
  return `<div class="gleg">${cles.map(k => `<span><i style="background:${COULEUR[k]}"></i>${esc(courtPoele(k))}</span>`).join("")}</div>`;
}
const clesPoeles = () => etat.poele === "tous" ? D.poeles.map(p => p.id) : [etat.poele];
function valeursPoeles(liste) {
  const v = {}; for (const b of liste) v[b.poele] = (v[b.poele] || 0) + b.sacs; return v;
}

/* ---------- Rendu ---------- */
function rendre() {
  const z = $("vueGranules");
  if (!D) { z.innerHTML = `<section class="card"><div class="sub">${charge ? "Chargement…" : "Chargement des granulés…"}</div></section>`; return; }
  const onglets = [["tableau", "Tableau"], ["historique", "Historique"], ["stats", "Stats"], ["entretiens", "Entretiens"]];
  let h = `<div class="gfiltres">
    <div class="gchips">${[["tous", "Les deux"], ...D.poeles.map(p => [p.id, courtPoele(p.id)])].map(([id, l]) =>
      `<button data-gpoele="${id}" class="${etat.poele === id ? "sel" : ""}">${id !== "tous" ? `<i style="background:${COULEUR[id]}"></i>` : ""}${esc(l)}</button>`).join("")}</div>
    <button class="icon-btn petit" id="gReglages" aria-label="Réglages des granulés">🎚️</button>
  </div>
  <div class="onglets gonglets">${onglets.map(([id, l]) => `<button data-gvue="${id}" class="${etat.vue === id ? "sel" : ""}">${l}</button>`).join("")}</div>`;
  h += { tableau: vueTableau, historique: vueHistorique, stats: vueStats, entretiens: vueEntretiens }[etat.vue]();
  z.innerHTML = h;
}

function vueTableau() {
  const stock = stockTotal(), cap = R().capacite || 90, pct = Math.max(0, Math.min(100, stock / cap * 100));
  const niveau = pct < R().seuilRouge ? "rouge" : pct < R().seuilOrange ? "orange" : "ok";
  const conso = consoMoyenne(), jours = conso > 0 ? Math.floor(stock / conso) : null;
  const fin = jours !== null ? ajouterJours(aujourdhui(), jours) : null;
  const achats = D.achats.filter(dansPortee), brul = D.brulages.filter(e => dansPortee(e) && dePoele(e));
  const moy = moyenneKgJour(etat.moyenne);
  const libMoy = { "7j": "7 jours", mois: "mois", saison: "saison" }[etat.moyenne];
  let h = `<div class="onglets gportee">
      <button data-gportee="saison" class="${etat.portee === "saison" ? "sel" : ""}">Saison ${nomSaison(saisonCourante())}</button>
      <button data-gportee="toujours" class="${etat.portee === "toujours" ? "sel" : ""}">Depuis toujours</button></div>
    <section class="card gstock ${niveau}">
      <div class="row"><div><div class="sub">Stock</div><div class="gbig">${nb(stock)}<small> sacs</small></div></div>
      <div style="text-align:right"><div class="sub">Autonomie estimée</div>
        <div class="gfin">${fin ? `${dateLongue(fin)} <span class="gbadge">${jours} j</span>` : "--"}</div></div></div>
      <div class="gjauge"><span style="width:${pct}%"></span></div>
      <div class="row sub" style="font-size:12px"><span>${Math.round(pct)} % rempli</span><span>Capacité : ${cap} sacs</span></div>
    </section>
    <div class="gtuiles">
      <div class="gtuile"><div class="sub">🛒 Achetés</div><b>${nb(somme(achats))}</b> <small>sacs</small></div>
      <div class="gtuile"><div class="sub">🔥 Brûlés${etat.poele !== "tous" ? ` · ${esc(courtPoele(etat.poele))}` : ""}</div><b>${nb(somme(brul))}</b> <small>sacs</small></div>
      <div class="gtuile"><div class="sub">💶 Dépenses</div><b>${euros(somme(achats, prixAchat))}</b></div>
      <button class="gtuile" id="gMoy"><div class="sub">📈 Moyenne ${libMoy} ↻</div><b>${nb(moy.kg)}</b> <small>kg/j</small></button>`;
  if (etat.poele !== "cuisine") {
    const r = rendementSalon();
    h += `<div class="gtuile large"><div class="sub">⏱️ Chauffe par sac · Salon</div>${r.parSac
      ? `<b>${nb(r.parSac)}</b> <small>h de chauffe par sac</small>`
      : `<small>Calculé à partir des temps de chauffe : il faut au moins deux sacs déclarés au salon depuis le ${r.depuis ? dateCourte(r.depuis) : "début du journal"}.</small>`}</div>`;
  }
  h += `</div>`;
  // graphe
  const choix = [["7j", "7 jours"], ["30j", "30 jours"], ["saison", "Saison"]];
  let cols = [];
  const auj = aujourdhui(), brAll = D.brulages.filter(e => dePoele(e));
  if (etat.graphe === "7j" || etat.graphe === "30j") {
    const n = etat.graphe === "7j" ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const j = ajouterJours(auj, -i), d = date(j);
      const l = brAll.filter(b => b.date === j);
      cols.push({ lab: n === 7 ? JOURS[d.getDay()] : (i % 5 === 0 ? dateCourte(j) : ""), valeurs: valeursPoeles(l), fort: i === 0,
        titre: `${dateLongue(j)} : ${sacsTxt(somme(l))}` });
    }
  } else {
    cols = moisSaison(saisonCourante()).map(({ a, m }) => {
      const l = brAll.filter(b => b.date.startsWith(`${a}-${pad(m)}`));
      return { lab: MOIS[m - 1], valeurs: valeursPoeles(l), titre: `${MOIS_LONG[m - 1]} ${a} : ${sacsTxt(somme(l))}` };
    });
  }
  const totalGraphe = cols.reduce((x, c) => x + Object.values(c.valeurs).reduce((a, b) => a + b, 0), 0);
  h += `<section class="card"><div class="row"><div class="gchips petit">${choix.map(([id, l]) => `<button data-ggraphe="${id}" class="${etat.graphe === id ? "sel" : ""}">${l}</button>`).join("")}</div>
      <span class="gbadge">${sacsTxt(totalGraphe)}</span></div>
      ${barres(cols, { cles: clesPoeles(), valeurEtiquette: etat.graphe !== "30j" })}${legende(clesPoeles())}</section>
    <button class="gfab" id="gPlus" aria-label="Ajouter">＋</button>`;
  return h;
}

/* ---------- Historique ---------- */
function vueHistorique() {
  const f = etat.filtreHisto;
  const items = [];
  if (f === "tous" || f === "achat") D.achats.forEach(e => items.push({ l: "achats", e }));
  if (f === "tous" || f === "brulage") D.brulages.filter(e => dePoele(e)).forEach(e => items.push({ l: "brulages", e }));
  if (f === "tous" || f === "entretien") D.entretiens.filter(e => dePoele(e)).forEach(e => items.push({ l: "entretiens", e }));
  items.sort((a, b) => a.e.date < b.e.date ? 1 : a.e.date > b.e.date ? -1 : (b.e.cree || "").localeCompare(a.e.cree || ""));
  const groupes = new Map();
  for (const it of items) { const k = it.e.date.slice(0, 7); if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(it); }
  let h = `<div class="gchips petit gfiltreh">${[["tous", "Tous"], ["achat", "Achats"], ["brulage", "Brûlages"], ["entretien", "Entretiens"]]
    .map(([id, l]) => `<button data-ghisto="${id}" class="${f === id ? "sel" : ""}">${l}</button>`).join("")}</div>`;
  const avenir = f === "tous" || f === "entretien" ? D.rdv.filter(e => dePoele(e) && e.date >= aujourdhui()) : [];
  if (avenir.length) h += `<section class="card gmois"><b>À venir</b><ul class="runs">${avenir.map(e => ligneHisto("rdv", e)).join("")}</ul></section>`;
  if (!items.length) return h + `<section class="card"><div class="sub">Rien pour l'instant.</div></section>`;
  let premier = true;
  for (const [k, l] of groupes) {
    const [a, m] = k.split("-").map(Number);
    const ouvert = etat.ouverts.has(k) || (premier && !etat.ouverts.has("!" + k));
    const ach = somme(l.filter(x => x.l === "achats").map(x => x.e)), br = somme(l.filter(x => x.l === "brulages").map(x => x.e));
    h += `<details class="card gmois" data-gmois="${k}" ${ouvert ? "open" : ""}><summary><div><b>${MOIS_LONG[m - 1]} ${a}</b>
      <div class="sub" style="font-size:12px">🛒 ${nb(ach)} achetés · 🔥 ${nb(br)} brûlés</div></div></summary><ul class="runs">`;
    for (const { l: liste, e } of l) h += ligneHisto(liste, e);
    h += `</ul></details>`;
    premier = false;
  }
  return h;
}
function ligneHisto(liste, e) {
  const qui = e.qui ? ` · ${esc(e.qui)}` : "", note = e.note ? ` · ${esc(e.note)}` : "";
  let ic, titre, sous, droite = "";
  if (liste === "achats") {
    ic = "🛒"; titre = `Achat de ${sacsTxt(e.sacs)} · ${esc(e.marque)}`;
    sous = [e.prixSac ? `${euros(e.prixSac)}/sac` : "", e.lieu ? esc(e.lieu) : ""].filter(Boolean).join(" · ");
    droite = e.prixSac ? euros(prixAchat(e)) : "";
  } else if (liste === "brulages") {
    ic = "🔥"; titre = `${sacsTxt(e.sacs)} brûlé${e.sacs >= 2 ? "s" : ""} · ${esc(courtPoele(e.poele))}`; sous = esc(e.marque);
  } else if (liste === "rdv") {
    ic = "📅"; titre = `Rendez-vous : ${esc(e.libelle || TYPES_ENT[e.type])}`; sous = esc(courtPoele(e.poele));
  } else {
    ic = ICONE_ENT[e.type] || "🧹"; titre = esc(e.type === "annexe" && e.libelle ? e.libelle : TYPES_ENT[e.type]);
    sous = esc(courtPoele(e.poele)); droite = e.cout ? euros(e.cout) : "";
  }
  return `<li class="gligne" data-gedit="${liste}:${e.id}"><span class="ri">${ic}</span><span class="rt">${titre}<small>${sous}${qui}${note}</small></span>
    <span class="rd">${dateCourte(e.date)}${droite ? `<br><b>${droite}</b>` : ""}</span></li>`;
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
  const cles = clesPoeles();
  const brS = D.brulages.filter(b => anneeSaison(b.date) === sel && dePoele(b));
  const acS = D.achats.filter(a => anneeSaison(a.date) === sel);
  let h = `<div class="gchips gfiltreh">${saisons.map(a => `<button data-gsaison="${a}" class="${a === sel ? "sel" : ""}">Saison ${nomSaison(a)}</button>`).join("")}</div>`;

  // 1. par mois
  const mois = moisSaison(sel);
  h += `<section class="card"><h2>🔥 Sacs brûlés par mois</h2>${barres(mois.map(({ a, m }) => {
    const l = brS.filter(b => b.date.startsWith(`${a}-${pad(m)}`));
    return { lab: MOIS[m - 1], valeurs: valeursPoeles(l), titre: `${MOIS_LONG[m - 1]} ${a} : ${sacsTxt(somme(l))}` };
  }), { cles })}${legende(cles)}
  <div class="sub" style="margin-top:8px">Total : <b style="font-size:15px">${sacsTxt(somme(brS))}</b> · ${nb(somme(brS) * R().kgSac, 0)} kg</div></section>`;

  // 2. dépenses par mois
  h += `<section class="card"><h2>💶 Achats par mois</h2>${barres(mois.map(({ a, m }) => {
    const l = acS.filter(x => x.date.startsWith(`${a}-${pad(m)}`)), v = somme(l, prixAchat);
    return { lab: MOIS[m - 1], valeurs: { e: Math.round(v) }, titre: `${MOIS_LONG[m - 1]} ${a} : ${euros(v)} (${sacsTxt(somme(l))})` };
  }), { couleurs: { e: C_EUROS }, unite: "€" })}
  <div class="sub" style="margin-top:8px">Total : <b style="font-size:15px">${euros(somme(acS, prixAchat))}</b> pour ${sacsTxt(somme(acS))}</div></section>`;

  // 3. par saison
  if (saisons.length > 1) {
    h += `<section class="card"><h2>📅 Sacs brûlés par saison</h2>${barres(saisons.map(a => {
      const l = D.brulages.filter(b => anneeSaison(b.date) === a && dePoele(b));
      return { lab: nomSaison(a), valeurs: valeursPoeles(l), fort: a === sel };
    }), { cles })}${legende(cles)}</section>`;
  }

  // 4. intensité hebdomadaire
  const tranches = [[1, 7], [8, 14], [15, 21], [22, 31]];
  const cases = mois.map(({ a, m }) => tranches.map(([d1, d2]) => {
    const fin = Math.min(d2, new Date(a, m, 0).getDate());
    const l = brS.filter(b => { const d = date(b.date); return d.getFullYear() === a && d.getMonth() + 1 === m && d.getDate() >= d1 && d.getDate() <= fin; });
    return { a, m, d1, fin, sacs: somme(l), l };
  }));
  const maxCase = Math.max(1, ...cases.flat().map(c => c.sacs));
  h += `<section class="card"><h2>🗓️ Intensité par semaine</h2><div class="gheat" style="grid-template-columns:repeat(${mois.length},1fr)">
    ${mois.map(({ m }) => `<div class="gh-t">${MOIS[m - 1]}</div>`).join("")}
    ${tranches.map((_, ti) => cases.map((col, mi) => {
      const c = col[ti], alpha = c.sacs ? .25 + .75 * c.sacs / maxCase : 0;
      return `<button class="gh-c" data-gcase="${mi}-${ti}" style="${c.sacs ? `background:rgba(224,99,26,${alpha.toFixed(2)})` : ""}">${c.d1}-${c.fin}</button>`;
    }).join("")).join("")}</div><div id="gCaseDetail" class="sub" style="margin-top:10px">Touche une case pour le détail.</div></section>`;
  vueStats.cases = cases;

  // 5. prévision du stock
  const stock = stockTotal(), conso = consoMoyenne();
  if (sel === saisonCourante()) {
    const jours = conso > 0 ? Math.floor(stock / conso) : null;
    h += `<section class="card"><h2>⏳ Fin du stock</h2><div class="gtuiles trois">
      <div class="gtuile"><div class="sub">Stock</div><b>${nb(stock)}</b> <small>sacs</small></div>
      <div class="gtuile"><div class="sub">Autonomie</div><b>${jours ?? "--"}</b> <small>jours</small></div>
      <div class="gtuile"><div class="sub">Rythme</div><b>${nb(conso, 2)}</b> <small>sac/j</small></div></div>
      ${jours !== null ? projection(stock, conso, jours) : ""}
      <div class="sub" style="font-size:12px;margin-top:6px">Rythme moyen des deux poêles depuis le premier sac de la saison.</div></section>`;
  }

  // 6. marques
  const parMarque = {}; brS.forEach(b => parMarque[b.marque] = (parMarque[b.marque] || 0) + b.sacs);
  const totB = somme(brS) || 1;
  const r = etat.poele !== "cuisine" ? rendementSalon() : null;
  h += `<section class="card"><h2>🏷️ Marques</h2>${Object.keys(parMarque).length ? Object.entries(parMarque).sort((a, b) => b[1] - a[1]).map(([m, n]) => {
    const prix = moyennePrix(D.achats.filter(a => a.marque === m));
    const rm = r && r.parMarque[m];
    return `<div class="gmarque"><div class="row"><b>${esc(m)}</b><span>${sacsTxt(n)} · ${Math.round(n / totB * 100)} %</span></div>
      <div class="gjauge fine"><span style="width:${n / totB * 100}%"></span></div>
      <div class="sub" style="font-size:12px">${prix ? `Prix moyen ${euros(prix)}/sac` : "Prix inconnu"}${rm && rm.sacs ? ` · ${nb(rm.min / 60 / rm.sacs)} h de chauffe par sac (salon)` : ""}</div></div>`;
  }).join("") : `<div class="sub">Aucun sac brûlé sur cette saison.</div>`}
  ${r ? `<div class="sub" style="font-size:12px;margin-top:8px">Heures de chauffe par sac : temps de chauffe du salon entre deux sacs déclarés au salon. C'est la mesure la plus juste pour comparer les marques.</div>` : ""}</section>`;

  // 7. prix moyen par saison
  if (D.achats.length) {
    h += `<section class="card"><h2>💰 Prix moyen du sac</h2>${barres(saisons.map(a => {
      const p = moyennePrix(D.achats.filter(x => anneeSaison(x.date) === a));
      return { lab: nomSaison(a), valeurs: { e: p ? Math.round(p * 100) / 100 : 0 }, titre: p ? `${nomSaison(a)} : ${euros(p)}` : "", fort: a === sel };
    }), { couleurs: { e: C_EUROS }, unite: "€", hauteur: 100 })}
    <ul class="runs">${D.achats.slice().reverse().slice(0, 6).map(a => `<li><span class="ri">🛒</span><span class="rt">${dateLongue(a.date)}<small>${esc(a.marque)} · ${sacsTxt(a.sacs)}</small></span><span class="rd">${a.prixSac ? euros(a.prixSac) : "--"}</span></li>`).join("")}</ul></section>`;
  }

  // 8. durée des saisons
  h += `<section class="card"><h2>📏 Durée des saisons de chauffe</h2>${saisons.map(a => {
    const l = D.brulages.filter(b => anneeSaison(b.date) === a && dePoele(b));
    if (!l.length) return `<div class="gduree"><span>${nomSaison(a)}</span><span class="sub">pas de données</span></div>`;
    const debut = l[0].date, fin = l[l.length - 1].date;
    return `<div class="gduree"><span>${nomSaison(a)}</span><span>${dateCourte(debut)} → ${dateCourte(fin)} · <b>${ecartJours(debut, fin) + 1} j</b></span></div>`;
  }).join("")}<div class="sub" style="font-size:12px;margin-top:6px">Du premier au dernier sac déclaré de la saison.</div></section>`;

  // 9. entretien
  const ent = D.entretiens.filter(e => anneeSaison(e.date) === sel && dePoele(e));
  const cout = somme(ent, e => e.cout);
  h += `<section class="card"><h2>🧰 Entretiens</h2>
    <div class="gtuiles trois">${["regulier", "vitre", "annuel"].map(t => `<div class="gtuile"><div class="sub">${ICONE_ENT[t]} ${TYPES_ENT[t].replace("Entretien ", "").replace("Nettoyage ", "")}</div><b>${ent.filter(e => e.type === t).length}</b></div>`).join("")}</div>
    <div class="sub" style="margin-top:8px">Dépenses entretien et annexes : <b style="font-size:15px">${euros(cout)}</b></div></section>`;
  return h;
}
function moyennePrix(achats) {
  const l = achats.filter(a => a.prixSac); const s = somme(l);
  return s ? somme(l, prixAchat) / s : null;
}
function projection(stock, conso, jours) {
  const W = 320, H = 110, n = Math.min(jours, 240), auj = aujourdhui();
  const x = j => 4 + j / Math.max(1, n) * (W - 8), y = v => 8 + (1 - v / Math.max(1, stock)) * (H - 30);
  const fin = Math.min(n, jours);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="gsvg"><line x1="0" x2="${W}" y1="${H - 22 + .5}" y2="${H - 22 + .5}" stroke="var(--line)"/>
    <path d="M${x(0)},${y(stock)} L${x(fin)},${y(Math.max(0, stock - conso * fin))}" stroke="${C_SALON}" stroke-width="2" fill="none"/>
    <circle cx="${x(0)}" cy="${y(stock)}" r="4" fill="${C_SALON}"/>`;
  const etapes = 4;
  for (let i = 0; i <= etapes; i++) {
    const j = Math.round(n * i / etapes);
    svg += `<text x="${Math.min(W - 24, Math.max(24, x(j)))}" y="${H - 6}" class="glab">${dateCourte(ajouterJours(auj, j))}</text>`;
  }
  svg += `<text x="${x(0) + 8}" y="${y(stock) + 4}" class="gval" text-anchor="start">${nb(stock)} sacs</text></svg>`;
  return svg + (jours > n ? `<div class="sub" style="font-size:12px">Graphique limité à 8 mois.</div>` : "");
}

/* ---------- Entretiens ---------- */
function vueEntretiens() {
  const p = etat.poele !== "tous" ? etat.poele : etat.entPoele;
  let h = etat.poele === "tous" ? `<div class="gchips gfiltreh">${D.poeles.map(x => `<button data-gentp="${x.id}" class="${p === x.id ? "sel" : ""}"><i style="background:${COULEUR[x.id]}"></i>${esc(courtPoele(x.id))}</button>`).join("")}</div>` : "";
  const ent = D.entretiens.filter(e => e.poele === p);
  const dernier = t => ent.filter(e => e.type === t).map(e => e.date).sort().pop() || null;
  // annuel
  const da = dernier("annuel");
  const rdv = D.rdv.filter(r => r.poele === p && r.type === "annuel").sort((a, b) => a.date < b.date ? -1 : 1).pop();
  h += `<section class="card gent annuel"><div class="row"><h2 style="margin:0">🛠️ Entretien annuel</h2>${rdv ? `<span class="gbadge vert">RDV fixé</span>` : ""}</div>
    <div class="row" style="margin-top:10px"><div><div class="sub">Dernier entretien</div><b>${da ? dateLongue(da) : "Aucun"}</b></div>
    <div style="text-align:right"><div class="sub">Prochain</div><b>${rdv ? dateLongue(rdv.date) : "--"}</b></div></div>
    <div class="gboutons"><button class="small-btn" data-gact="annuel-fait:${p}">✓ Fait</button>
      <button class="small-btn" data-gact="annuel-rdv:${p}">📅 ${rdv ? "Modifier le RDV" : "Fixer un RDV"}</button>
      ${rdv ? `<button class="small-btn" data-gact="annuel-annuler:${rdv.id}">Annuler le RDV</button>` : ""}</div></section>`;
  // régulier & vitre
  for (const t of ["regulier", "vitre"]) {
    const d = dernier(t), freq = (R().frequences || {})[t] || (t === "vitre" ? 2 : 7);
    const depuis = d ? ecartJours(d, aujourdhui()) : null, aJour = depuis !== null && depuis <= freq;
    const pct = depuis === null ? 100 : Math.min(100, depuis / freq * 100);
    h += `<section class="card gent"><div class="row"><h2 style="margin:0">${ICONE_ENT[t]} ${TYPES_ENT[t]}</h2>
      <span class="gbadge ${aJour ? "vert" : "orange"}">${aJour ? (t === "vitre" ? "Propre" : "À jour") : "À faire"}</span></div>
      <div class="row" style="margin-top:10px"><div><div class="sub">${d ? `Fait ${depuis === 0 ? "aujourd'hui" : depuis === 1 ? "hier" : `il y a ${depuis} jours`}` : "Jamais fait"}</div>
      <b>${depuis ?? "--"} / ${freq} jours</b></div><button class="main b-on gfait" data-gact="fait:${t}:${p}">C'est fait !</button></div>
      <div class="gjauge fine ${aJour ? "" : "orange"}"><span style="width:${pct}%"></span></div></section>`;
  }
  // annexes
  const annexes = ent.filter(e => e.type === "annexe").slice().reverse();
  h += `<section class="card gent"><div class="row"><h2 style="margin:0">🧩 Dépenses annexes</h2>
    <button class="small-btn" data-gact="annexe:${p}">＋ Ajouter</button></div>
    ${annexes.length ? `<ul class="runs">${annexes.slice(0, 10).map(e => ligneHisto("entretiens", e)).join("")}</ul>` : `<div class="sub" style="margin-top:8px">Brosses, aspirateur, joints… les petites dépenses du poêle.</div>`}</section>`;
  return h;
}

/* ---------- Fenêtres de saisie ---------- */
function ouvrirFeuille(html, init) {
  const d = $("gSheet");
  d.innerHTML = `<form method="dialog" class="gform">${html}</form>`;
  d.querySelectorAll("[data-gfermer]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); d.close(); }));
  d.addEventListener("click", e => { if (e.target === d) d.close(); }, { once: true });
  document.documentElement.classList.add("bloque");
  d.showModal();
  if (init) init(d);
}
$("gSheet").addEventListener("close", () => document.documentElement.classList.remove("bloque"));
const tete = (ic, titre) => `<div class="dhead"><h2>${ic} ${titre}</h2><button class="icon-btn" data-gfermer type="button" aria-label="Fermer">✕</button></div>`;
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
  ouvrirFeuille(`${tete("🔥", modif ? "Modifier le brûlage" : "Sac brûlé")}
    ${champ("Date", `<input type="date" name="date" value="${e.date}" required>`)}
    <div class="f">Poêle${choixPoele(e.poele)}</div>
    ${champ("Marque", `<select name="marque">${optMarques(e.marque, true)}</select>`)}
    <div class="f">Nombre de sacs<div class="stepper"><button type="button" data-pas="-0.5">−</button><output name="sacsAff">${nb(e.sacs)}</output><button type="button" data-pas="0.5">+</button></div><input type="hidden" name="sacs" value="${e.sacs}"></div>
    ${champ("Note (facultatif)", `<input type="text" name="note" value="${esc(e.note || "")}">`)}
    ${boutonsForm(modif, "Ajouter le brûlage")}`, d => {
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
  ouvrirFeuille(`${tete("🛒", modif ? "Modifier l'achat" : "Achat")}
    ${champ("Date", `<input type="date" name="date" value="${e.date}" required>`)}
    ${champ("Marque", `<select name="marque">${optMarques(e.marque)}<option value="__nouvelle">＋ Nouvelle marque…</option></select>`)}
    <label class="f" id="gNouvelleMarque" hidden>Nom de la marque<input type="text" name="nouvelle" autocapitalize="words"></label>
    <div class="f">Nombre de sacs<div class="gsacs"><input type="number" name="sacs" inputmode="decimal" min="0.5" step="0.5" value="${e.sacs}" placeholder="sacs" required>
      ${[1, 5, 10].map(n => `<button type="button" class="small-btn" data-plus="${n}">+${n}</button>`).join("")}</div></div>
    <div class="two">${champ("Prix par sac (€)", `<input type="number" name="prixSac" inputmode="decimal" step="0.01" min="0" value="${e.prixSac ?? ""}">`)}
      ${champ("Prix total (€)", `<input type="number" name="total" inputmode="decimal" step="0.01" min="0" value="${e.prixSac && e.sacs ? (e.prixSac * e.sacs).toFixed(2) : ""}">`)}</div>
    ${champ("Lieu d'achat (facultatif)", `<input type="text" name="lieu" value="${esc(e.lieu || "")}">`)}
    ${champ("Note (facultatif)", `<input type="text" name="note" value="${esc(e.note || "")}">`)}
    ${boutonsForm(modif, "Ajouter l'achat")}`, d => {
    const f = d.querySelector("form");
    f.marque.addEventListener("change", () => { $("gNouvelleMarque").hidden = f.marque.value !== "__nouvelle"; });
    d.querySelectorAll("[data-plus]").forEach(b => b.addEventListener("click", () => { f.sacs.value = (Number(f.sacs.value) || 0) + Number(b.dataset.plus); majTotal(); }));
    const majTotal = () => { if (f.prixSac.value && f.sacs.value) f.total.value = (f.prixSac.value * f.sacs.value).toFixed(2); };
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
  const modif = !!e; e = e || { date: aujourdhui(), type, poele, note: "", cout: null, libelle: "" };
  const annexe = e.type === "annexe";
  ouvrirFeuille(`${tete(ICONE_ENT[e.type], modif ? `Modifier : ${TYPES_ENT[e.type]}` : TYPES_ENT[e.type])}
    ${champ("Date", `<input type="date" name="date" value="${e.date}" required>`)}
    <div class="f">Poêle${choixPoele(e.poele)}</div>
    ${annexe ? champ("Quoi ?", `<input type="text" name="libelle" value="${esc(e.libelle || "")}" placeholder="ex. brosse, joint de porte…" required>`) : ""}
    ${annexe || e.type === "annuel" ? champ("Coût (€)", `<input type="number" name="cout" inputmode="decimal" step="0.01" min="0" value="${e.cout ?? ""}">`) : ""}
    ${champ("Note (facultatif)", `<input type="text" name="note" value="${esc(e.note || "")}" ${e.type === "annuel" ? 'placeholder="ex. nom du professionnel"' : ""}>`)}
    ${boutonsForm(modif, annexe ? "Ajouter la dépense" : e.type === "vitre" ? "C'est propre !" : "C'est fait !")}`, d => {
    brancherForm(d, "entretiens", e, f => ({ date: f.date.value, type: e.type, poele: f.poele.value, note: f.note.value,
      libelle: f.libelle ? f.libelle.value : "", cout: f.cout && f.cout.value !== "" ? Number(f.cout.value) : null }),
      async () => {   // entretien annuel fait : le rendez-vous correspondant est retiré
        if (e.type !== "annuel" || modif) return;
        const rdv = D.rdv.find(r => r.poele === e.poele && r.type === "annuel" && r.date <= ajouterJours(aujourdhui(), 30));
        if (rdv) await envoyer({ op: "supprimer", liste: "rdv", id: rdv.id }).catch(() => {});
      });
  });
}
function feuilleRdv(poele) {
  const rdv = D.rdv.find(r => r.poele === poele && r.type === "annuel");
  ouvrirFeuille(`${tete("📅", "Rendez-vous d'entretien annuel")}
    ${champ("Date du rendez-vous", `<input type="date" name="date" value="${rdv ? rdv.date : ""}" required>`)}
    ${champ("Note (facultatif)", `<input type="text" name="note" value="${esc(rdv ? rdv.note || "" : "")}" placeholder="ex. ramoneur, heure…">`)}
    <button class="main b-on gvalider" type="submit">Enregistrer</button>`, d => {
    brancherForm(d, "rdv", rdv, f => ({ date: f.date.value, type: "annuel", poele, note: f.note.value }));
  });
}
function boutonsForm(modif, libelle) {
  return modif
    ? `<button class="main b-on gvalider" type="submit">Enregistrer</button>
       <button class="save danger" type="button" data-gsuppr>Supprimer</button>
       <div class="confirm" data-gconfirm><div>Supprimer définitivement cette ligne ?</div><div class="two">
         <button class="save" type="button" data-gnon>Annuler</button><button class="save danger-plein" type="button" data-goui>Oui, supprimer</button></div></div>`
    : `<button class="main b-on gvalider" type="submit">${libelle}</button>`;
}
function brancherForm(d, liste, e, lire, apres) {
  const f = d.querySelector("form");
  const modif = !!(e && e.id);
  f.addEventListener("submit", async ev => {
    ev.preventDefault();
    let el; try { el = lire(f); } catch (err) { return toast(err.message); }
    if (!el.date) return toast("Indique une date");
    const b = f.querySelector(".gvalider"); b.disabled = true; b.textContent = "Enregistrement…";
    try {
      await envoyer({ op: modif ? "modifier" : "ajouter", liste, id: modif ? e.id : undefined, element: el });
      if (apres) await apres(el);
      d.close(); toast(modif ? "✓ Modifié" : "✓ Enregistré");
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = "Réessayer"; }
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
  ouvrirFeuille(`${tete("＋", "Ajouter")}
    <div class="gchoix"><button type="button" class="main b-on" data-g="brulage">🔥 Sac brûlé</button>
    <button type="button" class="main b-off" data-g="achat">🛒 Achat</button></div>`, d => {
    d.querySelector('[data-g="brulage"]').addEventListener("click", () => { d.close(); feuilleBrulage(); });
    d.querySelector('[data-g="achat"]').addEventListener("click", () => { d.close(); feuilleAchat(); });
  });
}
function feuilleReglages() {
  const r = R();
  const moisOpt = sel => MOIS_LONG.map((m, i) => `<option value="${i + 1}" ${i + 1 === sel ? "selected" : ""}>${m}</option>`).join("");
  const st = r.stockInitial || {};
  ouvrirFeuille(`${tete("⚙︎", "Réglages des granulés")}
    <div class="bloc"><h3>📅 Saison de chauffe</h3><div class="two">
      ${champ("Début", `<select name="saisonDebut">${moisOpt(r.saisonDebut)}</select>`)}${champ("Fin", `<select name="saisonFin">${moisOpt(r.saisonFin)}</select>`)}</div></div>
    <div class="bloc"><h3>📦 Stockage</h3><div class="two">
      ${champ("Capacité (sacs)", `<input type="number" name="capacite" min="1" value="${r.capacite}">`)}${champ("Poids d'un sac (kg)", `<input type="number" name="kgSac" min="1" step="0.5" value="${r.kgSac}">`)}</div>
      <div class="two">${champ("Alerte rouge sous (%)", `<input type="number" name="seuilRouge" min="0" max="100" value="${r.seuilRouge}">`)}${champ("Alerte orange sous (%)", `<input type="number" name="seuilOrange" min="0" max="100" value="${r.seuilOrange}">`)}</div></div>
    <div class="bloc"><h3>🏷️ Marques et stock initial</h3>
      <p class="hint">Stock initial : les sacs que tu avais avant de commencer à noter les achats.</p>
      ${marques().map(m => `<div class="gmarq row"><span>${esc(m)}</span><input type="number" name="init:${esc(m)}" min="0" step="0.5" value="${st[m] || 0}" aria-label="Stock initial ${esc(m)}"></div>`).join("")}
      ${champ("Ajouter une marque", `<input type="text" name="nouvelle" placeholder="ex. Piveteau" autocapitalize="words">`)}</div>
    <div class="bloc"><h3>🧹 Fréquence des entretiens</h3><div class="two">
      ${champ("Entretien régulier (jours)", `<input type="number" name="regulier" min="1" value="${r.frequences.regulier}">`)}${champ("Vitre (jours)", `<input type="number" name="vitre" min="1" value="${r.frequences.vitre}">`)}</div></div>
    <button class="main b-on gvalider" type="submit">Enregistrer</button>
    <button class="save" type="button" id="gExport">⬇️ Exporter en CSV (Excel)</button>`, d => {
    d.querySelector("#gExport").addEventListener("click", exporter);
    const f = d.querySelector("form");
    f.addEventListener("submit", async ev => {
      ev.preventDefault();
      const n = k => Number(f[k].value);
      const stockInitial = {};
      f.querySelectorAll('input[name^="init:"]').forEach(i => { if (Number(i.value)) stockInitial[i.name.slice(5)] = Number(i.value); });
      const ms = marques(); if (f.nouvelle.value.trim() && !ms.includes(f.nouvelle.value.trim())) ms.push(f.nouvelle.value.trim());
      const reglages = { saisonDebut: n("saisonDebut"), saisonFin: n("saisonFin"), capacite: n("capacite") || 90, kgSac: n("kgSac") || 15,
        seuilRouge: n("seuilRouge"), seuilOrange: n("seuilOrange"), marques: ms, stockInitial,
        frequences: { regulier: n("regulier") || 7, vitre: n("vitre") || 2 } };
      const b = f.querySelector(".gvalider"); b.disabled = true;
      try { await envoyer({ op: "reglages", reglages }); d.close(); toast("✓ Réglages enregistrés"); }
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
  d.reglages = { saisonDebut: 10, saisonFin: 4, capacite: 90, kgSac: 15, seuilRouge: 10, seuilOrange: 30, marques: [], stockInitial: {}, ...(d.reglages || {}) };
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
  charge = true;
  try {
    const [g, c] = await Promise.all([
      gh(`/contents/granules.json?t=${Date.now()}`, { raw: true }).then(JSON.parse).catch(e => { if (e.notFound) return null; throw e; }),
      gh(`/contents/chauffes.json?ref=etat&t=${Date.now()}`, { raw: true }).then(JSON.parse).catch(() => null),
    ]);
    D = completer(g); chauffes = c; rendre();
  } catch (e) { $("vueGranules").innerHTML = `<section class="card"><div class="sub err">${esc(e.message)}</div></section>`; }
}

/* ---------- Événements ---------- */
$("vueGranules").addEventListener("click", ev => {
  const t = ev.target.closest("button, li[data-gedit], summary"); if (!t) return;
  const ds = t.dataset;
  if (ds.gpoele) { etat.poele = ds.gpoele; store.set("g.poele", ds.gpoele); return rendre(); }
  if (ds.gvue) { etat.vue = ds.gvue; store.set("g.vue", ds.gvue); rendre(); return window.scrollTo({ top: 0 }); }
  if (ds.gportee) { etat.portee = ds.gportee; store.set("g.portee", ds.gportee); return rendre(); }
  if (ds.ggraphe) { etat.graphe = ds.ggraphe; return rendre(); }
  if (ds.ghisto) { etat.filtreHisto = ds.ghisto; return rendre(); }
  if (ds.gsaison) { etat.saisonStats = Number(ds.gsaison); return rendre(); }
  if (ds.gentp) { etat.entPoele = ds.gentp; store.set("g.entPoele", ds.gentp); return rendre(); }
  if (t.id === "gMoy") { etat.moyenne = { "7j": "mois", mois: "saison", saison: "7j" }[etat.moyenne]; return rendre(); }
  if (t.id === "gPlus") return feuilleAjout();
  if (t.id === "gReglages") return feuilleReglages();
  if (ds.gcase) {
    const [mi, ti] = ds.gcase.split("-").map(Number), c = vueStats.cases[mi][ti];
    $("vueGranules").querySelectorAll(".gh-c.sel").forEach(x => x.classList.remove("sel")); t.classList.add("sel");
    $("gCaseDetail").innerHTML = `<b style="color:var(--text)">Du ${c.d1} au ${c.fin} ${MOIS_LONG[c.m - 1].toLowerCase()} ${c.a}</b> : ${sacsTxt(c.sacs)} · ${nb(c.sacs * R().kgSac, 0)} kg`
      + (c.l.length ? "<br>" + c.l.map(b => `${dateCourte(b.date)} · ${esc(courtPoele(b.poele))} · ${esc(b.marque)} : ${nb(b.sacs)}`).join("<br>") : "");
    return;
  }
  if (ds.gact) {
    const [a, x, y] = ds.gact.split(":");
    if (a === "fait") return feuilleEntretien(null, x, y);
    if (a === "annexe") return feuilleEntretien(null, "annexe", x);
    if (a === "annuel-fait") return feuilleEntretien(null, "annuel", x);
    if (a === "annuel-rdv") return feuilleRdv(x);
    if (a === "annuel-annuler") return envoyer({ op: "supprimer", liste: "rdv", id: x }).then(() => toast("✓ Rendez-vous annulé")).catch(e => toast(e.message));
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

window.granules = { charger, rendre, estCharge: () => !!D };
document.addEventListener("visibilitychange", () => { if (!document.hidden && cfg.token && !$("vueGranules").hidden && !ecriture) charger(); });
if (cfg.token && !$("vueGranules").hidden) { rendre(); charger(); }
})();
