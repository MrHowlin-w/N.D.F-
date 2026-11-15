/* =====================================================================
   NDF — service de lecture des tickets (Cloudflare Worker)  —  version 2
   ---------------------------------------------------------------------
   Rôle : recevoir la photo d'un ticket envoyée par l'appli, la faire lire
   par un modèle Gemini (Google) et renvoyer les champs de la note de frais.
   La clé Gemini reste ici, côté serveur : elle n'apparaît jamais dans l'appli.

   Variables à définir sur le Worker (inchangées par rapport à la version 1) :
     - APP_SHARED_KEY  : le mot de passe partagé, identique à celui de index.html
     - GEMINI_API_KEY  : la clé Gemini (Google AI Studio)

   Nouveautés de la version 2 :
     - lit aussi l'heure, la ville, l'adresse et la catégorie de la dépense ;
     - consigne de lecture détaillée, indépendante du format du ticket ;
     - essaie plusieurs modèles dans l'ordre : si l'un est retiré par Google
       ou a épuisé son quota, le suivant prend le relais ;
     - contrôle et nettoyage de la réponse (dates, montants, cohérence HT/TVA/TTC).

   Nouveauté de la version 2.3 :
     - mode « compare » : l'appli envoie deux photos et le modèle dit s'il s'agit
       du même ticket photographié deux fois (contenu imprimé, police, format,
       plis et froissures) ou de deux tickets différents.
   ===================================================================== */

const VERSION = 'ndf-worker-2.3';

/* Modèles essayés dans l'ordre. Le premier disponible répond.
   Pour en ajouter ou en retirer un, modifier simplement cette liste. */
const MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
];

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_IMAGE_BASE64_LENGTH = 4500000;   // ~3,3 Mo d'image : suffisant, et léger à traiter
const MODEL_TIMEOUT_MS = 25000;            // délai maximal accordé à un modèle pour répondre

const CATEGORIES = [
  'Carburant', 'Péage', 'Parking', 'Restaurant / Repas', 'Hébergement',
  'Transport', 'Location de véhicule', 'Entretien véhicule',
  'Fournitures / Matériel', 'Télécom / Internet', 'Autre'
];

const PROMPT = `Tu es un comptable expérimenté. On te montre la photo d'un justificatif de dépense professionnelle : ticket de caisse, ticket de carte bancaire, facture, reçu de péage, de parking, de station-service, d'hôtel, de restaurant, de taxi, etc. Le document peut venir de n'importe quel commerce et de n'importe quel pays ; sa mise en page est imprévisible. La photo peut être penchée, froissée, pâle, coupée ou prise de travers.

Lis TOUT le document avec attention, du haut jusqu'en bas, puis renvoie UNIQUEMENT un objet JSON (sans texte autour, sans balises Markdown) contenant exactement ces clés :

{
  "date": "AAAA-MM-JJ ou null",
  "time": "HH:MM (24 h) ou null",
  "provider": "nom du commerce ou null",
  "invoiceNumber": "numéro de facture ou de ticket ou null",
  "category": "une valeur de la liste ci-dessous",
  "description": "description courte en français ou null",
  "ht": nombre ou null,
  "vat": nombre ou null,
  "ttc": nombre ou null,
  "currency": "code ISO à 3 lettres ou null",
  "place": "ville du commerce ou null",
  "address": "adresse postale complète du commerce ou null",
  "country": "pays en français ou null",
  "confidence": "haute", "moyenne" ou "basse"
}

RÈGLES

Date et heure
- "date" est la date de l'achat (de la transaction), pas une date d'impression, d'échéance, de validité ni de fin de garantie.
- Sur un ticket français ou européen, l'ordre est jour/mois/année : 03/04/26 signifie le 3 avril 2026. Une année sur deux chiffres appartient aux années 2000.
- "time" est l'heure de l'achat imprimée sur le document, au format 24 h. Si aucune heure n'est imprimée : null.

Commerce et lieu
- "provider" est l'enseigne ou la raison sociale qui a encaissé (ex. « TotalEnergies », « Ibis Budget », « Vinci Autoroutes »), sans l'adresse, sans forme juridique inutile.
- "place" est la VILLE où se trouve le commerce, écrite normalement (« Saint-Vallier », pas « ST VALLIER 26240 »). Déduis-la de l'adresse ou du code postal imprimés sur le document. Ne prends pas la ville du siège social si l'adresse du point de vente est indiquée. Pour un péage, donne la gare de sortie si elle est indiquée.
- "address" est l'adresse postale du point de vente telle qu'elle est imprimée (rue, code postal, ville). Si elle n'apparaît pas : null.
- "country" : le pays du commerce si le document permet de le savoir (adresse, numéro de TVA, devise, langue), sinon null.

Catégorie et description
- "category" doit être EXACTEMENT l'une de ces valeurs : ${CATEGORIES.map(c => '« ' + c + ' »').join(', ')}.
  « Transport » couvre le train, l'avion, le taxi, le VTC, le bus, le métro et le bateau. « Fournitures / Matériel » couvre l'outillage, la quincaillerie, les EPI, les chaussures de sécurité, la papeterie et le petit matériel. Si rien ne convient : « Autre ».
- "description" : quelques mots en français qui disent ce qui a été acheté (ex. « Gazole 45,2 L », « Déjeuner 2 couverts », « Nuitée + petit-déjeuner », « Péage A7 Valence Sud – Montpellier »). Pas de liste d'articles interminable.

Montants
- "ttc" est le montant total réellement payé, toutes taxes comprises (lignes « TOTAL », « TOTAL TTC », « NET À PAYER », « MONTANT », « À PAYER », montant du paiement par carte). Ne prends jamais un sous-total, un montant rendu, un total de points de fidélité ni le prix d'un seul article.
- "vat" est le montant TOTAL de la TVA en valeur (pas le taux en %). S'il y a plusieurs taux (5,5 %, 10 %, 20 %...), additionne les montants de TVA de toutes les lignes.
- "ht" est le total hors taxes. S'il y a plusieurs taux, additionne les bases HT.
- Vérifie que ht + vat = ttc au centime près. Si le document donne deux de ces trois montants, calcule le troisième.
- Si le document n'indique AUCUN montant de TVA (ticket de carte bancaire seul, reçu simplifié, dépense à l'étranger), mets "vat": null et "ht": null et donne seulement "ttc". Ne calcule jamais une TVA à partir d'un taux supposé.
- Les montants sont des nombres JSON avec un point décimal et sans symbole : 45.90 et non "45,90 €". Un pourboire payé fait partie du "ttc".

Devise
- "currency" : code ISO 4217 (EUR, USD, GBP, CHF, BRL, XPF, MAD, ...). Le symbole « € » ou un commerce situé en France, y compris en Guyane ou dans les DOM, signifie EUR. Le franc Pacifique est XPF.

Honnêteté
- N'invente rien. Si une information est absente ou illisible, mets null pour cette clé. Une valeur fausse est bien plus grave qu'une valeur manquante.
- "confidence" : « haute » si tout est net et cohérent, « moyenne » si un ou deux champs sont incertains, « basse » si le document est difficile à lire ou si l'image ne montre pas un justificatif de dépense.`;

const COMPARE_PROMPT = `Tu es un contrôleur de notes de frais. On te montre deux photos de justificatifs de dépense : la photo A, puis la photo B. Les deux dépenses ont été saisies séparément et se ressemblent (même date, même montant ou même commerce). Tu dois dire si les deux photos montrent LE MÊME document papier photographié deux fois par erreur, ou deux documents réellement différents.

Examine les deux photos avec soin et compare-les sur deux plans.

1. Le contenu imprimé, ligne par ligne
- numéro de ticket, de facture, de transaction, de caisse, d'autorisation ;
- date et heure, à la minute et à la seconde si elles sont imprimées ;
- liste des articles, quantités, prix, total, moyen de paiement ;
- en-tête, adresse, mentions de bas de ticket.
Ne compare que ce qui est NETTEMENT lisible sur les DEUX photos. Un élément visible sur une seule photo (l'autre étant coupée, floue ou pliée à cet endroit) ne prouve rien, ni dans un sens ni dans l'autre. Deux photos du même document montrent les mêmes valeurs partout où les deux sont lisibles. Deux tickets distincts du même commerce, du même jour et du même montant diffèrent au moins par leur numéro ou leur heure.

2. L'aspect physique du papier
- police de caractères, mise en page, largeur et longueur du ticket, logo ;
- plis, froissures, déchirures, coins cornés, forme de la découpe en haut et en bas ;
- taches, zones d'impression pâles ou baveuses, annotations manuscrites, tampons, agrafes.
Les mêmes défauts aux mêmes endroits désignent le même document. Tiens compte du fait que l'angle de prise de vue, l'éclairage, le cadrage, le fond et la netteté peuvent changer d'une photo à l'autre : une différence de couleur, d'ombre ou d'orientation ne prouve rien. Un pli présent sur une photo et absent sur l'autre peut aussi venir d'une manipulation du papier entre les deux prises.

Réponds UNIQUEMENT par un objet JSON (sans texte autour, sans balises Markdown) :

{
  "verdict": "same_document" | "same_purchase" | "different" | "uncertain",
  "confidence": "haute" | "moyenne" | "basse",
  "reason": "une phrase courte en français qui cite l'indice décisif",
  "printedContent": "identique" | "différent" | "illisible",
  "physicalAspect": "identique" | "différent" | "indéterminé"
}

Choix du verdict
- "same_document" : c'est le même papier photographié deux fois.
- "same_purchase" : ce sont deux papiers différents mais ils justifient le MÊME achat (par exemple le ticket de caisse et le ticket de carte bancaire de la même transaction, ou une facture et son reçu). C'est aussi un doublon de dépense.
- "different" : deux achats distincts.
- "uncertain" : les photos ne permettent pas de trancher (floues, coupées, illisibles). Ne devine pas.

Règles de décision
- Commence par déterminer la nature de chaque document : ticket de caisse, ticket de carte bancaire, facture, reçu.
- Deux documents de MÊME nature : le contenu imprimé prime. Si un même élément (numéro de ticket, heure, article, total) est nettement lisible sur les deux photos et a deux valeurs différentes, le verdict est "different", même si les papiers se ressemblent.
- Deux documents de nature DIFFÉRENTE (par exemple ticket de caisse et ticket de carte bancaire) : leurs numéros ne sont pas comparables et leurs heures peuvent différer d'une ou deux minutes. Juge sur le commerce, la date, le montant total, l'heure à quelques minutes près et, s'ils sont visibles, les derniers chiffres de la carte. S'ils concordent, le verdict est "same_purchase".
- Pour répondre "different", tu dois avoir vu au moins un élément nettement lisible sur les DEUX photos avec deux valeurs différentes, et citer ces deux valeurs dans "reason". Sinon réponds "uncertain".
- L'erreur grave est de répondre "different" pour un même ticket : le doublon serait alors remboursé deux fois. Dans le doute, réponds "uncertain".
- Dans "reason", cite ce que tu as réellement vu (par exemple « même numéro de ticket 004512 et même pli en diagonale » ou « heures différentes : 12:04 et 19:31 »).`;

const RETRY_ADDENDUM = `

ATTENTION — SECONDE LECTURE : une première lecture de ce même document a donné un résultat incomplet ou faux. L'image envoyée cette fois est plus grande et plus nette. Reprends le document ligne par ligne, lis chaque chiffre un par un (ne confonds pas 1 et 7, 3 et 8, 5 et 6, 0 et 8), repère la ligne du total payé et le tableau de TVA, puis vérifie tes additions avant de répondre.`;

/* ----------------------------- utilitaires ----------------------------- */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders())
  });
}

/* Comparaison à durée constante : n'indique pas, par le temps de réponse,
   combien de caractères du mot de passe sont justes. */
function safeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/* Accepte 45.9, "45,90", "1 234,56 €", "1.234,56", "1,234.56" -> nombre, sinon null */
function toAmount(v) {
  if (typeof v === 'number') return isFinite(v) ? round2(v) : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // le séparateur le plus à droite est le séparateur décimal
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    s = s.replace(/,/g, '.');
  }
  // plusieurs points restants : seul le dernier est décimal
  const parts = s.split('.');
  if (parts.length > 2) s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
  const n = parseFloat(s);
  return isFinite(n) ? round2(n) : null;
}

function toText(v, maxLen) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || /^(null|n\/a|na|inconnu|aucun|non lisible|illisible|-+)$/i.test(s)) return null;
  return s.slice(0, maxLen || 200);
}

function isValidYMD(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function pad2(n) { return String(n).padStart(2, '0'); }

/* Renvoie AAAA-MM-JJ ou null. Tolère JJ/MM/AAAA et JJ/MM/AA si le modèle
   n'a pas respecté le format demandé. */
function toISODate(v) {
  const s = toText(v, 40);
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    return isValidYMD(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }
  m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const d = +m[1], mo = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    return isValidYMD(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }
  return null;
}

/* Renvoie HH:MM ou null. Tolère 14h05, 14:05:33, 2:05 PM. */
function toTime(v) {
  const s = toText(v, 20);
  if (!s) return null;
  const m = /(\d{1,2})\s*[:hH.]\s*(\d{2})/.exec(s);
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2];
  if (/pm/i.test(s) && h < 12) h += 12;
  if (/am/i.test(s) && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${pad2(h)}:${pad2(mi)}`;
}

function normKey(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}
const CATEGORY_SYNONYMS = [
  [/essence|gazole|gasoil|diesel|sp95|sp98|e10|e85|adblue|carburant|fuel/, 'Carburant'],
  [/peage|autoroute/, 'Péage'],
  [/parking|stationnement/, 'Parking'],
  [/restaur|repas|dejeuner|diner|petitdejeuner|boulanger|snack|cafe|brasserie|alimentation|epicerie|supermarche/, 'Restaurant / Repas'],
  [/hotel|hebergement|nuitee|chambre|gite|camping/, 'Hébergement'],
  [/location/, 'Location de véhicule'],
  [/entretien|garage|lavage|pneu|reparation|vidange/, 'Entretien véhicule'],
  [/train|sncf|avion|vol|taxi|vtc|bus|metro|tram|bateau|ferry|transport/, 'Transport'],
  [/fourniture|materiel|outil|quincaill|bricolage|epi|chaussure|papeterie/, 'Fournitures / Matériel'],
  [/telecom|telephone|internet|mobile|sim/, 'Télécom / Internet']
];
function toCategory(v) {
  const s = toText(v, 60);
  if (!s) return 'Autre';
  const k = normKey(s);
  if (k.length < 3) return 'Autre';
  for (const c of CATEGORIES) if (normKey(c) === k) return c;
  for (const [re, c] of CATEGORY_SYNONYMS) if (re.test(k)) return c;
  return 'Autre';
}

const CURRENCY_SYMBOLS = { '€': 'EUR', '$': 'USD', 'US$': 'USD', '£': 'GBP', 'R$': 'BRL', 'CHF': 'CHF', 'FCFA': 'XOF', 'CFA': 'XOF', 'CFP': 'XPF', 'DH': 'MAD' };
function toCurrency(v) {
  const s = toText(v, 12);
  if (!s) return null;
  const up = s.toUpperCase().replace(/\s+/g, '');
  if (CURRENCY_SYMBOLS[up]) return CURRENCY_SYMBOLS[up];
  if (/^EUROS?$/.test(up)) return 'EUR';
  if (/^DOLLARS?$/.test(up)) return 'USD';
  return /^[A-Z]{3}$/.test(up) ? up : null;
}

/* Extrait l'objet JSON de la réponse, même s'il est entouré de texte ou de balises. */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  try { const o = JSON.parse(t); if (o && typeof o === 'object') return Array.isArray(o) ? o[0] : o; } catch (_) {}
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { const o = JSON.parse(t.slice(start, end + 1)); if (o && typeof o === 'object') return o; } catch (_) {}
  return null;
}

/* Nettoie la réponse du modèle et contrôle la cohérence des montants. */
function normalizeResult(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];

  let ht = toAmount(r.ht), vat = toAmount(r.vat), ttc = toAmount(r.ttc);
  if (ht !== null && ht < 0) ht = null;
  if (vat !== null && vat < 0) vat = null;
  if (ttc !== null && ttc < 0) ttc = null;

  // Un modèle met parfois 0 au lieu de null quand la TVA n'est pas détaillée.
  if (ttc !== null && ttc > 0 && ht === 0 && (vat === 0 || vat === null)) { ht = null; vat = null; }

  if (ttc === null && ht !== null && vat !== null) ttc = round2(ht + vat);
  if (ttc !== null && ht !== null && vat === null && ht <= ttc) vat = round2(ttc - ht);
  if (ttc !== null && vat !== null && ht === null && vat <= ttc) ht = round2(ttc - vat);

  if (ttc !== null && ht !== null && vat !== null && Math.abs(round2(ht + vat) - ttc) > 0.02) {
    // Les trois montants ne s'additionnent pas : le total payé est le plus fiable,
    // on le garde seul et on laisse l'utilisateur compléter HT et TVA.
    warnings.push('amounts_inconsistent');
    ht = null; vat = null;
  }
  if (ttc !== null && vat !== null && vat > ttc) { warnings.push('vat_above_total'); ht = null; vat = null; }

  const date = toISODate(r.date);
  if (r.date && !date) warnings.push('date_unreadable');
  if (date) {
    const today = new Date();
    const limit = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 2));
    if (new Date(date + 'T00:00:00Z') > limit) warnings.push('date_in_future');
  }
  if (ttc === null) warnings.push('no_total');

  const conf = normKey(toText(r.confidence, 20) || '');
  const confidence = conf === 'haute' ? 'haute' : conf === 'basse' ? 'basse' : 'moyenne';

  return {
    date,
    time: toTime(r.time),
    provider: toText(r.provider, 120),
    invoiceNumber: toText(r.invoiceNumber, 60),
    category: toCategory(r.category),
    description: toText(r.description, 200),
    ht, vat, ttc,
    currency: toCurrency(r.currency),
    place: toText(r.place, 80),
    address: toText(r.address, 200),
    country: toText(r.country, 60),
    confidence,
    warnings
  };
}

/* ----------------------------- appel Gemini ----------------------------- */

/* Le corps de la requête est assemblé par simple concaténation : l'image (plusieurs
   Mo de base64) n'est ainsi jamais re-sérialisée, ce qui économise du temps de calcul.
   Le base64 ne contient aucun caractère à échapper en JSON. */
function buildBodyString(images, prompt, withJsonMode) {
  const parts = images.map(im => '{"inlineData":{"mimeType":' + JSON.stringify(im.mimeType) + ',"data":"' + im.data + '"}}');
  return '{"contents":[{"role":"user","parts":[' + parts.join(',') + ',{"text":' + JSON.stringify(prompt) + '}]}]' +
         (withJsonMode ? ',"generationConfig":{"responseMimeType":"application/json"}' : '') + '}';
}

function textFromGemini(data) {
  const cand = data && data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  if (!Array.isArray(parts)) return '';
  // on ignore les éventuelles parties de « réflexion » du modèle
  return parts.filter(p => p && typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
}

async function callModel(model, apiKey, bodyString) {
  let resp;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
  try {
    resp = await fetch(API_BASE + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: bodyString,
      signal: ctrl.signal
    });
    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) {}
      return { ok: false, status: resp.status, detail: String(detail).slice(0, 300) };
    }
    let data;
    try { data = await resp.json(); } catch (_) { return { ok: false, status: 502, detail: 'réponse illisible', empty: true }; }
    const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
    if (blocked) return { ok: false, status: 422, detail: 'image refusée par le modèle (' + blocked + ')', blocked: true };
    const parsed = extractJson(textFromGemini(data));
    if (!parsed) return { ok: false, status: 502, detail: 'réponse sans JSON', empty: true };
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, network: true, timeout: ctrl.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

function isKeyProblem(res) {
  return res.status === 401 || ((res.status === 400 || res.status === 403) && /api.?key|permission|suspend|leaked/i.test(res.detail || ''));
}
/* Plus le rang est petit, plus l'erreur renseigne sur la vraie cause. */
function errorRank(res) {
  if (isKeyProblem(res)) return 0;
  if (res.status === 429) return 1;
  if (res.status === 422) return 2;
  if (res.status >= 500) return 3;
  if (res.status === 404) return 5;
  return 4;
}

/* Interroge les modèles dans l'ordre jusqu'à obtenir une réponse JSON exploitable. */
async function askModels(apiKey, images, prompt) {
  let best = null;
  let sawNetworkError = false;
  const bodyJson = buildBodyString(images, prompt, true);
  let bodyPlain = null;

  for (const model of MODELS) {
    let res = await callModel(model, apiKey, bodyJson);

    // Requête refusée à cause du mode JSON : on retente une fois sans lui,
    // la consigne demande déjà du JSON.
    if (!res.ok && !res.network && res.status === 400 && /mime|generation.?config|json|unknown name|invalid json payload/i.test(res.detail || '')) {
      if (bodyPlain === null) bodyPlain = buildBodyString(images, prompt, false);
      res = await callModel(model, apiKey, bodyPlain);
    }
    // Réponse vide ou non exploitable : un second essai sur le même modèle.
    if (!res.ok && res.empty) res = await callModel(model, apiKey, bodyJson);

    if (res.ok) return { ok: true, model, parsed: res.parsed };
    if (res.network) { sawNetworkError = true; continue; }

    res.model = model;
    if (!best || errorRank(res) < errorRank(best)) best = res;

    // Clé refusée, image refusée ou requête invalide : les autres modèles répondraient pareil.
    if (isKeyProblem(res) || res.blocked || res.status === 400) break;
    // Sinon (404 modèle retiré, 429 quota, 5xx surcharge, 403 accès au modèle) : modèle suivant.
  }

  if (!best) return sawNetworkError ? { ok: false, network: true } : { ok: false, status: 404, detail: 'aucun modèle essayé' };
  return { ok: false, status: best.status, detail: best.detail, model: best.model, keyProblem: isKeyProblem(best) };
}

function normalizeCompare(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const v = normKey(toText(r.verdict, 40) || '');
  let verdict = 'uncertain';
  if (v === 'samedocument') verdict = 'same_document';
  else if (v === 'samepurchase') verdict = 'same_purchase';
  else if (v === 'different') verdict = 'different';
  const conf = normKey(toText(r.confidence, 20) || '');
  // Confiance absente ou inconnue : on ne la suppose pas bonne.
  const confidence = conf === 'haute' ? 'haute' : conf === 'moyenne' ? 'moyenne' : 'basse';
  const printed = normKey(toText(r.printedContent, 20) || '');
  // Un verdict tranché donné avec une confiance basse n'est pas fiable : on le rend incertain.
  if (verdict !== 'uncertain' && confidence === 'basse') verdict = 'uncertain';
  // Verdict contredit par le propre constat du modèle sur le contenu imprimé : incertain.
  if (verdict === 'different' && printed !== 'different') verdict = 'uncertain';
  if (verdict === 'same_document' && printed === 'different') verdict = 'uncertain';
  return {
    verdict, confidence,
    reason: toText(r.reason, 240),
    printedContent: toText(r.printedContent, 20),
    physicalAspect: toText(r.physicalAspect, 20)
  };
}

function validImage(b64) {
  return typeof b64 === 'string' && b64.length >= 100 && /^[A-Za-z0-9+/=]+$/.test(b64.slice(0, 2000));
}
function upstreamFailure(res) {
  if (res.network) return jsonResponse({ error: 'upstream_network_error' }, 502);
  return jsonResponse({ error: 'upstream_error', status: res.status, keyProblem: !!res.keyProblem, model: res.model || null, detail: res.detail || '' }, 502);
}

/* ----------------------------- point d'entrée ----------------------------- */

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method === 'GET') {
    // Simple contrôle « le service est en ligne » : ne révèle aucune clé.
    return jsonResponse({ ok: true, service: VERSION });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  const sharedKey = env && env.APP_SHARED_KEY;
  const geminiKey = env && (env.GEMINI_API_KEY || env.GEMINI_KEY || env.GOOGLE_API_KEY);
  if (!sharedKey || !geminiKey) {
    return jsonResponse({ error: 'server_misconfigured' }, 500);
  }
  if (!safeEqual(request.headers.get('X-App-Key'), sharedKey)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let payload;
  try { payload = await request.json(); } catch (_) { return jsonResponse({ error: 'bad_request' }, 400); }
  if (!payload || typeof payload !== 'object') return jsonResponse({ error: 'bad_request' }, 400);

  /* ----- mode « compare » : deux photos, même ticket ou non ? ----- */
  if (payload.mode === 'compare') {
    const a = payload.imageA, b = payload.imageB;
    if (!validImage(a) || !validImage(b)) return jsonResponse({ error: 'bad_request', detail: 'deux images attendues' }, 400);
    if (a.length + b.length > MAX_IMAGE_BASE64_LENGTH) return jsonResponse({ error: 'image_too_large' }, 413);
    const res = await askModels(geminiKey, [{ mimeType: 'image/jpeg', data: a }, { mimeType: 'image/jpeg', data: b }], COMPARE_PROMPT);
    if (!res.ok) return upstreamFailure(res);
    const out = normalizeCompare(res.parsed);
    out.model = res.model;
    out.service = VERSION;
    return jsonResponse(out);
  }

  /* ----- mode par défaut : lecture d'un ticket ----- */
  const imageBase64 = payload.imageBase64;
  if (!validImage(imageBase64)) {
    return jsonResponse({ error: 'bad_request', detail: 'image manquante' }, 400);
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
    return jsonResponse({ error: 'image_too_large' }, 413);
  }
  const mimeType = /^image\/(jpeg|png|webp|heic|heif)$/.test(payload.mimeType || '') ? payload.mimeType : 'image/jpeg';

  const res = await askModels(geminiKey, [{ mimeType, data: imageBase64 }], PROMPT + (payload.retry ? RETRY_ADDENDUM : ''));
  if (!res.ok) return upstreamFailure(res);

  const out = normalizeResult(res.parsed);
  out.model = res.model;
  out.service = VERSION;
  return jsonResponse(out);
}

export default {
  async fetch(request, env) {
    // Toute erreur imprévue repart en JSON avec les en-têtes CORS : sans cela,
    // l'appli afficherait à tort « Pas de connexion ».
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return jsonResponse({ error: 'worker_exception', detail: String((e && e.message) || e).slice(0, 200) }, 500);
    }
  }
};
