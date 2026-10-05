/**
 * Prime Token — Économie serveur (coins, snipes, VIP, avatars, matchs, tournois)
 * ================================================================
 * Avant ce fichier, TOUT l'argent du site (coins, snipes, VIP, avatars,
 * mise de match, gains, tournois) était calculé et écrit directement par
 * le navigateur de chaque joueur dans Firestore. Les règles Firestore
 * empêchaient bien les inconnus non connectés d'écrire, MAIS un joueur
 * connecté pouvait ouvrir la console de son navigateur et modifier SON
 * PROPRE document (son solde, ses avatars, son statut VIP...) directement,
 * ou même celui d'un autre joueur via le champ "coins" qui était ouvert en
 * écriture à n'importe quel compte connecté (pensé à l'origine seulement
 * pour les tips).
 *
 * Désormais, les règles Firestore (voir firestore.rules) INTERDISENT à
 * absolument tout le monde (même admin) d'écrire directement les champs
 * "argent" d'un document utilisateur (coins, snipes, ownedAvatars,
 * vipUntil, stats, history, ...) ou les champs "résultat" d'un match
 * (results, completed, victoryClaim, cancelled, escrowedBy, ...). La
 * SEULE façon de les modifier est d'appeler une des fonctions de ce
 * fichier, qui tourne sur les serveurs Google (jamais sur l'ordinateur
 * du joueur) avec les droits d'administrateur Firestore (Admin SDK, qui
 * ignore les règles) — et qui, avant de toucher au moindre coin,
 * revérifie TOUT elle-même : solde suffisant, prix réel, joueur
 * réellement participant au match, etc.
 * ================================================================
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

module.exports = function (admin, db) {
  const FieldValue = admin.firestore.FieldValue;

  /* ============ constantes économiques — DOIVENT rester identiques
     à celles utilisées côté site (index.html) pour l'affichage ============ */
  const TEAM_SIZE_MAX = { "2v2": 2, "3v3": 3, "4v4": 4 };
  const SUPER_ADMIN = "Ryven";
  const AVATAR_PRICES = {
    reaper: 1, ranger: 1, frostmage: 2, infernofox: 4, strawvoyager: 4, pharaohfox: 4, greenblade: 3,
  };
  const SNIPE_COST_COINS = 2;
  const SNIPE_BUNDLE_QTY = 20;
  const RESET_STATS_COST_COINS = 3;
  const CUSTOM_AVATAR_COST_COINS = 5;
  const VIP_COST_COINS = 3;
  const VIP_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
  const VIP_SNIPE_BONUS = 20;
  const WHEEL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const WHEEL_SEGMENTS = [
    { type: "coins", amount: 0.5 }, { type: "snipes", amount: 1 }, { type: "snipes", amount: 2 },
    { type: "coins", amount: 1 }, { type: "snipes", amount: 1 }, { type: "snipes", amount: 3 },
    { type: "avatar" }, { type: "snipes", amount: 1 },
  ];
  const VICTORY_TIMER_MS = 15 * 60 * 1000;
  const VIP_VICTORY_TIMER_MS = 5 * 60 * 1000;
  const MATCH_TTL_MS = 30 * 60 * 1000;
  const RP_PER_WIN = 10;
  // Taxe de plateforme sur les gains de match : le gagnant touche 95% de ce
  // qu'il aurait normalement reçu (mise récupérée + part du pot adverse),
  // les 5% restants ne sont crédités nulle part — comme les frais sur les
  // tips. S'applique à TOUT LE MONDE, y compris les VIP (contrairement aux
  // frais de tip). DOIT rester identique à MATCH_TAX_RATE côté site
  // (index.html, uniquement pour l'affichage — le vrai calcul ne vit qu'ici).
  const MATCH_TAX_RATE = 0.05;
  const EMPTY_STATS = { played: 0, wins: 0, losses: 0, streak: 0, bestStreak: 0, totalEarned: 0, highestMatchEarning: 0 };
  // v4 : reset forcé de tous les comptes (0 coin, 0 snipe, plus de VIP) —
  // DOIT rester identique à ECO_RESET_VERSION côté site (index.html).
  const ECO_RESET_VERSION = 4;

  // Identifiant de document sûr (pas de "/", "..", objets, textes géants).
  function cleanId(x) {
    if (typeof x !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(x) || /^__.*__$/.test(x)) throw new HttpsError("invalid-argument", "Invalid id.");
    return x;
  }
  function roundToCents(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  function requireAuth(request) {
    if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "You must be logged in.");
    return request.auth.uid;
  }

  async function getMe(uid) {
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
    return { ref: snap.ref, data: snap.data() };
  }

  /* =========================================================
     IDENTITÉ — À QUI APPARTIENT UN PSEUDO ?
     Le pseudo est écrit par le site lui-même à l'inscription, et l'unicité
     n'y est vérifiée que côté navigateur. Quelqu'un qui appelle Firebase à
     la main (sans passer par le site) peut donc créer un 2e compte nommé
     "Ryven" — et avant, le serveur l'aurait cru admin (et lui aurait aussi
     versé les gains de match du vrai joueur du même nom).
     Règle désormais : le VRAI propriétaire d'un pseudo est le compte
     Firebase Auth le plus ANCIEN qui le porte (date de création fixée par
     Google, impossible à falsifier). C'est mémorisé une fois pour toutes
     dans usernameOwners/{pseudo}, une collection que seul le serveur écrit.
     Un compte "copie" est refusé partout où il y a de l'argent ou des
     droits admin.
  ========================================================= */
  function usernameKey(username) { return "u_" + encodeURIComponent(String(username)); }
  const ownerCache = new Map();
  async function ownerUidOf(username) {
    if (!username || typeof username !== "string" || username.length > 40) return null;
    if (ownerCache.has(username)) return ownerCache.get(username);
    const claimRef = db.collection("usernameOwners").doc(usernameKey(username));
    let claim = await claimRef.get();
    if (!claim.exists) {
      const snap = await db.collection("users").where("username", "==", username).get();
      if (snap.empty) return null;
      // Le 1er PROFIL créé avec ce pseudo le garde (date de création Firestore,
      // impossible à falsifier). Le compte Auth doit exister.
      let best = null, bestT = Infinity, bestA = Infinity;
      for (const d of snap.docs) {
        let a;
        try { a = Date.parse((await admin.auth().getUser(d.id)).metadata.creationTime); } catch (e) { continue; }
        if (!Number.isFinite(a)) a = Infinity;
        const t = d.createTime ? d.createTime.toMillis() : Infinity;
        // 1) profil le plus ancien ; 2) à égalité, compte Auth le plus ancien.
        if (t < bestT || (t === bestT && (a < bestA || (a === bestA && (best === null || d.id < best))))) { bestT = t; bestA = a; best = d.id; }
      }
      if (!best) return null;
      try { await claimRef.create({ uid: best, username, at: Date.now() }); } catch (e) { /* créé en parallèle : on relit */ }
      await claimLower(username);
      claim = await claimRef.get();
    }
    const owner = claim.exists ? claim.data().uid : null;
    if (owner) {
      ownerCache.set(username, owner);
      await claimLower(username);
    }
    return owner;
  }

  // Pseudo libre ? (insensible aux majuscules) — utilisé par le site à l'inscription.
  const usernameAvailable = onCall(async (request) => {
    const name = String((request.data || {}).username || "").trim();
    if (!/^[A-Za-z0-9_.\- ]{3,20}$/.test(name)) return { available: false, reason: "invalid" };
    const lower = await db.collection("usernameLower").doc(usernameKey(name.toLowerCase())).get();
    if (lower.exists) return { available: false };
    const exact = await db.collection("users").where("username", "in", caseVariants(name)).limit(1).get();
    return { available: exact.empty };
  });
  // Trouver le vrai pseudo d'un joueur, quelle que soit la casse (recherche, invitations).
  const lookupUsername = onCall(async (request) => {
    requireAuth(request);
    const r = await resolveUsernameLoose(String((request.data || {}).username || "").trim());
    return r ? { uid: r.uid, username: r.username } : { uid: null };
  });

  /* Liste des UID modérateurs + propriétaire, pour les règles Firestore
     (serverConfig/moderatorUids : écrit seulement par le serveur). */
  async function syncModeratorUids() {
    const names = await serverModerators();
    const ownerUid = await ownerUidOf(SUPER_ADMIN);
    const uids = [];
    for (const n of names) { const u = await ownerUidOf(n); if (u) uids.push(u); }
    if (ownerUid) uids.push(ownerUid);
    await db.collection("serverConfig").doc("moderatorUids").set({ uids: [...new Set(uids)], ownerUid: ownerUid || null, updatedAt: Date.now() });
  }

  // Pseudo écrit avec d'autres majuscules ("hal" pour "Hal") → vrai pseudo.
  async function resolveUsernameLoose(name) {
    if (typeof name !== "string" || !name || name.length > 40) return null;
    const exact = await ownerUidOf(name);
    if (exact) return { uid: exact, username: name };
    await claimLower(name);
    const lower = await db.collection("usernameLower").doc(usernameKey(name.toLowerCase())).get();
    if (lower.exists && (await ownerUidOf(lower.data().username)) === lower.data().uid) return { uid: lower.data().uid, username: lower.data().username };
    return null;
  }

  // Variantes de casse courantes d'un pseudo ("hal", "HAL", "Hal"...).
  function caseVariants(name) {
    const l = name.toLowerCase();
    return [...new Set([name, l, name.toUpperCase(), l.charAt(0).toUpperCase() + l.slice(1)])];
  }
  // Index insensible aux majuscules : appartient au PROFIL le plus ancien
  // parmi toutes les variantes de casse ("Hal" créé avant "hAL" garde "hal").
  async function claimLower(username) {
    const ref = db.collection("usernameLower").doc(usernameKey(username.toLowerCase()));
    if ((await ref.get()).exists) return;
    const snap = await db.collection("users").where("username", "in", caseVariants(username)).get();
    let best = null, bestT = Infinity;
    snap.forEach((d) => { const t = d.createTime ? d.createTime.toMillis() : Infinity; if (t < bestT) { bestT = t; best = d; } });
    if (!best) return;
    try { await ref.create({ uid: best.id, username: best.data().username, at: Date.now() }); } catch (e) { /* créé en parallèle */ }
  }

  /* Adresse mail vérifiée : obligatoire pour les comptes créés APRÈS cette
     date (les comptes plus anciens n'ont jamais reçu de mail de
     vérification, on ne les bloque pas). Un compte déjà vérifié est mémorisé. */
  const EMAIL_VERIFY_START_MS = Date.parse("2026-10-05T07:30:00Z");
  const emailOkCache = new Set();
  async function emailStatusOf(uid) {
    if (emailOkCache.has(uid)) return { required: true, verified: true };
    let rec;
    try { rec = await admin.auth().getUser(uid); }
    catch (e) { logger.warn("email check: getUser failed", { uid, error: e.message }); return { required: false, verified: true }; }
    const created = Date.parse(rec.metadata && rec.metadata.creationTime);
    const required = Number.isFinite(created) && created >= EMAIL_VERIFY_START_MS;
    const verified = !required || rec.emailVerified === true;
    if (required && verified) emailOkCache.add(uid);
    return { required, verified };
  }
  const emailVerificationStatus = onCall(async (request) => {
    const uid = requireAuth(request);
    return emailStatusOf(uid);
  });

  /* Profil de l'appelant + vérifs : pas banni, et il est bien le vrai
     propriétaire de son pseudo. À utiliser partout où il y a de l'argent. */
  async function getVerifiedMe(uid, opts) {
    const me = await getMe(uid);
    const d = me.data;
    if (!d.username) throw new HttpsError("failed-precondition", "Profile not found.");
    if (opts && opts.allowBanned) {
      if ((await ownerUidOf(d.username)) !== uid) throw new HttpsError("permission-denied", "This username belongs to another account. Contact support on Discord.");
      return me;
    }
    if (d.stats && (d.ecoResetVersion || 0) < ECO_RESET_VERSION) throw new HttpsError("failed-precondition", "Please reload the page and try again.");
    if (d.banned) throw new HttpsError("permission-denied", "Your account is banned.");
    if (d.banUntil && d.banUntil > Date.now()) throw new HttpsError("permission-denied", "Your account is temporarily banned.");
    if ((await ownerUidOf(d.username)) !== uid) {
      throw new HttpsError("permission-denied", "This username belongs to another account. Contact support on Discord.");
    }
    const es = await emailStatusOf(uid);
    if (!es.verified) throw new HttpsError("failed-precondition", "Please verify your email address first (check your inbox and spam folder), then reload the page.");
    return me;
  }

  /* Liste des modérateurs qui fait foi pour le serveur : serverConfig/
     moderators (écrite UNIQUEMENT par adminSetModerator ci-dessous). La
     liste config/moderators reste pour l'affichage du site. Au premier
     appel, si la liste serveur n'existe pas encore, elle est initialisée
     avec les modérateurs actuels. */
  async function serverModerators() {
    const ref = db.collection("serverConfig").doc("moderators");
    const snap = await ref.get();
    if (snap.exists) return snap.data().usernames || [];
    const legacy = await db.collection("config").doc("moderators").get();
    const list = (legacy.exists && legacy.data().usernames) || [];
    await ref.set({ usernames: list, initializedAt: Date.now() });
    return list;
  }

  /* "owner" (Ryven), "mod", ou null — toujours vérifié par UID. */
  async function adminLevelOf(uid, username) {
    if (!username) return null;
    let level = null;
    if (username === SUPER_ADMIN) level = "owner";
    else if ((await serverModerators()).includes(username)) level = "mod";
    if (!level) return null;
    if ((await ownerUidOf(username)) !== uid) return null;
    return level;
  }

  async function requireAdmin(uid) {
    const me = await getMe(uid);
    if (me.data.banned || (me.data.banUntil && me.data.banUntil > Date.now()) || !(await adminLevelOf(uid, me.data.username))) {
      throw new HttpsError("permission-denied", "Moderators only.");
    }
    try {
      const mu = await db.collection("serverConfig").doc("moderatorUids").get();
      if (!mu.exists || !(mu.data().uids || []).includes(uid)) await syncModeratorUids();
    } catch (e) { logger.warn("syncModeratorUids failed", { error: e.message }); }
    return me;
  }

  async function requireOwner(uid) {
    const me = await getMe(uid);
    if ((await adminLevelOf(uid, me.data.username)) !== "owner") {
      throw new HttpsError("permission-denied", "Owner only.");
    }
    try {
      const mu = await db.collection("serverConfig").doc("moderatorUids").get();
      if (!mu.exists || mu.data().ownerUid !== uid) await syncModeratorUids();
    } catch (e) { logger.warn("syncModeratorUids failed", { error: e.message }); }
    return me;
  }

  /* Journal de toutes les actions admin qui touchent à l'argent. */
  async function adminLog(byUid, byUsername, action, details) {
    try {
      await db.collection("adminLogs").add({ byUid, by: byUsername || null, action, details: details || {}, at: Date.now() });
    } catch (e) { logger.warn("adminLog failed", { error: e.message }); }
  }

  /* Roster qui fait foi pour l'argent. Les champs hostPlayers/guestPlayers
     sont écrits par le site (donc modifiables par un tricheur) : dès que le
     serveur a "figé" le match (serverLock, au moment du verrouillage) ou
     l'a créé lui-même (serverRoster : rematch, tournoi), c'est CETTE copie
     serveur qui est utilisée, plus celle du site. */
  function matchRoster(match) {
    const fixed = (match.serverLock && match.serverLock.hostPlayers) ? match.serverLock
      : (match.serverRoster && match.serverRoster.hostPlayers) ? match.serverRoster : null;
    if (fixed) return { hostPlayers: [...fixed.hostPlayers], guestPlayers: [...(fixed.guestPlayers || [])] };
    const hostPlayers = Array.isArray(match.hostPlayers) ? match.hostPlayers : [match.host];
    const guestPlayers = Array.isArray(match.guestPlayers) ? match.guestPlayers : (match.players || []).filter((p) => p !== match.host);
    return { hostPlayers, guestPlayers };
  }

  const MAX_BET = 10000;
  function betIsValid(match) {
    const bet = Number(match.bet);
    if (match.tournamentId) return bet === 0;
    return Number.isFinite(bet) && bet >= 0.5 && bet <= MAX_BET && roundToCents(bet) === bet;
  }

  /* Le match peut-il donner lieu à un paiement ? Toutes les conditions
     doivent être vraies, sinon on rembourse au lieu de payer :
     - chaque camp est complet (pas plus, pas moins), aucun doublon,
       personne dans les deux camps ;
     - la mise est valide ;
     - CHAQUE joueur a réellement payé sa mise en entier (escrow). */
  function checkPayable(match) {
    const { hostPlayers, guestPlayers } = matchRoster(match);
    const maxPerSide = TEAM_SIZE_MAX[match.teamSize] || 1;
    const all = [...hostPlayers, ...guestPlayers];
    if (hostPlayers.length !== maxPerSide || guestPlayers.length !== maxPerSide) return { ok: false, reason: "roster_incomplete" };
    if (new Set(all).size !== all.length || all.some((p) => !p || typeof p !== "string")) return { ok: false, reason: "roster_invalid" };
    if (!hostPlayers.includes(match.host)) return { ok: false, reason: "host_missing" };
    if (!betIsValid(match)) return { ok: false, reason: "bad_bet" };
    const escrowedBy = match.escrowedBy || [];
    const amounts = match.escrowAmounts || {};
    for (const p of all) {
      const need = computePlayerStake(match, p);
      if (need > 0 && (!escrowedBy.includes(p) || roundToCents(amounts[p] || 0) < need)) {
        return { ok: false, reason: "stake_missing", player: p };
      }
    }
    return { ok: true, hostPlayers, guestPlayers };
  }

  function computePlayerStake(match, username) {
    const baseBet = roundToCents(match.bet !== undefined ? match.bet : 0.5);
    const { hostPlayers } = matchRoster(match);
    const teamSizeCount = TEAM_SIZE_MAX[match.teamSize] || hostPlayers.length || 1;
    const isHostSide = hostPlayers.includes(username);
    const isCoveredTeammate = !!(match.coverBet && isHostSide && username !== match.host && teamSizeCount > 1);
    const isCoveringHost = !!(match.coverBet && isHostSide && username === match.host && teamSizeCount > 1);
    if (isCoveredTeammate) return 0;
    if (isCoveringHost) return roundToCents(baseBet * teamSizeCount);
    return baseBet;
  }

  function computePlayerBetInfo(match, username) {
    const baseBet = roundToCents(match.bet !== undefined ? match.bet : 0.5);
    const stake = computePlayerStake(match, username);
    const winReward = roundToCents(stake + baseBet);
    return { baseBet, stake, winReward };
  }

  /* pseudo -> UID du VRAI propriétaire (voir ownerUidOf). `preferred` :
     UID déjà connus de façon sûre (ceux enregistrés au moment où le
     joueur a payé sa mise), prioritaires. */
  async function resolveUidMap(usernames, preferred) {
    const unique = [...new Set(usernames.filter(Boolean))];
    const map = {};
    for (const u of unique) {
      const known = preferred && preferred[u];
      const uid = known || (await ownerUidOf(u));
      if (uid) map[u] = uid;
    }
    return map;
  }

  /* =========================================================
     MATCHS — tout ce qui touche à l'argent d'un match passe par ici.
     Principe de sécurité (corrigé suite à l'audit) :
       1. On ne paie JAMAIS une mise "partielle" : pas assez de coins =
          refus (avant : le joueur payait ce qu'il avait, même 0, mais
          pouvait gagner la mise complète → coins créés à partir de rien).
       2. Au moment de payer, on revérifie que les deux camps sont complets
          et que CHAQUE joueur a réellement payé sa mise. Sinon on
          rembourse tout le monde au lieu de payer.
       3. Le roster est figé côté serveur au verrouillage (serverLock) :
          modifier hostPlayers/guestPlayers depuis la console du navigateur
          ne change plus rien à qui gagne / qui paie.
  ========================================================= */

  /* CONFIANCE — un match ne fait bouger de l'argent que s'il a été créé
     par le serveur (matchCreate, rematch, tournoi : fiche matchMeta/{id},
     que seul le serveur écrit), ou s'il existait avant cette mise à jour.
     Un document de match fabriqué à la main (avec de faux montants déjà
     "payés", un faux rematch...) ne peut donc plus rien rembourser ni payer. */
  let deployAt = null;
  async function getDeployAt() {
    if (deployAt) return deployAt;
    const ref = db.collection("serverConfig").doc("deploy");
    let snap = await ref.get();
    if (!snap.exists) { try { await ref.create({ firstRunAt: Date.now() }); } catch (e) { /* déjà créé */ } snap = await ref.get(); }
    deployAt = snap.data().firstRunAt;
    return deployAt;
  }
  async function matchTrust(tx, matchId, snap) {
    const meta = await tx.get(db.collection("matchMeta").doc(cleanId(matchId)));
    if (meta.exists) return { trusted: true, meta: meta.data() };
    const created = snap.createTime ? snap.createTime.toMillis() : Infinity;
    const dep = await getDeployAt();
    if (!(created < dep && created > dep - 24 * 3600 * 1000)) return { trusted: false, meta: null };
    // Ancien match : chaque mise reconnue est plafonnée à la mise normale du match,
    // et un pari énorme est mis de côté pour vérification manuelle.
    const m = snap.data();
    if (!(Number(m.bet) <= 200)) {
      try { await db.collection("flaggedMatches").doc(String(matchId)).set({ reason: "legacy_big_bet", bet: m.bet || null, at: Date.now() }, { merge: true }); } catch (e) { /* ignore */ }
      return { trusted: false, meta: null };
    }
    return { trusted: true, meta: null, legacy: true };
  }
  // Version "sans argent" d'un match non fiable : aucune mise reconnue.
  function legacyView(m) {
    const amounts = {};
    Object.entries(m.escrowAmounts || {}).forEach(([u, a]) => { amounts[u] = Math.min(Number(a) || 0, computePlayerStake(m, u)); });
    return { ...m, escrowAmounts: amounts };
  }
  function untrustedView(m) {
    return { ...m, escrowedBy: [], escrowAmounts: {}, escrowUids: {}, refundedBy: [], serverRoster: null, serverTeam: null, rematchOf: null, tournamentId: null };
  }
  // Capitaine d'un camp : le host pour son camp, le 1er invité pour l'autre.
  // Lui seul peut abandonner / déclarer la défaite pour toute son équipe.
  function isCaptain(match, roster, username) {
    if (roster.hostPlayers.includes(username)) return username === match.host;
    return roster.guestPlayers[0] === username;
  }

  function escrowFields(match, username, uid, amount) {
    return {
      escrowedBy: [...new Set([...(match.escrowedBy || []), username])],
      escrowAmounts: { ...(match.escrowAmounts || {}), [username]: amount },
      escrowUids: { ...(match.escrowUids || {}), [username]: uid },
    };
  }

  /* CRÉER un match — par le serveur : il vérifie chaque champ, crée le
     document, la fiche matchMeta et prélève la mise du host en une seule
     transaction. */
  const ALLOWED_TEAM_SIZES = ["1v1", "2v2", "3v3", "4v4"];
  const matchCreate = onCall(async (request) => {
    const uid = requireAuth(request);
    const me0 = await getVerifiedMe(uid);
    const username = me0.data.username;
    const d = request.data || {};
    const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
    const teamSize = ALLOWED_TEAM_SIZES.includes(d.teamSize) ? d.teamSize : null;
    if (!teamSize) throw new HttpsError("invalid-argument", "Invalid team size.");
    if (typeof d.bet !== "number") throw new HttpsError("invalid-argument", "Invalid bet.");
    const bet = roundToCents(d.bet);
    if (!Number.isFinite(bet) || bet < 0.5 || bet > MAX_BET) throw new HttpsError("invalid-argument", "Invalid bet.");
    const visibility = d.visibility === "private" ? "private" : "public";
    const passcode = visibility === "private" ? str(d.passcode, 20) : null;
    if (visibility === "private" && !passcode) throw new HttpsError("invalid-argument", "Enter a code for the private match!");
    const region = str(d.region, 40), platform = str(d.platform, 40), weapon = str(d.weapon, 40), mode = str(d.mode, 40);
    if (!region || !platform || !mode || !weapon) throw new HttpsError("invalid-argument", "Please fill in all fields!");
    const firstTo = Math.min(10, Math.max(1, parseInt(d.firstTo, 10) || 1));
    const kl = parseInt(d.killLead, 10);
    const killLead = Number.isFinite(kl) && kl >= 1 && kl <= firstTo - 1 ? kl : null;
    let team = null, serverTeam = [], coverBet = false;
    if (teamSize !== "1v1") {
      const tSnap = await db.collection("teams").doc(cleanId(d.teamId)).get();
      if (!tSnap.exists) throw new HttpsError("failed-precondition", "Select a team for this team size (or create one)!");
      const t = tSnap.data();
      const members = (Array.isArray(t.members) ? t.members : []).filter((m) => typeof m === "string").slice(0, 8);
      if (!members.includes(username)) throw new HttpsError("permission-denied", "You're not in this team.");
      if (members.length < (TEAM_SIZE_MAX[teamSize] || 1)) throw new HttpsError("failed-precondition", "Your team doesn't have enough players for this team size.");
      team = { id: tSnap.id, name: str(t.name, 40), members };
      serverTeam = members;
      coverBet = !!d.coverBet;
    }
    const active = await db.collection("matches").where("host", "==", username).where("completed", "==", false).get();
    if (active.docs.filter((x) => !x.data().cancelled).length >= 3) {
      throw new HttpsError("failed-precondition", "You already have 3 active matches. Finish or cancel one before creating another.");
    }
    const id = "M-" + Math.random().toString(36).slice(2, 8).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
    const matchRef = db.collection("matches").doc(id);
    const userRef = db.collection("users").doc(uid);
    const st = me0.data.stats || {};
    const doc = {
      id, host: username, hostEpic: str(me0.data.epic, 40) || "N/A",
      hostStats: { played: Number(st.played) || 0, wins: Number(st.wins) || 0, losses: Number(st.losses) || 0 },
      visibility, passcode: null, region, platform, weapon, teamSize, team, coverBet, bet, mode, firstTo, killLead,
      simpleEdit: d.simpleEdit !== false, status: "OPEN",
      players: [username], hostPlayers: [username], guestPlayers: [], readies: {}, results: {}, processedBy: [],
      victoryClaim: null, disputed: false, proofs: {}, chat: [], locked: false, completed: false, active: true,
      createdAt: Date.now(), escrowedBy: [], escrowAmounts: {}, escrowUids: {}, serverTeam,
    };
    const stake = computePlayerStake(doc, username);
    await db.runTransaction(async (tx) => {
      const us = await tx.get(userRef);
      const coins = (us.data() || {}).coins || 0;
      if (coins < stake) throw new HttpsError("failed-precondition", `Not enough coins — this match needs ${stake}. You have ${roundToCents(coins)}.`);
      if (stake > 0) tx.update(userRef, { coins: roundToCents(coins - stake) });
      tx.create(matchRef, { ...doc, ...escrowFields(doc, username, uid, stake) });
      tx.create(db.collection("matchMeta").doc(id), { by: uid, at: Date.now(), passcode: passcode || null });
    });
    return { ok: true, id, stake, passcode };
  });

  /* REJOINDRE un match — fait côté serveur, en une seule transaction :
     vérifie la place libre, le code privé, le solde, puis ajoute le joueur
     au bon camp ET débite sa mise. Plus de course entre deux joueurs qui
     rejoignent en même temps (avant, le 2e écrasait le 1er). */
  const matchJoin = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId: rawId, passcode } = request.data || {};
    const matchId = cleanId(rawId);
    if (!matchId) throw new HttpsError("invalid-argument", "matchId is required.");
    const me0 = await getVerifiedMe(uid);
    const username = me0.data.username;
    const matchRef = db.collection("matches").doc(matchId);
    const userRef = db.collection("users").doc(uid);

    // Équipe du host (pour savoir de quel côté je rejoins) — lue hors transaction.
    const pre = await matchRef.get();
    if (!pre.exists) throw new HttpsError("not-found", "Match not found.");
    // Camp du host = équipe FIGÉE par le serveur quand le host a payé
    // (serverTeam). Plus jamais lue depuis le document "teams" ou le champ
    // "team" du match, modifiables par n'importe qui.
    const pd = pre.data();
    const teamMembers = Array.isArray(pd.serverTeam) ? pd.serverTeam
      : (pd.team && Array.isArray(pd.team.members) && !(pd.escrowedBy || []).length ? pd.team.members : []);

    return db.runTransaction(async (tx) => {
      const [matchSnap, userSnap] = await Promise.all([tx.get(matchRef), tx.get(userRef)]);
      if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = matchSnap.data();
      const me = userSnap.data() || {};
      const trust = await matchTrust(tx, matchId, matchSnap);
      if (!trust.trusted) throw new HttpsError("failed-precondition", "This match can't be joined.");
      if (match.completed || match.cancelled) throw new HttpsError("failed-precondition", "This match is over.");
      if (match.serverLock) throw new HttpsError("failed-precondition", "This match is already locked.");
      if (match.tournamentId || match.serverRoster) throw new HttpsError("failed-precondition", "This match can't be joined.");
      const realCode = (trust.meta && trust.meta.passcode !== undefined) ? trust.meta.passcode : match.passcode;
      if (match.visibility === "private" && String(passcode || "") !== String(realCode || "")) {
        throw new HttpsError("permission-denied", "Incorrect code!");
      }
      if (!betIsValid(match)) throw new HttpsError("failed-precondition", "This match has an invalid bet.");

      const { hostPlayers, guestPlayers } = matchRoster(match);
      if (hostPlayers.includes(username) || guestPlayers.includes(username)) {
        return { ok: true, already: true };
      }
      const maxPerSide = TEAM_SIZE_MAX[match.teamSize] || 1;
      const onHostTeam = teamMembers.includes(username);
      const newHost = onHostTeam ? [...hostPlayers, username] : [...hostPlayers];
      const newGuest = onHostTeam ? [...guestPlayers] : [...guestPlayers, username];
      if (onHostTeam && hostPlayers.length >= maxPerSide) throw new HttpsError("failed-precondition", "Your team's side is already full!");
      if (!onHostTeam && guestPlayers.length >= maxPerSide) throw new HttpsError("failed-precondition", "Match full!");

      const after = { ...match, hostPlayers: newHost, guestPlayers: newGuest };
      if ((match.escrowedBy || []).includes(username)) {
        tx.update(matchRef, { hostPlayers: newHost, guestPlayers: newGuest, players: [...newHost, ...newGuest] });
        return { ok: true, stake: 0, side: onHostTeam ? "host" : "guest" };
      }
      const stake = computePlayerStake(after, username);
      const coins = me.coins || 0;
      if (coins < stake) {
        throw new HttpsError("failed-precondition", `Not enough coins — this match needs ${stake}. You have ${roundToCents(coins)}.`);
      }
      if (stake > 0) tx.update(userRef, { coins: roundToCents(coins - stake) });
      tx.update(matchRef, {
        hostPlayers: newHost, guestPlayers: newGuest, players: [...newHost, ...newGuest],
        ...escrowFields(match, username, uid, stake), active: true,
      });
      return { ok: true, stake, side: onHostTeam ? "host" : "guest" };
    });
  });

  /* ESCROW — débite la mise d'UN joueur déjà dans le roster (le host à la
     création, chacun des joueurs d'un rematch). Idempotente. Refuse si le
     solde ne couvre pas la mise ENTIÈRE. */
  const matchEscrow = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = cleanId((request.data || {}).matchId);
    if (!matchId) throw new HttpsError("invalid-argument", "matchId is required.");
    const me0 = await getVerifiedMe(uid);
    const username = me0.data.username;
    const matchRef = db.collection("matches").doc(matchId);
    const userRef = db.collection("users").doc(uid);

    return db.runTransaction(async (tx) => {
      const [matchSnap, userSnap] = await Promise.all([tx.get(matchRef), tx.get(userRef)]);
      if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = matchSnap.data();
      const me = userSnap.data() || {};
      const trust = await matchTrust(tx, matchId, matchSnap);
      if (match.completed || match.cancelled) return { ok: true, skipped: "over" };
      if (!trust.trusted) throw new HttpsError("permission-denied", "This match can't take your bet.");

      const escrowedBy = match.escrowedBy || [];
      if (escrowedBy.includes(username)) return { ok: true, alreadyEscrowed: true };
      if (match.serverLock) throw new HttpsError("failed-precondition", "This match is already locked.");

      const { hostPlayers, guestPlayers } = matchRoster(match);
      if (!hostPlayers.includes(username) && !guestPlayers.includes(username)) {
        throw new HttpsError("permission-denied", "You're not part of this match.");
      }
      // Un roster écrit par le navigateur peut contenir n'importe qui : on
      // ne prélève donc que le host, ou un joueur d'un roster fixé par le
      // serveur (rematch). Les autres passent par matchJoin.
      if (username !== match.host && !match.serverRoster) {
        throw new HttpsError("permission-denied", "Join the match with the Join button.");
      }
      if (username !== match.host && !(trust.meta && trust.meta.rematchOf)) {
        // Seul un vrai rematch (fiche écrite par le serveur) prélève les autres joueurs.
        throw new HttpsError("permission-denied", "This match can't take your bet.");
      }
      const maxPerSide = TEAM_SIZE_MAX[match.teamSize] || 1;
      if (hostPlayers.length > maxPerSide || guestPlayers.length > maxPerSide) {
        throw new HttpsError("failed-precondition", "This match has too many players.");
      }
      if (!betIsValid(match)) throw new HttpsError("failed-precondition", "This match has an invalid bet.");

      const stake = computePlayerStake(match, username);
      const coins = me.coins || 0;
      if (coins < stake) {
        throw new HttpsError("failed-precondition", `Not enough coins — this match needs ${stake}. You have ${roundToCents(coins)}.`);
      }
      if (stake > 0) tx.update(userRef, { coins: roundToCents(coins - stake) });
      const upd = escrowFields(match, username, uid, stake);
      if (username === match.host && !match.serverTeam) {
        const members = (match.team && Array.isArray(match.team.members)) ? match.team.members : [];
        upd.serverTeam = members.filter((m) => typeof m === "string").slice(0, 8);
      }
      upd.active = true;
      tx.update(matchRef, upd);
      return { ok: true, stake };
    });
  });

  /* Fige le match côté serveur (serverLock) quand : les deux camps sont
     complets, tout le monde est prêt et tout le monde a payé. Appelée par
     le site au moment du verrouillage, et en secours par la déclaration de
     résultat si le site ne l'a pas fait. Retourne null si c'est bon, sinon
     la raison. Utilisable seulement DANS une transaction. */
  function serverLockUpdate(match, { requireReady }) {
    const chk = checkPayable(match);
    if (!chk.ok) return { error: chk.reason };
    const all = [...chk.hostPlayers, ...chk.guestPlayers];
    const readies = match.readies || {};
    if (requireReady && !all.every((p) => readies[p])) return { error: "not_ready" };
    return { update: { locked: true, serverLock: { hostPlayers: chk.hostPlayers, guestPlayers: chk.guestPlayers, at: Date.now() } } };
  }

  const matchTryLock = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = cleanId((request.data || {}).matchId);
    const me = await getVerifiedMe(uid);
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = snap.data();
      if (match.completed || match.cancelled) return { ok: true, locked: false, reason: "over" };
      if (match.serverLock) return { ok: true, locked: true };
      const trust = await matchTrust(tx, matchId, snap);
      if (!trust.trusted) return { ok: true, locked: false, reason: "untrusted" };
      const { hostPlayers, guestPlayers } = matchRoster(match);
      if (![...hostPlayers, ...guestPlayers].includes(username)) throw new HttpsError("permission-denied", "Not part of this match.");
      const res = serverLockUpdate(match, { requireReady: true });
      if (res.error) return { ok: true, locked: false, reason: res.error };
      tx.update(matchRef, res.update);
      return { ok: true, locked: true };
    });
  });

  /* Rembourse, DANS une transaction déjà ouverte, tous ceux qui ont payé
     et n'ont pas encore été remboursés. Aucune lecture ici (uidMap déjà
     calculé) — compatible avec la règle "toutes les lectures avant les
     écritures" des transactions Firestore. */
  function writeRefunds(tx, matchRef, m, uidMap, extra) {
    const escrowedBy = m.escrowedBy || [];
    const refundedBy = m.refundedBy || [];
    const toRefund = escrowedBy.filter((u) => !refundedBy.includes(u));
    for (const uname of toRefund) {
      const amount = roundToCents((m.escrowAmounts && m.escrowAmounts[uname]) || 0);
      const uid = uidMap[uname];
      if (uid && amount > 0) tx.set(db.collection("users").doc(uid), { coins: FieldValue.increment(amount) }, { merge: true });
    }
    tx.update(matchRef, { cancelled: true, active: false, refundedBy: [...refundedBy, ...toRefund], ...(extra || {}) });
  }

  /* =========================================================
     FINALISATION — paie le résultat d'un match. `spec` désigne le camp
     gagnant via un joueur : { winner: "pseudo" } ou { loser: "pseudo" }.
     Le camp est recalculé ICI, dans la transaction, à partir du roster
     figé — jamais à partir d'une liste fournie de l'extérieur.
     Si le match n'est pas "payable" (camp incomplet, mise manquante...),
     tout le monde est remboursé et le match est annulé. Idempotente.
  ========================================================= */
  async function finalizeMatch(matchId, spec) {
    const matchRef = db.collection("matches").doc(matchId);
    return db.runTransaction(async (tx) => {
      const matchSnap = await tx.get(matchRef);
      if (!matchSnap.exists) return { status: "gone" };
      const raw = matchSnap.data();
      if (raw.completed || raw.cancelled) return { status: "over" };
      const trust = await matchTrust(tx, matchId, matchSnap);
      const match = !trust.trusted ? untrustedView(raw) : trust.legacy ? legacyView(raw) : raw;
      if (spec && spec.fromSweep) {
        const rep = match.cheaterReport;
        if (!match.victoryClaim || match.victoryClaim.by !== spec.winner || match.disputed ||
            (rep && (rep.status === "pending" || rep.status === "confirmed")) ||
            Date.now() - match.victoryClaim.at < (match.victoryClaim.timerMs || VICTORY_TIMER_MS)) {
          return { status: "skipped" };
        }
        // Le joueur qui réclame la victoire a été banni entre-temps : pas de
        // paiement automatique, le match passe en litige pour le staff.
        const cm = await resolveUidMap([spec.winner], match.escrowUids || {});
        const cUid = cm[spec.winner];
        const cSnap = cUid ? await tx.get(db.collection("users").doc(cUid)) : null;
        if (cSnap && cSnap.exists && cSnap.data().banned) {
          tx.update(matchRef, { disputed: true, disputeReason: "claimant_banned" });
          return { status: "frozen" };
        }
      }

      const chk = checkPayable(match);
      const everyone = [...new Set([...(match.escrowedBy || []), ...(chk.ok ? [...chk.hostPlayers, ...chk.guestPlayers] : [])])];
      const uidMap = await resolveUidMap(everyone, match.escrowUids || {});

      if (!chk.ok) {
        logger.warn("finalize refused, refunding", { matchId, reason: chk.reason, player: chk.player || null });
        writeRefunds(tx, matchRef, match, uidMap, { cancelReason: "invalid_" + chk.reason });
        return { status: "refunded", reason: chk.reason };
      }

      const { hostPlayers, guestPlayers } = chk;
      let hostWins;
      if (spec && spec.winner && hostPlayers.includes(spec.winner)) hostWins = true;
      else if (spec && spec.winner && guestPlayers.includes(spec.winner)) hostWins = false;
      else if (spec && spec.loser && hostPlayers.includes(spec.loser)) hostWins = false;
      else if (spec && spec.loser && guestPlayers.includes(spec.loser)) hostWins = true;
      else throw new HttpsError("invalid-argument", "Unknown player for this match.");
      const winners = hostWins ? hostPlayers : guestPlayers;
      const losers = hostWins ? guestPlayers : hostPlayers;
      const all = [...winners, ...losers];

      // Lectures (toutes avant les écritures).
      const userRefs = {};
      const userData = {};
      for (const uname of all) {
        const uid = uidMap[uname];
        if (!uid) continue;
        const ref = db.collection("users").doc(uid);
        const snap = await tx.get(ref);
        if (!snap.exists) continue;
        userRefs[uname] = ref;
        userData[uname] = snap.data();
      }
      // Équipe du host (matchs en équipe) : ses stats sont mises à jour aussi.
      let teamRef = null;
      const tid = match.team && typeof match.team.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(match.team.id) ? match.team.id : null;
      if (tid && match.teamSize && match.teamSize !== "1v1") {
        const tSnap = await tx.get(db.collection("teams").doc(tid));
        if (tSnap.exists) teamRef = tSnap.ref;
      }

      // Garde-fou : on ne distribue JAMAIS plus que ce qui a réellement
      // été mis en jeu (moins la taxe).
      const amounts = match.escrowAmounts || {};
      const pot = roundToCents(all.reduce((s, u) => s + (Number(amounts[u]) || 0), 0));
      const rewards = {};
      let totalRewards = 0;
      for (const uname of winners) {
        const info = computePlayerBetInfo(match, uname);
        // Arrondi au centime inférieur : la somme des gains ne dépasse jamais 95 % du pot.
        rewards[uname] = Math.floor(Math.round(info.winReward * 100) * (1 - MATCH_TAX_RATE) + 1e-6) / 100;
        totalRewards += rewards[uname];
      }
      if (Math.round(totalRewards * 100) > Math.round(pot * 100 * (1 - MATCH_TAX_RATE)) + 1) {
        logger.error("payout exceeds pot, refunding", { matchId, pot, totalRewards });
        writeRefunds(tx, matchRef, match, uidMap, { cancelReason: "payout_exceeds_pot" });
        return { status: "refunded", reason: "payout_exceeds_pot" };
      }

      const results = {};
      winners.forEach((u) => { results[u] = "WIN"; });
      losers.forEach((u) => { results[u] = "LOSS"; });

      for (const uname of winners) {
        const ref = userRefs[uname];
        if (!ref) continue;
        const data = userData[uname];
        const info = computePlayerBetInfo(match, uname);
        const reward = rewards[uname];
        const profit = roundToCents(reward - info.stake);
        const stats = data.stats || EMPTY_STATS;
        const newStreak = (stats.streak || 0) + 1;
        const history = (data.history || []).slice(0, 299);
        history.unshift({ mode: match.mode || null, teamSize: match.teamSize || null, result: "WIN", date: Date.now(), matchId });
        tx.update(ref, {
          coins: roundToCents((data.coins || 0) + reward),
          stats: {
            ...stats,
            played: (stats.played || 0) + 1,
            wins: (stats.wins || 0) + 1,
            streak: newStreak,
            bestStreak: Math.max(stats.bestStreak || 0, newStreak),
            totalEarned: roundToCents((stats.totalEarned || 0) + profit),
            highestMatchEarning: Math.max(stats.highestMatchEarning || 0, profit),
          },
          rp: FieldValue.increment(RP_PER_WIN),
          history,
        });
      }
      for (const uname of losers) {
        const ref = userRefs[uname];
        if (!ref) continue;
        const data = userData[uname];
        const info = computePlayerBetInfo(match, uname);
        const stats = data.stats || EMPTY_STATS;
        const history = (data.history || []).slice(0, 299);
        history.unshift({ mode: match.mode || null, teamSize: match.teamSize || null, result: "LOSS", date: Date.now(), matchId });
        tx.update(ref, {
          stats: {
            ...stats,
            played: (stats.played || 0) + 1,
            losses: (stats.losses || 0) + 1,
            streak: 0,
            totalEarned: roundToCents((stats.totalEarned || 0) - info.stake),
          },
          history,
        });
      }

      // Quelqu'un qui avait payé mais n'est plus dans le roster (retiré
      // entre-temps) : on lui rend sa mise au lieu de la perdre.
      const refundedBy = [...(match.refundedBy || [])];
      for (const uname of (match.escrowedBy || [])) {
        if (all.includes(uname) || refundedBy.includes(uname)) continue;
        const amount = roundToCents(Number(amounts[uname]) || 0);
        const uid = uidMap[uname];
        if (uid && amount > 0) tx.set(db.collection("users").doc(uid), { coins: FieldValue.increment(amount) }, { merge: true });
        refundedBy.push(uname);
      }

      if (teamRef) {
        const hostStake = hostPlayers.reduce((sum, u) => sum + computePlayerBetInfo(match, u).stake, 0);
        const hostGain = hostWins ? hostPlayers.reduce((sum, u) => sum + (rewards[u] || 0), 0) : 0;
        tx.update(teamRef, {
          "stats.wins": FieldValue.increment(hostWins ? 1 : 0),
          "stats.losses": FieldValue.increment(hostWins ? 0 : 1),
          "stats.earnings": FieldValue.increment(roundToCents(hostGain - hostStake)),
        });
      }

      tx.update(matchRef, {
        results, completed: true, active: false, victoryClaim: null, disputed: false, refundedBy, pot, finalizedAt: Date.now(),
        locked: true, serverLock: match.serverLock || { hostPlayers, guestPlayers, at: Date.now() },
      });
      return { status: "finalized" };
    });
  }

  /* Rembourse tout le monde (annulation). Idempotente. */
  async function refundMatch(matchId, reason) {
    const matchRef = db.collection("matches").doc(matchId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) return;
      const trust = await matchTrust(tx, matchId, snap);
      const m = !trust.trusted ? untrustedView(snap.data()) : trust.legacy ? legacyView(snap.data()) : snap.data();
      if (m.completed) return; // déjà payé : on ne rembourse pas en plus
      if (m.cancelled && !(m.escrowedBy || []).some((u) => !(m.refundedBy || []).includes(u))) return;
      // Expiration (30 min) : seulement un match jamais verrouillé par le serveur.
      if (reason === "expired" && (m.serverLock || m.victoryClaim || m.disputed)) return;
      // Match abandonné (6 h) : pas si un résultat ou un signalement est en cours.
      if (reason === "stale_no_result" && (m.victoryClaim || m.disputed || (m.cheaterReport && m.cheaterReport.status === "pending"))) return;
      const uidMap = await resolveUidMap(m.escrowedBy || [], m.escrowUids || {});
      writeRefunds(tx, matchRef, m, uidMap, reason ? { cancelReason: reason } : {});
    });
  }

  /* Rattrapage : si le site n'a pas figé le match (serverLock) au moment du
     verrouillage, on le fait ici. Lève une erreur claire si le match n'est
     pas réellement prêt. À appeler DANS une transaction (renvoie l'update
     à écrire, ou null si déjà figé). */
  function ensureServerLock(match) {
    if (match.serverLock) return null;
    const res = serverLockUpdate(match, { requireReady: true });
    if (res.error === "not_ready" || res.error === "roster_incomplete") throw new HttpsError("failed-precondition", "The match isn't locked yet — both teams must be full and ready.");
    if (res.error === "stake_missing") throw new HttpsError("failed-precondition", "Every player must lock in their bet first. A player without enough coins should leave the match (everyone gets refunded).");
    if (res.error) throw new HttpsError("failed-precondition", "This match isn't valid (" + res.error + "). Leave it to get refunded.");
    return res.update;
  }

  /* =========================================================
     DÉCLARATION DE RÉSULTAT — "J'ai perdu" (immédiat) / "J'ai gagné"
     (réclamation avec timer, ou litige si l'adversaire a aussi réclamé).
     Uniquement sur un match VERROUILLÉ (avant : on pouvait déclarer avant
     même que l'adversaire ait rejoint).
  ========================================================= */
  const matchDeclareResult = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId, result } = request.data || {};
    if (!matchId || (result !== "WIN" && result !== "LOSS")) {
      throw new HttpsError("invalid-argument", "matchId and result ('WIN'|'LOSS') are required.");
    }
    const me = await getVerifiedMe(uid);
    const username = me.data.username;
    const isVip = !!(me.data.vipUntil && me.data.vipUntil > Date.now());
    const matchRef = db.collection("matches").doc(cleanId(matchId));

    const outcome = await db.runTransaction(async (tx) => {
      const matchSnap = await tx.get(matchRef);
      if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = matchSnap.data();
      if (match.completed || match.cancelled) return { status: "over" };
      if (match.cheaterReport && match.cheaterReport.status === "pending") return { status: "frozen" };

      const { hostPlayers, guestPlayers } = matchRoster(match);
      const onHost = hostPlayers.includes(username);
      const onGuest = guestPlayers.includes(username);
      if (!onHost && !onGuest) throw new HttpsError("permission-denied", "You're only spectating this match.");

      // Exception : en tournoi, "j'abandonne" (LOSS) marche même avant le
      // verrouillage (forfait — l'adversaire passe au tour suivant).
      const lockUpdate = (match.tournamentId && result === "LOSS") ? null : ensureServerLock(match);
      const locked = lockUpdate ? { ...match, ...lockUpdate } : match;
      const roster = matchRoster(locked);
      const myTeam = onHost ? roster.hostPlayers : roster.guestPlayers;
      const otherTeam = onHost ? roster.guestPlayers : roster.hostPlayers;

      if (result === "LOSS" && !isCaptain(locked, roster, username)) {
        throw new HttpsError("permission-denied", "Only your team captain (the host, or the first guest) can declare the defeat for your team.");
      }
      if (result === "LOSS") {
        if (lockUpdate) tx.update(matchRef, lockUpdate);
        return { status: "finalize" };
      }

      if (match.victoryClaim && match.victoryClaim.by === username) { if (lockUpdate) tx.update(matchRef, lockUpdate); return { status: "already_claimed" }; }
      if (match.victoryClaim && myTeam.includes(match.victoryClaim.by)) { if (lockUpdate) tx.update(matchRef, lockUpdate); return { status: "teammate_claimed" }; }
      if (match.victoryClaim && otherTeam.includes(match.victoryClaim.by)) {
        tx.update(matchRef, { ...(lockUpdate || {}), disputed: true });
        return { status: "disputed" };
      }
      const timerMs = isVip ? VIP_VICTORY_TIMER_MS : VICTORY_TIMER_MS;
      tx.update(matchRef, { ...(lockUpdate || {}), victoryClaim: { by: username, at: Date.now(), timerMs } });
      return { status: "claimed", timerMs };
    });

    if (outcome.status === "finalize") {
      const r = await finalizeMatch(String(matchId), { loser: username });
      return { status: r.status === "refunded" ? "refunded" : r.status === "finalized" ? "finalized" : "over" };
    }
    return outcome;
  });

  /* Toutes les 2 minutes : confirme les victoires dont le timer a expiré,
     annule (et rembourse) les matchs ouverts jamais verrouillés après 30
     min, et les matchs verrouillés où personne n'a rien déclaré après 6 h. */
  const STALE_LOCKED_MS = 6 * 60 * 60 * 1000;
  const TOURNAMENT_STALE_MS = 3 * 60 * 60 * 1000;
  const sweepMatchTimers = onSchedule("every 2 minutes", async () => {
    // Matchs en cours = champ serveur "active". + filet de sécurité pour les
    // matchs créés avant ce champ (7 derniers jours seulement).
    const now = Date.now();
    const legacyPass = new Date(now).getUTCMinutes() % 30 < 2;
    const [act, recent] = await Promise.all([
      db.collection("matches").where("active", "==", true).limit(1000).get(),
      legacyPass ? db.collection("matches").where("createdAt", ">", now - 7 * 24 * 3600 * 1000).limit(3000).get() : Promise.resolve({ docs: [] }),
    ]);
    // Une seule fois : réserve les pseudos de tous les comptes existants
    // (index insensible aux majuscules complet dès le lancement).
    try {
      const flagRef = db.collection("serverConfig").doc("usernameBackfill");
      const flag = await flagRef.get();
      if (!flag.exists) {
        await flagRef.set({ startedAt: now });
        const us = await db.collection("users").get();
        for (const u of us.docs) { const n = u.data().username; if (typeof n === "string") await ownerUidOf(n); }
        await flagRef.set({ doneAt: Date.now() }, { merge: true });
      }
    } catch (e) { logger.error("username backfill failed", { error: e.message }); }
    const docs = new Map();
    const tStatus = {};
    act.docs.forEach((d) => docs.set(d.id, d));
    recent.docs.forEach((d) => { const m = d.data(); if (m.active === undefined && !m.completed && !m.cancelled) docs.set(d.id, d); });
    for (const doc of docs.values()) {
      try {
        const match = doc.data();
        if (match.completed || match.cancelled) {
          if (match.active) await doc.ref.update({ active: false });
          continue;
        }
        const rep = match.cheaterReport;
        if (rep && (rep.status === "pending" || rep.status === "confirmed")) continue;
        if (match.tournamentId) {
          // Tournoi annulé (ou introuvable) : le match restant est clos, sans argent en jeu.
          if (!(match.tournamentId in tStatus)) {
            const s = await db.collection("serverTournaments").doc(String(match.tournamentId)).get();
            tStatus[match.tournamentId] = s.exists ? s.data().status : null;
          }
          const ts = tStatus[match.tournamentId];
          if (ts === "cancelled" || ts === "finished") {
            await refundMatch(doc.id, "tournament_" + ts);
            continue;
          }
        }
        if (match.victoryClaim) {
          if (match.disputed) continue;
          const timerMs = match.victoryClaim.timerMs || VICTORY_TIMER_MS;
          if (now - match.victoryClaim.at >= timerMs) await finalizeMatch(doc.id, { winner: match.victoryClaim.by, fromSweep: true });
          continue;
        }
        if (match.tournamentId) {
          const ro = matchRoster(match);
          const all = [...ro.hostPlayers, ...ro.guestPlayers];
          if (all.length !== 2 || match.disputed) continue;
          // Tirage au sort stable (même résultat à chaque passage).
          const coin = [...String(doc.id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2;
          if (!match.serverLock) {
            // Absent en tournoi : 15 min après la création, si un seul joueur est
            // prêt, l'autre perd par forfait. Personne de prêt après 20 min :
            // un des deux passe (tirage au sort) pour que le tableau avance.
            const age = now - (match.createdAt || now);
            const ready = all.filter((p) => (match.readies || {})[p]);
            if (age >= 5 * 60 * 1000 && ready.length === 1) await finalizeMatch(doc.id, { loser: all.find((p) => p !== ready[0]) });
            else if (age >= 8 * 60 * 1000 && ready.length === 0) await finalizeMatch(doc.id, { winner: all[coin], noShow: true });
          } else if (now - (match.serverLock.at || match.createdAt || now) >= TOURNAMENT_STALE_MS) {
            // Joué mais aucun résultat déclaré après 3 h : tirage au sort.
            await finalizeMatch(doc.id, { winner: all[coin], noResult: true });
          }
          continue;
        }
        if (match.disputed) continue;
        if (match.serverLock) {
          // Le délai repart après la décision sur un signalement.
          const since = Math.max(match.serverLock.at || match.createdAt || now, (rep && rep.resolvedAt) || 0);
          if (now - since >= STALE_LOCKED_MS) await refundMatch(doc.id, "stale_no_result");
        } else if (now - (match.createdAt || now) >= MATCH_TTL_MS) {
          await refundMatch(doc.id, "expired");
        }
      } catch (e) { logger.error("sweep failed", { id: doc.id, error: e.message }); }
    }
  });

  /* =========================================================
     ANNULATION — vote de tous les joueurs. Rembourse tout ce qui a été escrowé.
  ========================================================= */
  const matchCancelVote = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = cleanId((request.data || {}).matchId);
    const me = await getVerifiedMe(uid);
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);

    const doRefund = await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) return false;
      const match = snap.data();
      if (match.completed || match.cancelled) return false;
      if (match.tournamentId) throw new HttpsError("failed-precondition", "Tournament matches can't be cancelled — forfeit instead.");
      const { hostPlayers, guestPlayers } = matchRoster(match);
      const all = [...hostPlayers, ...guestPlayers];
      if (!all.includes(username)) throw new HttpsError("permission-denied", "Not part of this match.");
      if (match.victoryClaim || match.disputed) throw new HttpsError("failed-precondition", "A result is already in progress.");
      const cancelVotes = { ...(match.cancelVotes || {}) };
      cancelVotes[username] = !cancelVotes[username];
      const everyone = all.length > 1 && all.every((p) => cancelVotes[p]);
      tx.update(matchRef, { cancelVotes });
      return everyone;
    });

    if (doRefund) { await refundMatch(matchId, "cancel_vote"); return { status: "cancelled" }; }
    return { status: "voted" };
  });

  /* Quitter un match :
     - verrouillé → forfait (l'autre camp gagne) ;
     - pas verrouillé → je suis retiré ET remboursé tout de suite (avant :
       la mise restait bloquée dans le match) ;
     - le host qui part, un rematch (équipes fixes) → le match est annulé
       et tout le monde est remboursé ;
     - match de tournoi → forfait. */
  const matchLeave = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = cleanId((request.data || {}).matchId);
    // Un compte banni peut quand même quitter (et être remboursé), mais
    // il faut être le VRAI propriétaire du pseudo.
    const me = await getVerifiedMe(uid, { allowBanned: true });
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);

    const plan = await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) return { status: "gone" };
      const match = snap.data();
      if (match.completed) return { status: "completed" };
      if (match.cancelled) return { status: "cancelled" };

      const { hostPlayers, guestPlayers } = matchRoster(match);
      const isHost = hostPlayers.includes(username);
      const isGuest = guestPlayers.includes(username);
      if (!isHost && !isGuest) return { status: "not_in_match" };

      // Seul le verrou du SERVEUR compte (le champ "locked" peut être écrit
      // par n'importe quel navigateur).
      if (match.serverLock || match.tournamentId) {
        if (match.victoryClaim || match.disputed) return { status: "result_in_progress" };
        const myTeam = isHost ? hostPlayers : guestPlayers;
        const otherTeam = isHost ? guestPlayers : hostPlayers;
        if (myTeam.length === 0 || otherTeam.length === 0) return { status: "cancel" };
        if (!isCaptain(match, { hostPlayers, guestPlayers }, username)) {
          throw new HttpsError("permission-denied", "The match has started: only your team captain can forfeit. Play it out or ask staff.");
        }
        return { status: "forfeit" };
      }
      const trust = await matchTrust(tx, matchId, snap);

      if (username === match.host || match.serverRoster) return { status: "cancel" };

      const newHostPlayers = hostPlayers.filter((p) => p !== username);
      const newGuestPlayers = guestPlayers.filter((p) => p !== username);
      if (newHostPlayers.length === 0) return { status: "cancel" };
      const readies = { ...(match.readies || {}) };
      delete readies[username];
      const cancelVotes = { ...(match.cancelVotes || {}) };
      delete cancelVotes[username];

      const update = {
        hostPlayers: newHostPlayers, guestPlayers: newGuestPlayers,
        players: [...newHostPlayers, ...newGuestPlayers], readies, cancelVotes,
      };
      // Remboursement immédiat de ma mise.
      const escrowedBy = match.escrowedBy || [];
      if (escrowedBy.includes(username)) {
        const amount = trust.trusted ? Math.min(roundToCents((match.escrowAmounts && match.escrowAmounts[username]) || 0), trust.legacy ? computePlayerStake(match, username) : Infinity) : 0;
        const payUid = (match.escrowUids && match.escrowUids[username]) || uid;
        if (amount > 0) tx.set(db.collection("users").doc(payUid), { coins: FieldValue.increment(amount) }, { merge: true });
        const amounts = { ...(match.escrowAmounts || {}) }; delete amounts[username];
        const uids = { ...(match.escrowUids || {}) }; delete uids[username];
        update.escrowedBy = escrowedBy.filter((u) => u !== username);
        update.escrowAmounts = amounts;
        update.escrowUids = uids;
      }
      tx.update(matchRef, update);
      return { status: "left" };
    });

    if (plan.status === "forfeit") {
      const r = await finalizeMatch(matchId, { loser: username });
      return { status: r.status === "refunded" ? "cancelled" : "forfeit" };
    }
    if (plan.status === "cancel") { await refundMatch(matchId, "left"); return { status: "cancelled" }; }
    return plan;
  });

  /* =========================================================
     SIGNALEMENT DE TRICHE
  ========================================================= */
  const matchFileCheaterReport = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = cleanId((request.data || {}).matchId);
    const me = await getVerifiedMe(uid);
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = snap.data();
      if (match.completed || match.cancelled) throw new HttpsError("failed-precondition", "This match is over.");
      const { hostPlayers, guestPlayers } = matchRoster(match);
      const onHost = hostPlayers.includes(username);
      const onGuest = guestPlayers.includes(username);
      if (!onHost && !onGuest) throw new HttpsError("permission-denied", "Only match participants can file a report.");
      if (match.cheaterReport && match.cheaterReport.status === "pending") {
        throw new HttpsError("failed-precondition", "A report is already pending.");
      }
      if ((match.reportedBy || []).includes(username)) {
        throw new HttpsError("failed-precondition", "You already reported this match.");
      }
      if (!match.serverLock) throw new HttpsError("failed-precondition", "The match hasn't started yet.");
      tx.update(matchRef, {
        cheaterReport: { by: username, against: onHost ? guestPlayers : hostPlayers, at: Date.now(), status: "pending" },
        reportedBy: [...(match.reportedBy || []), username],
      });
    });
    return { ok: true };
  });

  const matchAdminReportDecision = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId, decision } = request.data || {}; // 'dismiss' | 'confirm'
    const me = await requireAdmin(uid);
    const mref = db.collection("matches").doc(cleanId(matchId));
    const msnap = await mref.get();
    if (!msnap.exists) throw new HttpsError("not-found", "Match not found.");
    const m = msnap.data();
    const rep = m.cheaterReport || {};
    if (rep.status !== "pending") throw new HttpsError("failed-precondition", "This report was already handled.");
    const ros = matchRoster(m);
    if ([...ros.hostPlayers, ...ros.guestPlayers].includes(me.data.username)) {
      throw new HttpsError("permission-denied", "You can't decide on a match you're playing in.");
    }
    if (decision === "confirm" && !m.completed && !m.cancelled && rep.by) {
      if (![...ros.hostPlayers, ...ros.guestPlayers].includes(rep.by)) {
        throw new HttpsError("failed-precondition", "The reporter is no longer in this match — use Force Win instead.");
      }
      // Triche confirmée : le camp de celui qui a signalé gagne.
      await mref.update({ "cheaterReport.status": "confirmed", "cheaterReport.resolvedBy": me.data.username, "cheaterReport.resolvedAt": Date.now() });
      try { await finalizeMatch(String(matchId), { winner: rep.by }); }
      catch (e) { await mref.update({ "cheaterReport.status": "pending" }); throw e; }
      await adminLog(uid, me.data.username, "confirmCheater", { matchId, winner: rep.by });
      return { ok: true };
    }
    // Rejeté : le timer de victoire repart de zéro (l'autre camp peut répondre).
    if (decision !== "confirm" && m.victoryClaim) await mref.update({ "victoryClaim.at": Date.now() });
    await mref.update({
      "cheaterReport.status": decision === "confirm" ? "confirmed" : "dismissed",
      "cheaterReport.resolvedBy": me.data.username,
      "cheaterReport.resolvedAt": Date.now(),
    });
    return { ok: true };
  });

  const matchAdminResolveDispute = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId, winnerUsername } = request.data || {};
    const me = await requireAdmin(uid);
    const matchSnap = await db.collection("matches").doc(cleanId(matchId)).get();
    if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found.");
    const md = matchSnap.data();
    const { hostPlayers, guestPlayers } = matchRoster(md);
    if (!winnerUsername || ![...hostPlayers, ...guestPlayers].includes(winnerUsername)) {
      throw new HttpsError("invalid-argument", "Unknown winner.");
    }
    // Les modos peuvent trancher leurs propres matchs (choix du propriétaire) :
    // la décision reste notée dans le journal admin (adminLog).
    if (!md.serverLock && !md.tournamentId) {
      throw new HttpsError("failed-precondition", "This match hasn't started yet.");
    }
    const r = await finalizeMatch(String(matchId), { winner: winnerUsername });
    await adminLog(uid, me.data.username, "resolveDispute", { matchId, winnerUsername, status: r.status });
    return { ok: true, status: r.status };
  });

  /* =========================================================
     REMATCH — quand TOUS les joueurs des deux équipes ont cliqué, un
     nouveau match est créé avec les mêmes équipes (figées côté serveur :
     serverRoster), la même mise et le même cover bet. Chaque joueur paie
     ensuite sa mise (matchEscrow, appelé automatiquement par le site) ; le
     match ne se verrouille que quand tout le monde a payé. Idempotent.
  ========================================================= */
  const matchRematch = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = cleanId((request.data || {}).matchId);
    if (!matchId) throw new HttpsError("invalid-argument", "matchId is required.");
    const me = await getVerifiedMe(uid);
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = snap.data();
      const origMeta = await tx.get(db.collection("matchMeta").doc(matchId));
      if (!match.completed) throw new HttpsError("failed-precondition", "This match isn't finished yet.");
      if (match.tournamentId) throw new HttpsError("failed-precondition", "Tournament matches can't be rematched.");

      if (match.rematchMatchId) return { status: "already_created", newMatchId: match.rematchMatchId };

      const { hostPlayers, guestPlayers } = matchRoster(match);
      const all = [...hostPlayers, ...guestPlayers];
      if (!all.includes(username)) throw new HttpsError("permission-denied", "You weren't part of this match.");

      const votes = { ...(match.rematchVotes || {}), [username]: true };
      const everyoneIn = all.length > 0 && all.every((p) => votes[p]);

      if (everyoneIn) {
        // Tout le monde doit pouvoir payer sa mise, sinon pas de rematch.
        const probe = { ...match, hostPlayers, guestPlayers };
        const uidMap = await resolveUidMap(all, match.escrowUids || {});
        const poor = [];
        for (const p of all) {
          const need = computePlayerStake(probe, p);
          if (need <= 0) continue;
          const us = uidMap[p] ? await tx.get(db.collection("users").doc(uidMap[p])) : null;
          if (!us || !us.exists || (us.data().coins || 0) < need) poor.push(p);
        }
        if (poor.length) {
          tx.update(matchRef, { rematchVotes: votes, rematchBlocked: { players: poor, at: Date.now() } });
          return { status: "insufficient", players: poor };
        }
      }
      if (!everyoneIn) {
        tx.update(matchRef, { rematchVotes: votes });
        return { status: "waiting", votes: all.filter((p) => votes[p]).length, total: all.length };
      }

      const newId = "M-" + Math.random().toString(36).slice(2, 8).toUpperCase() +
        Math.random().toString(36).slice(2, 4).toUpperCase();
      const newMatch = {
        id: newId,
        host: match.host,
        hostEpic: match.hostEpic || "N/A",
        hostStats: match.hostStats || {},
        visibility: match.visibility || "public",
        passcode: null,
        region: match.region || null,
        platform: match.platform || null,
        weapon: match.weapon || "",
        teamSize: match.teamSize || "1v1",
        team: match.team || null,
        coverBet: !!match.coverBet,
        bet: match.bet !== undefined ? match.bet : 0.5,
        mode: match.mode || null,
        firstTo: match.firstTo || 1,
        killLead: match.killLead || null,
        simpleEdit: match.simpleEdit !== false,
        status: "OPEN",
        players: all,
        hostPlayers,
        guestPlayers,
        serverRoster: { hostPlayers, guestPlayers },
        readies: {},
        results: {},
        processedBy: [],
        victoryClaim: null,
        disputed: false,
        proofs: {},
        chat: [],
        locked: false,
        completed: false,
        createdAt: Date.now(),
        escrowedBy: [],
        escrowAmounts: {},
        escrowUids: {},
        rematchOf: matchId,
      };
      tx.set(db.collection("matches").doc(newId), { ...newMatch, active: true });
      const origCode = origMeta.exists && origMeta.data().passcode !== undefined ? origMeta.data().passcode : (match.passcode || null);
      tx.set(db.collection("matchMeta").doc(newId), { rematchOf: matchId, at: Date.now(), passcode: origCode || null });
      tx.update(matchRef, { rematchVotes: votes, rematchMatchId: newId });
      return { status: "created", newMatchId: newId };
    });
  });

  const matchAdminDelete = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId } = request.data || {};
    const me = await requireAdmin(uid);
    const id = cleanId(matchId);
    if (!id) throw new HttpsError("invalid-argument", "matchId is required.");
    const matchSnap = await db.collection("matches").doc(id).get();
    if (matchSnap.exists && matchSnap.data().tournamentId && !matchSnap.data().completed) {
      throw new HttpsError("failed-precondition", "Tournament match in progress: use Force Win instead of deleting it (or the bracket gets stuck).");
    }
    if (matchSnap.exists) {
      const match = matchSnap.data();
      if (!match.completed && (match.escrowedBy || []).length > (match.refundedBy || []).length) await refundMatch(id, "admin_delete");
    }
    await db.collection("matches").doc(id).delete();
    await adminLog(uid, me.data.username, "deleteMatch", { matchId: id });
    return { ok: true };
  });

  /* =========================================================
     ROUE QUOTIDIENNE
  ========================================================= */
  const spinWheel = onCall(async (request) => {
    const uid = requireAuth(request);
    await getVerifiedMe(uid);
    const userRef = db.collection("users").doc(uid);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
      const me = snap.data();
      if (me.banned || (me.banUntil && me.banUntil > Date.now())) throw new HttpsError("permission-denied", "Your account is banned.");
      // Tours illimités : réservé au propriétaire (Ryven), vérifié par UID.
      // Avant, tous les modérateurs pouvaient tourner à l'infini = coins gratuits.
      const admin_ = (await adminLevelOf(uid, me.username)) === "owner";
      if (!admin_) {
        const last = me.lastWheelSpin || 0;
        if (Date.now() - last < WHEEL_COOLDOWN_MS) throw new HttpsError("failed-precondition", "You already spun the wheel today.");
      }
      const idx = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
      const seg = WHEEL_SEGMENTS[idx];
      const update = { lastWheelSpin: admin_ ? (me.lastWheelSpin || Date.now()) : Date.now() };
      let resultText = "";
      if (seg.type === "coins") {
        update.coins = roundToCents((me.coins || 0) + seg.amount);
        resultText = `+${seg.amount} coins`;
      } else if (seg.type === "snipes") {
        update.snipes = (me.snipes || 0) + seg.amount;
        resultText = `+${seg.amount} snipes`;
      } else {
        const owned = me.ownedAvatars || [];
        const unowned = Object.keys(AVATAR_PRICES).filter((id) => !owned.includes(id));
        if (unowned.length > 0) {
          const picked = unowned[Math.floor(Math.random() * unowned.length)];
          update.ownedAvatars = FieldValue.arrayUnion(picked);
          resultText = `avatar:${picked}`;
        } else {
          update.coins = roundToCents((me.coins || 0) + 3);
          resultText = "+3 coins";
        }
      }
      tx.update(userRef, update);
      return { idx, resultText };
    });
  });

  /* =========================================================
     BOUTIQUE
  ========================================================= */
  const shopPurchase = onCall(async (request) => {
    const uid = requireAuth(request);
    await getVerifiedMe(uid);
    const { item } = request.data || {};
    const avatarId = typeof (request.data || {}).avatarId === "string" ? request.data.avatarId : "";
    const userRef = db.collection("users").doc(uid);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
      const me = snap.data();
      const coins = me.coins || 0;

      if (item === "avatar") {
        const price = Object.prototype.hasOwnProperty.call(AVATAR_PRICES, String(avatarId)) ? AVATAR_PRICES[avatarId] : undefined;
        if (price === undefined) throw new HttpsError("invalid-argument", "Unknown avatar.");
        if ((me.ownedAvatars || []).includes(avatarId)) throw new HttpsError("failed-precondition", "Already owned.");
        if (coins < price) throw new HttpsError("failed-precondition", "Not enough coins.");
        tx.update(userRef, { coins: roundToCents(coins - price), ownedAvatars: FieldValue.arrayUnion(avatarId) });
        return { ok: true };
      }
      if (item === "snipeBundle") {
        if (coins < SNIPE_COST_COINS) throw new HttpsError("failed-precondition", "Not enough coins.");
        tx.update(userRef, { coins: roundToCents(coins - SNIPE_COST_COINS), snipes: (me.snipes || 0) + SNIPE_BUNDLE_QTY });
        return { ok: true };
      }
      if (item === "customAvatarSlot") {
        if (me.customAvatarUnlocked) throw new HttpsError("failed-precondition", "Already unlocked.");
        if (coins < CUSTOM_AVATAR_COST_COINS) throw new HttpsError("failed-precondition", "Not enough coins.");
        tx.update(userRef, { coins: roundToCents(coins - CUSTOM_AVATAR_COST_COINS), customAvatarUnlocked: true });
        return { ok: true };
      }
      if (item === "resetStats") {
        if (coins < RESET_STATS_COST_COINS) throw new HttpsError("failed-precondition", "Not enough coins.");
        tx.update(userRef, { coins: roundToCents(coins - RESET_STATS_COST_COINS), stats: { ...EMPTY_STATS }, history: [] });
        return { ok: true };
      }
      if (item === "vip") {
        const now = Date.now();
        if (me.vipUntil && me.vipUntil > now) throw new HttpsError("failed-precondition", "Already VIP.");
        if (coins < VIP_COST_COINS) throw new HttpsError("failed-precondition", "Not enough coins.");
        const update = { coins: roundToCents(coins - VIP_COST_COINS), vipUntil: now + VIP_DURATION_MS, snipes: (me.snipes || 0) + VIP_SNIPE_BONUS };
        const owned = me.ownedAvatars || [];
        const unowned = Object.keys(AVATAR_PRICES).filter((id) => !owned.includes(id));
        let bonus = "";
        if (unowned.length > 0) {
          const picked = unowned[Math.floor(Math.random() * unowned.length)];
          update.ownedAvatars = FieldValue.arrayUnion(picked);
          bonus = "avatar:" + picked;
        } else {
          // Tous les avatars déjà possédés : 3 snipes en plus (avant : 3 coins
          // rendus, ce qui rendait le VIP gratuit).
          update.snipes = update.snipes + 3;
          bonus = "snipes:3";
        }
        tx.update(userRef, update);
        return { ok: true, bonus };
      }
      throw new HttpsError("invalid-argument", "Unknown item.");
    });
  });

  /* Snipe : le match révélé est gardé sur le compte (snipedMatches), donc
     la révélation reste après une déconnexion / sur un autre appareil, et
     un même match n'est jamais payé deux fois. */
  const useSnipe = onCall(async (request) => {
    const uid = requireAuth(request);
    await getVerifiedMe(uid);
    const raw = (request.data || {}).matchId;
    const matchId = raw ? cleanId(raw) : null;
    const userRef = db.collection("users").doc(uid);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
      const d = snap.data();
      const list = Array.isArray(d.snipedMatches) ? d.snipedMatches : [];
      if (matchId && list.includes(matchId)) return { ok: true, already: true, snipes: d.snipes || 0 };
      const snipes = d.snipes || 0;
      if (snipes <= 0) throw new HttpsError("failed-precondition", "No snipes left.");
      const upd = { snipes: snipes - 1 };
      if (matchId) upd.snipedMatches = [...list, matchId].slice(-200);
      tx.update(userRef, upd);
      return { ok: true, snipes: snipes - 1 };
    });
  });

  /* =========================================================
     INITIALISATION DE COMPTE — la création du document users/{uid} elle-
     même (username, epic, equippedAvatar...) reste faite par le site
     (doSignup), MAIS il lui est désormais interdit d'y inclure le moindre
     champ "économique" (voir economicFields() dans firestore.rules : la
     règle `create` refuse le document s'il contient ne serait-ce qu'une
     clé de cette liste). C'est cette fonction, juste après la création du
     compte, qui pose les valeurs de départ (0 coin, avatar de bienvenue,
     etc.) avec les droits Admin SDK. Idempotente : un second appel (ex.
     double-clic, retry réseau) ne redonne pas une 2e fois l'avatar de
     départ — elle vérifie que le compte n'a pas déjà été initialisé.
  ========================================================= */
  const initAccount = onCall(async (request) => {
    const uid = requireAuth(request);
    const { starterAvatar } = request.data || {};
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found — create the account first.");
    const data = snap.data();
    if (data.ecoResetVersion !== undefined) {
      // Déjà initialisé (ou remis à zéro depuis) — on ne touche à rien.
      return { ok: true, alreadyInitialized: true };
    }
    // Réserve le pseudo tout de suite (le plus ancien compte qui le porte
    // le garde — voir ownerUidOf).
    try { await ownerUidOf(data.username); } catch (e) { logger.warn("username claim failed", { error: e.message }); }
    // Seuls les avatars de départ gratuits ("starter_...") sont acceptés ici
    // (avant, n'importe quel avatar payant pouvait être demandé).
    const avatars = /^starter_[a-z]{1,20}$/.test(String(starterAvatar || "")) ? ["default", String(starterAvatar)] : ["default"];
    // Transaction + seulement les champs absents : un dépôt crédité entre-temps
    // (coins déjà présents) n'est jamais remis à zéro.
    return db.runTransaction(async (tx) => {
      const cur = await tx.get(userRef);
      const c = cur.data() || {};
      if (c.ecoResetVersion !== undefined) return { ok: true, alreadyInitialized: true };
      const upd = { ecoResetVersion: ECO_RESET_VERSION };
      // Ancien profil (stats déjà là) jamais passé en v4 : on applique le reset.
      if (c.stats !== undefined) Object.assign(upd, { coins: Math.min(0, Number(c.coins) || 0), snipes: 0, vipUntil: null });
      const def = { stats: { ...EMPTY_STATS }, coins: 0, ownedAvatars: avatars, customAvatarUnlocked: false, snipes: 0,
        vipUntil: null, rp: 0, history: [], settledMatchIds: [], lastWheelSpin: null };
      Object.entries(def).forEach(([k, v]) => { if (c[k] === undefined) upd[k] = v; });
      tx.update(userRef, upd);
      return { ok: true };
    });
  });

  /* =========================================================
     TIPS entre joueurs
  ========================================================= */
  const sendTip = onCall(async (request) => {
    const uid = requireAuth(request);
    const { targetUsername, amount: rawAmount } = request.data || {};
    const amount = roundToCents(Number(rawAmount));
    if (!(amount > 0)) throw new HttpsError("invalid-argument", "Invalid amount.");
    if (!targetUsername) throw new HttpsError("invalid-argument", "Target username required.");

    if (amount > 100000) throw new HttpsError("invalid-argument", "Invalid amount.");
    if (amount < 1) throw new HttpsError("invalid-argument", "The minimum tip is 1 coin.");
    await getVerifiedMe(uid);
    const meRef = db.collection("users").doc(uid);
    if (typeof rawAmount !== "number" && typeof rawAmount !== "string") throw new HttpsError("invalid-argument", "Invalid amount.");
    const target = await resolveUsernameLoose(String(targetUsername));
    const targetUid = target && target.uid;
    if (!targetUid) throw new HttpsError("not-found", "This player doesn't exist.");
    const targetRef = db.collection("users").doc(targetUid);
    if (targetUid === uid) throw new HttpsError("invalid-argument", "You can't tip yourself.");

    return db.runTransaction(async (tx) => {
      const meSnap = await tx.get(meRef);
      const me = meSnap.data();
      if ((me.coins || 0) < amount) throw new HttpsError("failed-precondition", "Not enough coins.");
      const isVip = !!(me.vipUntil && me.vipUntil > Date.now());
      // Taxe arrondie au centime SUPÉRIEUR (sinon des tips de 0,09 passaient sans taxe).
      const fee = isVip ? 0 : Math.ceil(Math.round(amount * 100) * 0.05 - 1e-9) / 100;
      const net = roundToCents(amount - fee);
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) throw new HttpsError("not-found", "This player doesn't exist.");
      const targetData = targetSnap.data() || {};
      if (targetData.banned) throw new HttpsError("failed-precondition", "This player is banned.");
      tx.update(meRef, { coins: roundToCents((me.coins || 0) - amount) });
      const legacyT = targetData.stats && (targetData.ecoResetVersion || 0) < ECO_RESET_VERSION;
      const baseCoins = legacyT ? Math.min(0, Number(targetData.coins) || 0) : (targetData.coins || 0);
      tx.update(targetRef, {
        ...(legacyT ? { snipes: 0, vipUntil: null, ecoResetVersion: ECO_RESET_VERSION } : {}),
        coins: roundToCents(baseCoins + net),
        notifications: [
          { id: "n" + Date.now() + Math.random().toString(36).slice(2, 7), type: "tip", text: `${me.username} tipped you ${net} coins!`, at: Date.now(), read: false },
          ...((targetData.notifications || []).slice(0, 29)),
        ],
      });
      return { ok: true, net, fee };
    });
  });

  /* =========================================================
     OUTILS MODÉRATEUR — argent
  ========================================================= */
  // AJOUTER des coins = créer de l'argent réel (retirable). Réservé au
  // propriétaire. Les modérateurs peuvent seulement en RETIRER (ex. pour
  // traiter un retrait). Mettre true pour redonner ce pouvoir aux modos.
  const MODS_CAN_ADD_COINS = false;
  const adminAdjustCoins = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireAdmin(uid);
    const { targetUsername, amount: rawAmount } = request.data || {};
    if (typeof rawAmount !== "number") throw new HttpsError("invalid-argument", "Invalid amount.");
    const amount = roundToCents(rawAmount);
    if (!amount || !Number.isFinite(amount) || Math.abs(amount) > 100000) throw new HttpsError("invalid-argument", "Invalid amount.");
    if (amount > 0 && !MODS_CAN_ADD_COINS && (await adminLevelOf(uid, me.data.username)) !== "owner") {
      throw new HttpsError("permission-denied", "Only the owner can add coins.");
    }
    const targetUid = await ownerUidOf(String(targetUsername || ""));
    if (!targetUid) throw new HttpsError("not-found", "Player not found.");
    const ref = db.collection("users").doc(targetUid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const td = snap.data() || {};
      const legacyT = td.stats && (td.ecoResetVersion || 0) < ECO_RESET_VERSION;
      const coins = legacyT ? Math.min(0, Number(td.coins) || 0) : (td.coins || 0);
      if (amount < 0 && roundToCents(coins + amount) < 0) throw new HttpsError("failed-precondition", "Not enough coins on that account.");
      tx.update(ref, { coins: roundToCents(coins + amount), ...(legacyT ? { snipes: 0, vipUntil: null, ecoResetVersion: ECO_RESET_VERSION } : {}) });
    });
    await adminLog(uid, me.data.username, "adjustCoins", { targetUsername, targetUid, amount });
    return { ok: true };
  });

  /* Migration one-shot par compte (v4) : un joueur qui se connecte pour la
     première fois après le passage en v4 est ramené à 0 coin / 0 snipe /
     pas de VIP. Avant le passage au serveur-authoritative, le site posait
     ça lui-même localement puis l'écrivait direct dans Firestore ; coins/
     snipes/vipUntil étant désormais verrouillés, c'est cette fonction (en
     libre-service, mais idempotente et sans effet une fois déjà à jour)
     qui s'en charge. */
  const selfEcoReset = onCall(async (request) => {
    const uid = requireAuth(request);
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
    const data = snap.data();
    if ((data.ecoResetVersion || 0) >= ECO_RESET_VERSION) return { ok: true, already: true };
    // Compte jamais initialisé : c'est initAccount qui s'en charge.
    if (data.ecoResetVersion === undefined && !data.stats) return { ok: true, skipped: "not_initialized" };
    // En transaction ; une dette (chargeback) n'est jamais effacée.
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(userRef);
      const c = cur.data() || {};
      if ((c.ecoResetVersion || 0) >= ECO_RESET_VERSION) return;
      tx.update(userRef, { coins: Math.min(0, Number(c.coins) || 0), snipes: 0, vipUntil: null, ecoResetVersion: ECO_RESET_VERSION });
    });
    return { ok: true };
  });

  const adminResetEconomy = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireOwner(uid);
    await adminLog(uid, me.data.username, "resetEconomy", {});
    const snap = await db.collection("users").get();
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { coins: 0, snipes: 0, vipUntil: null }));
      await batch.commit();
    }
    return { ok: true, count: docs.length };
  });

  const adminSetVip = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireAdmin(uid);
    const { targetUsername, action, days } = request.data || {}; // action: 'grant' | 'revoke'
    const targetUid = await ownerUidOf(String(targetUsername || ""));
    if (!targetUid) throw new HttpsError("not-found", "Player not found.");
    const ref = db.collection("users").doc(targetUid);
    await adminLog(uid, me.data.username, "setVip", { targetUsername, action: action || "grant", days: days || null });
    if (action === "revoke") { await ref.update({ vipUntil: null }); return { ok: true }; }
    // "set" : fixe une expiration à N jours à partir de maintenant (outil modérateur,
    // remplace l'ancienne durée), plutôt que "grant" qui prolonge de VIP_DURATION_MS.
    if (action === "set") {
      const n = Number(days);
      if (!Number.isFinite(n) || n <= 0) throw new HttpsError("invalid-argument", "Invalid number of days.");
      const newUntil = Date.now() + Math.round(n) * 24 * 60 * 60 * 1000;
      await ref.update({ vipUntil: newUntil });
      return { ok: true, vipUntil: newUntil };
    }
    const snap = await ref.get();
    const cur = snap.data().vipUntil || 0;
    const base = Math.max(cur, Date.now());
    await ref.update({ vipUntil: base + VIP_DURATION_MS });
    return { ok: true };
  });

  const adminGiveSelfSnipes = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireAdmin(uid);
    const n = Math.floor(Number((request.data || {}).amount));
    if (!n || n <= 0 || n > 1000) throw new HttpsError("invalid-argument", "Invalid amount.");
    await adminLog(uid, me.data.username, "giveSelfSnipes", { amount: n });
    await db.collection("users").doc(uid).update({ snipes: FieldValue.increment(n) });
    return { ok: true };
  });

  /* =========================================================
     TOURNOIS — avancement du tableau + paiement des prix, en tâche de
     fond serveur (avant : n'importe quel navigateur ouvert le faisait,
     et pouvait donc être trafiqué).
  ========================================================= */
  function tournamentRoundCount(t) { return Math.max(0, ...(t.bracket || []).map((e) => e.r)) + 1; }
  function tournamentRoundName(t, r) {
    const total = tournamentRoundCount(t);
    const left = total - r;
    if (left === 1) return "Final";
    if (left === 2) return "Semi-finals";
    if (left === 3) return "Quarter-finals";
    return "Round " + (r + 1);
  }
  function tournamentMatchId(t, r, i) { return `TM-${t.id}-${r}-${i}`; }
  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function buildInitialBracket(players) {
    const shuffled = shuffleArray(players);
    let size = 2;
    while (size < shuffled.length) size *= 2;
    const rounds = Math.log2(size);
    const half = size / 2;
    const bracket = [];
    for (let i = 0; i < half; i++) bracket.push({ r: 0, i, a: null, b: null, winner: null, matchId: null });
    shuffled.forEach((p, k) => { const e = bracket[k % half]; if (k < half) e.a = p; else e.b = p; });
    for (let r = 1; r < rounds; r++) {
      for (let i = 0; i < size / Math.pow(2, r + 1); i++) bracket.push({ r, i, a: null, b: null, winner: null, matchId: null });
    }
    return bracket;
  }
  function buildTournamentMatch(t, e, lastRound) {
    const a = e.a, b = e.b;
    return {
      id: tournamentMatchId(t, e.r, e.i), host: a, hostEpic: "N/A", hostStats: {},
      visibility: "private", passcode: null, region: t.region, platform: t.platform, weapon: t.weapon || "",
      teamSize: "1v1", team: null, coverBet: false, bet: 0, mode: t.mode, firstTo: t.firstTo || 1,
      killLead: null, simpleEdit: t.simpleEdit !== false, status: "OPEN", players: [a, b],
      hostPlayers: [a], guestPlayers: [b], serverRoster: { hostPlayers: [a], guestPlayers: [b] },
      readies: {}, results: {}, processedBy: [],
      victoryClaim: null, disputed: false, proofs: {}, chat: [], locked: false, completed: false,
      createdAt: Date.now(), escrowedBy: [a, b], escrowAmounts: { [a]: 0, [b]: 0 },
      tournamentId: t.id, tournamentName: t.name, tournamentRound: e.r,
      tournamentRoundName: tournamentRoundName({ bracket: [{ r: lastRound }] }, e.r),
    };
  }
  function resolveBracket(t, bracketIn, matchesById) {
    const bracket = bracketIn.map((e) => ({ ...e }));
    const lastRound = Math.max(...bracket.map((e) => e.r));
    const find = (r, i) => bracket.find((e) => e.r === r && e.i === i);
    const newMatches = [];
    let finalWinner = null, changed = false, guard = 0, loop = true;
    while (loop && guard++ < 50) {
      loop = false;
      bracket.sort((x, y) => x.r - y.r || x.i - y.i).forEach((e) => {
        if (e.winner) return;
        let w = null;
        if (e.r === 0 && ((e.a && !e.b) || (!e.a && e.b))) w = e.a || e.b;
        else if (e.a && e.b) {
          if (!e.matchId) {
            const m = buildTournamentMatch(t, e, lastRound);
            e.matchId = m.id; newMatches.push(m); changed = true;
          } else {
            const m = matchesById[e.matchId];
            if (m && m.completed && m.results) {
              if (m.results[e.a] === "WIN") w = e.a;
              else if (m.results[e.b] === "WIN") w = e.b;
            }
          }
        }
        if (w) {
          e.winner = w; changed = true; loop = true;
          if (e.r === lastRound) finalWinner = w;
          else { const parent = find(e.r + 1, Math.floor(e.i / 2)); if (parent) { if (e.i % 2 === 0) parent.a = w; else parent.b = w; } }
        }
      });
    }
    return { bracket, newMatches, finalWinner, changed };
  }
  function tournamentPayoutList(t, bracket, prizes) {
    const p = prizes || {};
    const lastRound = Math.max(...bracket.map((e) => e.r));
    const final = bracket.find((e) => e.r === lastRound);
    const out = [];
    if (!final || !final.winner) return out;
    const loserOf = (e) => (e.winner === e.a ? e.b : e.a);
    if (p.first > 0) out.push({ name: final.winner, amount: p.first, place: 1 });
    if (p.second > 0 && loserOf(final)) out.push({ name: loserOf(final), amount: p.second, place: 2 });
    if (p.semis > 0 && lastRound >= 1) {
      bracket.filter((e) => e.r === lastRound - 1 && e.winner).forEach((e) => {
        const l = loserOf(e);
        if (l) out.push({ name: l, amount: p.semis, place: 3 });
      });
    }
    return out;
  }

  /* Les prix d'un tournoi : ils ne viennent PLUS du document du tournoi
     (écrit par le site, donc falsifiable : n'importe qui aurait pu créer un
     tournoi avec 10 000 coins de prix et se les faire verser), mais de
     tournamentPrizes/{id}, écrit uniquement par adminCreateTournament.
     Exception : les tournois créés AVANT cette mise à jour gardent leurs
     prix (date de création Firestore, impossible à falsifier). */
  const LEGACY_TOURNAMENT_CUTOFF_MS = Date.parse("2026-10-02T15:00:00Z");
  async function trustedPrizes(tid, snap) {
    const pz = await db.collection("tournamentPrizes").doc(tid).get();
    if (pz.exists) {
      // Le document doit avoir été écrit par adminCreateTournament pour le
      // vrai propriétaire (UID vérifié), et correspondre au tournoi.
      const by = pz.data().by;
      const ownerUid = await ownerUidOf(SUPER_ADMIN);
      if (by && ownerUid && by === ownerUid && snap.data().createdByUid === by) return pz.data().prizes || {};
      logger.warn("untrusted tournamentPrizes doc ignored", { tid });
      return {};
    }
    const created = snap.createTime ? snap.createTime.toMillis() : Infinity;
    if (created < LEGACY_TOURNAMENT_CUTOFF_MS) return snap.data().prizes || {};
    return {};
  }

  /* L'état qui compte (tableau, statut, prix déjà payés) est gardé dans
     serverTournaments/{id}, que seul le serveur écrit. Le document
     "tournaments" n'est plus qu'une copie pour l'affichage : le modifier à
     la main ne peut plus relancer un tableau ni refaire payer des prix. */
  function tournamentView(t, srv) {
    if (srv) return { ...t, status: srv.status, bracket: Array.isArray(srv.bracket) ? srv.bracket : [], paidOut: !!srv.paidAt };
    return { ...t, bracket: Array.isArray(t.bracket) ? t.bracket : [] };
  }

  async function advanceTournamentServer(tid, matchesById) {
    const ref = db.collection("tournaments").doc(tid);
    const srvRef = db.collection("serverTournaments").doc(tid);
    const [preSnap, preSrv] = await Promise.all([ref.get(), srvRef.get()]);
    if (!preSnap.exists) return;
    const pre = tournamentView(preSnap.data(), preSrv.exists ? preSrv.data() : null);
    if (pre.paidOut) return;
    const prizes = await trustedPrizes(tid, preSnap);
    let uidMap = {};
    let realPlayers = null;
    if (pre.status === "running") {
      const sim = resolveBracket(pre, pre.bracket, matchesById);
      if (sim.finalWinner) uidMap = await resolveUidMap(tournamentPayoutList(pre, sim.bracket, prizes).map((p) => p.name));
    } else if (pre.status === "upcoming") {
      // Au tirage : on retire les pseudos qui ne correspondent à aucun vrai compte.
      realPlayers = [];
      for (const p of [...new Set(pre.players || [])]) { if (typeof p === "string" && await ownerUidOf(p)) realPlayers.push(p); }
    }
    await db.runTransaction(async (tx) => {
      const [snap, srvSnap] = await Promise.all([tx.get(ref), tx.get(srvRef)]);
      if (!snap.exists) return;
      const raw = snap.data();
      const srv = srvSnap.exists ? srvSnap.data() : null;
      if (srv && (srv.paidAt || srv.status === "finished" || srv.status === "cancelled")) return;
      if (!srv && raw.paidOut) return; // ancien tournoi déjà payé
      if (raw.status === "cancelled") {
        // Annulé par le propriétaire : ça ne peut que l'arrêter, jamais le relancer.
        if (!srv || srv.status !== "cancelled") tx.set(srvRef, { status: "cancelled", at: Date.now() }, { merge: true });
        return;
      }
      const t = tournamentView(raw, srv);
      let bracket = t.bracket;
      let status = t.status;
      const mirror = {};
      const srvUpd = {};
      if (status === "upcoming") {
        if (!(raw.startAt && Date.now() >= raw.startAt)) return;
        const players = (realPlayers || []).filter((p) => (raw.players || []).includes(p)).slice(0, Math.max(2, Number(raw.slots) || 16));
        if (players.length < 2) {
          tx.set(srvRef, { status: "cancelled", at: Date.now() }, { merge: true });
          tx.update(ref, { status: "cancelled", cancelReason: "Not enough players" });
          return;
        }
        bracket = buildInitialBracket(players);
        status = "running"; mirror.startedAt = Date.now(); srvUpd.draw = players;
      } else if (status !== "running") return;

      const res = resolveBracket({ ...t, status }, bracket, matchesById);
      if (!res.changed && t.status === "running") return;
      res.newMatches.forEach((m) => {
        tx.set(db.collection("matches").doc(m.id), { ...m, active: true });
        tx.set(db.collection("matchMeta").doc(m.id), { tournamentId: tid, at: Date.now() });
      });
      srvUpd.bracket = res.bracket; srvUpd.status = status;
      mirror.bracket = res.bracket; mirror.status = status;
      if (res.finalWinner) {
        srvUpd.status = "finished"; mirror.status = "finished";
        mirror.winner = res.finalWinner; mirror.finishedAt = Date.now();
        const payouts = tournamentPayoutList(t, res.bracket, prizes);
        const paid = [];
        payouts.forEach((pay) => {
          const payUid = uidMap[pay.name];
          if (payUid) { tx.set(db.collection("users").doc(payUid), { coins: FieldValue.increment(pay.amount), tournamentPrizeTotal: FieldValue.increment(pay.amount) }, { merge: true }); paid.push(pay); }
        });
        srvUpd.paidAt = Date.now(); srvUpd.payouts = paid;
        mirror.paidOut = true; mirror.payouts = paid;
      }
      tx.set(srvRef, srvUpd, { merge: true });
      tx.update(ref, mirror);
    });
  }

  const tournamentTick = onSchedule("every 1 minutes", async () => {
    const tSnap = await db.collection("tournaments").where("status", "in", ["upcoming", "running"]).get();
    if (tSnap.empty) return;
    const tournaments = [];
    for (const d of tSnap.docs) {
      const srv = await db.collection("serverTournaments").doc(d.id).get();
      const view = tournamentView(d.data(), srv.exists ? srv.data() : null);
      if (view.status !== "upcoming" && view.status !== "running") continue;
      tournaments.push({ id: d.id, data: view });
    }
    const matchIds = new Set();
    tournaments.forEach((t) => t.data.bracket.forEach((e) => { if (e && typeof e.matchId === "string") matchIds.add(e.matchId); }));
    const matchesById = {};
    const idList = [...matchIds];
    for (let i = 0; i < idList.length; i += 10) {
      const chunk = idList.slice(i, i + 10);
      if (chunk.length === 0) continue;
      const snap = await db.collection("matches").where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
      snap.forEach((d) => { matchesById[d.id] = d.data(); });
    }
    for (const t of tournaments) {
      try {
        const due = t.data.status === "upcoming" && t.data.startAt && Date.now() >= t.data.startAt;
        let needs = due;
        if (t.data.status === "running") needs = resolveBracket(t.data, t.data.bracket, matchesById).changed;
        if (!needs) continue;
        await advanceTournamentServer(t.id, matchesById);
      } catch (e) { logger.error("tournament tick failed", { id: t.id, error: e.message }); }
    }
  });

  const adminStartTournamentNow = onCall(async (request) => {
    const uid = requireAuth(request);
    await requireOwner(uid);
    const { tid } = request.data || {};
    await db.collection("tournaments").doc(cleanId(tid)).update({ startAt: Date.now() - 1000 });
    return { ok: true };
  });

  /* Interrupteur des dépôts (propriétaire seulement). Sans argument "paused",
     renvoie juste l'état actuel. Les coins déjà déposés et les retraits ne
     sont pas touchés. */
  const adminSetDepositsPaused = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireOwner(uid);
    const ref = db.collection("serverConfig").doc("depositsPaused");
    const d = request.data || {};
    if (typeof d.paused === "boolean") {
      await ref.set({ paused: d.paused, by: me.data.username, at: Date.now() });
      await adminLog(uid, me.data.username, d.paused ? "pauseDeposits" : "resumeDeposits", {});
      return { paused: d.paused };
    }
    const s = await ref.get();
    return { paused: !!(s.exists && s.data().paused === true) };
  });

  /* Annulation d'un tournoi — par le serveur (l'état serveur passe à
     "cancelled", ce qui ne peut plus être défait ; les matchs restants sont
     clos par le balayage). Jamais après le paiement des prix. */
  const adminCancelTournament = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireOwner(uid);
    const tid = cleanId((request.data || {}).tid);
    const ref = db.collection("tournaments").doc(tid);
    const srvRef = db.collection("serverTournaments").doc(tid);
    const res = await db.runTransaction(async (tx) => {
      const [snap, srvSnap] = await Promise.all([tx.get(ref), tx.get(srvRef)]);
      if (!snap.exists) throw new HttpsError("not-found", "Tournament not found.");
      const srv = srvSnap.exists ? srvSnap.data() : null;
      if ((srv && (srv.paidAt || srv.status === "finished")) || (!srv && snap.data().paidOut)) {
        throw new HttpsError("failed-precondition", "This tournament is already finished.");
      }
      if (srv && srv.status === "cancelled") return { already: true };
      tx.set(srvRef, { status: "cancelled", at: Date.now() }, { merge: true });
      tx.update(ref, { status: "cancelled", cancelledAt: Date.now() });
      return { ok: true };
    });
    await adminLog(uid, me.data.username, "cancelTournament", { tid });
    return { ok: true, ...res };
  });

  /* Création d'un tournoi — par le serveur, réservé au propriétaire. Les
     prix sont copiés dans tournamentPrizes/{id} (seule source utilisée
     pour payer). */
  const adminCreateTournament = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireOwner(uid);
    const d = request.data || {};
    const str = (v, max) => String(v == null ? "" : v).slice(0, max);
    const name = str(d.name, 60).trim();
    const startAt = Number(d.startAt);
    const regOpensAt = d.regOpensAt ? Number(d.regOpensAt) : null;
    if (!name) throw new HttpsError("invalid-argument", "Give your tournament a name.");
    if (!Number.isFinite(startAt) || startAt < Date.now() + 30 * 1000) throw new HttpsError("invalid-argument", "The start time must be in the future.");
    if (regOpensAt !== null && (!Number.isFinite(regOpensAt) || regOpensAt >= startAt)) throw new HttpsError("invalid-argument", "Registration must open before the tournament starts.");
    const prize = (v) => { const n = Math.round((Number(v) || 0) * 2) / 2; return n > 0 && n <= 100000 ? n : 0; };
    const prizes = { first: prize(d.prizes && d.prizes.first), second: prize(d.prizes && d.prizes.second), semis: prize(d.prizes && d.prizes.semis) };
    const slots = Math.min(128, Math.max(2, parseInt(d.slots, 10) || 16));
    const id = "TR-" + Math.floor(100000 + Math.random() * 900000);
    const t = {
      id, name, createdBy: me.data.username, createdByUid: uid, createdAt: Date.now(),
      regOpensAt, startAt, slots,
      mode: str(d.mode, 40), weapon: str(d.weapon, 40), teamSize: "1v1",
      region: str(d.region, 40), platform: str(d.platform, 40),
      firstTo: Math.min(10, Math.max(1, parseInt(d.firstTo, 10) || 1)),
      simpleEdit: d.simpleEdit !== false,
      prizes, status: "upcoming", players: [], bracket: [], paidOut: false,
    };
    const batch = db.batch();
    batch.set(db.collection("tournaments").doc(id), t);
    batch.set(db.collection("tournamentPrizes").doc(id), { prizes, by: uid, at: Date.now() });
    await batch.commit();
    await adminLog(uid, me.data.username, "createTournament", { id, prizes });
    return { ok: true, id };
  });

  /* Inscription / désinscription à un tournoi — par le serveur : on ne
     peut inscrire QUE soi-même (avant, le site écrivait la liste entière
     et un tricheur pouvait y mettre des pseudos fantômes). */
  const tournamentRegister = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await getVerifiedMe(uid);
    const username = me.data.username;
    if (!(me.data.discordId && me.data.epicLocked)) throw new HttpsError("failed-precondition", "Link your Discord and set your Epic username first.");
    const ref = db.collection("tournaments").doc(cleanId((request.data || {}).tid));
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "This tournament no longer exists.");
      const t = snap.data();
      if (t.status !== "upcoming") throw new HttpsError("failed-precondition", "Registration is closed.");
      if (t.regOpensAt && Date.now() < t.regOpensAt) throw new HttpsError("failed-precondition", "Registration isn't open yet.");
      const players = t.players || [];
      if (players.includes(username)) return { ok: true, already: true };
      if (players.length >= (t.slots || 16)) throw new HttpsError("failed-precondition", "This tournament is full.");
      tx.update(ref, { players: [...players, username] });
      return { ok: true };
    });
  });

  const tournamentUnregister = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await getVerifiedMe(uid, { allowBanned: true });
    const username = me.data.username;
    const ref = db.collection("tournaments").doc(cleanId((request.data || {}).tid));
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: true };
      const t = snap.data();
      if (t.status !== "upcoming") throw new HttpsError("failed-precondition", "The tournament has already started.");
      tx.update(ref, { players: (t.players || []).filter((p) => p !== username) });
      return { ok: true };
    });
  });

  /* Ajout / retrait d'un modérateur — réservé au propriétaire (vérifié par
     UID). Met à jour la liste serveur (qui fait foi) ET celle du site. */
  const adminSetModerator = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireOwner(uid);
    const { username, action } = request.data || {};
    const name = String(username || "").trim();
    if (!name || name === SUPER_ADMIN) throw new HttpsError("invalid-argument", "Invalid username.");
    if (action === "add" && !(await ownerUidOf(name))) throw new HttpsError("not-found", "This player doesn't exist.");
    await serverModerators(); // initialise la liste serveur si besoin
    const op = action === "add" ? FieldValue.arrayUnion(name) : FieldValue.arrayRemove(name);
    await db.collection("serverConfig").doc("moderators").set({ usernames: op }, { merge: true });
    await db.collection("config").doc("moderators").set({ usernames: op }, { merge: true });
    await syncModeratorUids();
    await adminLog(uid, me.data.username, action === "add" ? "addModerator" : "removeModerator", { username: name });
    return { ok: true };
  });

  /* =========================================================
     RETRAITS — la demande RÉSERVE les coins tout de suite (ils sortent du
     solde et ne peuvent plus être joués ni envoyés). Le staff paie, puis
     marque la demande "payée" ; s'il la refuse, les coins sont rendus.
  ========================================================= */
  const WITHDRAW_MIN = 15;
  // Empêche de retirer des coins obtenus uniquement avec des comptes
  // jetables (roue quotidienne). Mettre false pour désactiver.
  const WITHDRAW_REQUIRES_DEPOSIT = true;
  const requestWithdrawal = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await getVerifiedMe(uid);
    const amount = Math.floor(Number((request.data || {}).amount));
    if (!Number.isFinite(amount) || amount < WITHDRAW_MIN || amount > 100000) {
      throw new HttpsError("invalid-argument", `The minimum withdrawal is ${WITHDRAW_MIN} coins.`);
    }
    if (WITHDRAW_REQUIRES_DEPOSIT && !(Number(me.data.tournamentPrizeTotal) > 0)) {
      const dep = await db.collection("deposits").where("uid", "==", uid).limit(1).get();
      if (dep.empty) throw new HttpsError("failed-precondition", "You need to have made at least one deposit before withdrawing.");
    }
    const userRef = db.collection("users").doc(uid);
    const wRef = db.collection("withdrawals").doc();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const u = snap.data() || {};
      if (u.pendingWithdrawalId) {
        const pw = await tx.get(db.collection("withdrawals").doc(String(u.pendingWithdrawalId)));
        if (pw.exists && pw.data().status === "pending") throw new HttpsError("failed-precondition", "You already have a pending withdrawal. Wait until staff handles it.");
      }
      const coins = u.coins || 0;
      if (coins < amount) throw new HttpsError("failed-precondition", "Not enough coins.");
      tx.update(userRef, { coins: roundToCents(coins - amount), pendingWithdrawalId: wRef.id });
      tx.set(wRef, {
        id: wRef.id, uid, username: me.data.username, epic: me.data.epic || null,
        discordUsername: me.data.discordUsername || null, amount, status: "pending", createdAt: Date.now(),
      });
    });
    return { ok: true, id: wRef.id };
  });

  const adminListWithdrawals = onCall(async (request) => {
    const uid = requireAuth(request);
    await requireAdmin(uid);
    const snap = await db.collection("withdrawals").where("status", "==", "pending").limit(200).get();
    const items = snap.docs.map((d) => d.data()).sort((a, b) => a.createdAt - b.createdAt);
    // Infos utiles pour décider : compte suspendu ? solde actuel ?
    for (const it of items) {
      try { const u = await db.collection("users").doc(it.uid).get(); const ud = u.data() || {};
        it.banned = !!ud.banned; it.balance = Number(ud.coins) || 0; } catch (e) { /* ignore */ }
    }
    return { ok: true, items };
  });

  const adminResolveWithdrawal = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await requireAdmin(uid);
    const { id, action } = request.data || {};
    if (action !== "paid" && action !== "rejected") throw new HttpsError("invalid-argument", "Invalid action.");
    const wRef = db.collection("withdrawals").doc(cleanId(id));
    const res = await db.runTransaction(async (tx) => {
      const w = await tx.get(wRef);
      if (!w.exists) throw new HttpsError("not-found", "Withdrawal not found.");
      const d = w.data();
      if (d.status !== "pending") return { already: d.status };
      if (d.uid === uid && (await adminLevelOf(uid, me.data.username)) !== "owner") throw new HttpsError("permission-denied", "Another moderator must handle your own withdrawal.");
      const userRef = db.collection("users").doc(d.uid);
      const u = await tx.get(userRef);
      const ud = u.data() || {};
      if (action === "paid" && (ud.banned || (Number(ud.coins) || 0) < 0)) {
        throw new HttpsError("failed-precondition", "This account is suspended or has a negative balance (payment dispute?). Don't pay — decline or check first.");
      }
      const notifs = (ud.notifications || []).slice(0, 29);
      const text = action === "paid" ? `Your withdrawal of ${d.amount} coins has been paid.` : `Your withdrawal of ${d.amount} coins was declined — the coins are back on your balance.`;
      const userUpdate = { notifications: [{ id: "w" + Date.now(), type: action === "paid" ? "tip" : "warning", text, at: Date.now(), read: false }, ...notifs] };
      if (action === "rejected") userUpdate.coins = FieldValue.increment(d.amount);
      if (ud.pendingWithdrawalId === d.id) userUpdate.pendingWithdrawalId = null;
      tx.set(userRef, userUpdate, { merge: true });
      tx.update(wRef, { status: action, resolvedBy: me.data.username, resolvedAt: Date.now() });
      return { ok: true };
    });
    await adminLog(uid, me.data.username, "withdrawal_" + action, { id });
    return res;
  });

  return {
    requestWithdrawal, adminListWithdrawals, adminResolveWithdrawal,
    initAccount, selfEcoReset,
    usernameAvailable, lookupUsername, matchCreate, matchJoin, matchEscrow, matchTryLock, matchDeclareResult, sweepMatchTimers, matchCancelVote, matchLeave, matchRematch,
    matchFileCheaterReport, matchAdminReportDecision, matchAdminResolveDispute, matchAdminDelete,
    spinWheel, shopPurchase, useSnipe, sendTip, adminCancelTournament, adminSetDepositsPaused, emailVerificationStatus,
    adminAdjustCoins, adminResetEconomy, adminSetVip, adminGiveSelfSnipes,
    tournamentTick, adminStartTournamentNow, adminCreateTournament, tournamentRegister, tournamentUnregister,
    adminSetModerator,
  };
};
