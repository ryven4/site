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

  async function isAdminUsername(username) {
    if (!username) return false;
    if (username === SUPER_ADMIN) return true;
    const modsSnap = await db.collection("config").doc("moderators").get();
    const list = (modsSnap.exists && modsSnap.data().usernames) || [];
    return list.includes(username);
  }

  async function requireAdmin(uid) {
    const me = await getMe(uid);
    if (!(await isAdminUsername(me.data.username))) {
      throw new HttpsError("permission-denied", "Moderators only.");
    }
    return me;
  }

  function matchRoster(match) {
    const hostPlayers = match.hostPlayers || [match.host];
    const guestPlayers = match.guestPlayers || (match.players || []).filter((p) => p !== match.host);
    return { hostPlayers, guestPlayers };
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

  async function resolveUidMap(usernames) {
    const unique = [...new Set(usernames.filter(Boolean))];
    if (unique.length === 0) return {};
    const map = {};
    for (let i = 0; i < unique.length; i += 30) {
      const chunk = unique.slice(i, i + 30);
      const snap = await db.collection("users").where("username", "in", chunk).get();
      snap.forEach((d) => { map[d.data().username] = d.id; });
    }
    return map;
  }

  /* =========================================================
     ESCROW — débite la mise d'UN joueur pour UN match, une seule fois.
     Appelée par le site : juste après la création d'un match (pour le
     host) et juste après avoir rejoint un match (pour chaque invité).
     Idempotente : rappeler cette fonction pour un joueur déjà débité ne
     fait rien de plus (elle vérifie escrowedBy avant de toucher aux coins).
  ========================================================= */
  const matchEscrow = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = String((request.data || {}).matchId || "");
    if (!matchId) throw new HttpsError("invalid-argument", "matchId is required.");
    const matchRef = db.collection("matches").doc(matchId);
    const userRef = db.collection("users").doc(uid);

    return db.runTransaction(async (tx) => {
      const [matchSnap, userSnap] = await Promise.all([tx.get(matchRef), tx.get(userRef)]);
      if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found.");
      if (!userSnap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
      const match = matchSnap.data();
      const me = userSnap.data();
      const username = me.username;
      if (match.completed || match.cancelled) return { ok: true, skipped: "over" };

      const { hostPlayers, guestPlayers } = matchRoster(match);
      if (!hostPlayers.includes(username) && !guestPlayers.includes(username)) {
        throw new HttpsError("permission-denied", "You're not part of this match.");
      }

      const escrowedBy = match.escrowedBy || [];
      if (escrowedBy.includes(username)) return { ok: true, alreadyEscrowed: true };

      const info = computePlayerBetInfo(match, username);
      const stake = Math.min(me.coins || 0, info.stake);
      if (stake > 0) tx.update(userRef, { coins: roundToCents((me.coins || 0) - stake) });
      tx.update(matchRef, {
        escrowedBy: FieldValue.arrayUnion(username),
        [`escrowAmounts.${username}`]: stake,
      });
      return { ok: true, stake };
    });
  });

  /* Verrouille le match dès que les deux camps sont au complet et prêts
     (pas d'argent en jeu ici — juste un indicateur d'état). */
  const matchTryLock = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = String((request.data || {}).matchId || "");
    const matchRef = db.collection("matches").doc(matchId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = snap.data();
      if (match.locked) return { ok: true, locked: true };
      const { hostPlayers, guestPlayers } = matchRoster(match);
      const maxPerSide = TEAM_SIZE_MAX[match.teamSize] || 1;
      const all = [...hostPlayers, ...guestPlayers];
      const readies = match.readies || {};
      const rosterFull = hostPlayers.length >= maxPerSide && guestPlayers.length >= maxPerSide;
      const allReady = all.length > 0 && all.every((p) => readies[p]);
      if (!(rosterFull && allReady)) return { ok: true, locked: false };
      tx.update(matchRef, { locked: true });
      return { ok: true, locked: true };
    });
  });

  /* =========================================================
     FINALISATION — calcule et paie le résultat d'un match pour TOUS les
     joueurs concernés (gagnants + perdants) en une seule transaction.
     Auto-escrowe au passage quiconque n'aurait pas encore payé sa mise
     (garde-fou de robustesse — en pratique, escrow a déjà eu lieu à la
     création/au join). Idempotente (match.completed empêche un 2e passage).
  ========================================================= */
  async function finalizeMatch(matchId, winners, losers) {
    const matchRef = db.collection("matches").doc(matchId);
    const uidMap = await resolveUidMap([...winners, ...losers]);

    await db.runTransaction(async (tx) => {
      const matchSnap = await tx.get(matchRef);
      if (!matchSnap.exists) return;
      const match = matchSnap.data();
      if (match.completed || match.cancelled) return;

      const allUsernames = [...winners, ...losers];
      const userRefs = {};
      const userData = {};
      for (const uname of allUsernames) {
        const uid = uidMap[uname];
        if (!uid) continue;
        const ref = db.collection("users").doc(uid);
        const snap = await tx.get(ref);
        if (!snap.exists) continue;
        userRefs[uname] = ref;
        userData[uname] = snap.data();
      }

      const escrowedBy = match.escrowedBy || [];
      const escrowAmounts = { ...(match.escrowAmounts || {}) };
      for (const uname of allUsernames) {
        if (escrowedBy.includes(uname) || !userData[uname]) continue;
        const info = computePlayerBetInfo(match, uname);
        const stake = Math.min(userData[uname].coins || 0, info.stake);
        userData[uname].coins = roundToCents((userData[uname].coins || 0) - stake);
        escrowAmounts[uname] = stake;
        escrowedBy.push(uname);
      }

      const results = {};
      winners.forEach((u) => { results[u] = "WIN"; });
      losers.forEach((u) => { results[u] = "LOSS"; });

      for (const uname of winners) {
        const ref = userRefs[uname];
        if (!ref) continue;
        const data = userData[uname];
        const info = computePlayerBetInfo(match, uname);
        // Taxe de plateforme de 5% sur ce que le gagnant touche réellement
        // (mise récupérée incluse) — voir MATCH_TAX_RATE plus haut. S'applique
        // pareil en 1v1, 2v2/3v3/4v4 et avec cover bet, puisque chaque
        // gagnant a déjà son propre winReward individuel calculé plus haut.
        const reward = roundToCents(info.winReward * (1 - MATCH_TAX_RATE));
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

      tx.update(matchRef, {
        escrowedBy, escrowAmounts, results, completed: true, victoryClaim: null, disputed: false,
      });
    });
  }

  /* Rembourse tout le monde qui avait payé une mise sur un match qui
     n'ira jamais à son terme (annulation). Idempotente. */
  async function refundMatch(matchId) {
    const matchRef = db.collection("matches").doc(matchId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) return;
      const m = snap.data();
      const escrowedBy = m.escrowedBy || [];
      const refundedBy = m.refundedBy || [];
      const toRefund = escrowedBy.filter((u) => !refundedBy.includes(u));
      if (toRefund.length === 0) { tx.update(matchRef, { cancelled: true }); return; }
      const uidMap = await resolveUidMap(toRefund);
      for (const uname of toRefund) {
        const amount = (m.escrowAmounts && m.escrowAmounts[uname]) || 0;
        const uid = uidMap[uname];
        if (uid && amount > 0) {
          tx.update(db.collection("users").doc(uid), { coins: FieldValue.increment(amount) });
        }
      }
      tx.update(matchRef, { cancelled: true, refundedBy: [...refundedBy, ...toRefund] });
    });
  }

  /* =========================================================
     DÉCLARATION DE RÉSULTAT — "J'ai perdu" (immédiat) / "J'ai gagné"
     (réclamation avec timer, ou litige si l'adversaire a aussi réclamé).
  ========================================================= */
  const matchDeclareResult = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId, result } = request.data || {};
    if (!matchId || (result !== "WIN" && result !== "LOSS")) {
      throw new HttpsError("invalid-argument", "matchId and result ('WIN'|'LOSS') are required.");
    }
    const me = await getMe(uid);
    const username = me.data.username;
    const isVip = !!(me.data.vipUntil && me.data.vipUntil > Date.now());
    const matchRef = db.collection("matches").doc(matchId);

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
      const myTeam = onHost ? hostPlayers : guestPlayers;
      const otherTeam = onHost ? guestPlayers : hostPlayers;

      if (result === "LOSS") return { status: "finalize", winners: otherTeam, losers: myTeam };

      if (match.victoryClaim && match.victoryClaim.by === username) return { status: "already_claimed" };
      if (match.victoryClaim && myTeam.includes(match.victoryClaim.by)) return { status: "teammate_claimed" };
      if (match.victoryClaim && otherTeam.includes(match.victoryClaim.by)) {
        tx.update(matchRef, { disputed: true });
        return { status: "disputed" };
      }
      const timerMs = isVip ? VIP_VICTORY_TIMER_MS : VICTORY_TIMER_MS;
      tx.update(matchRef, { victoryClaim: { by: username, at: Date.now(), timerMs } });
      return { status: "claimed", timerMs };
    });

    if (outcome.status === "finalize") {
      await finalizeMatch(matchId, outcome.winners, outcome.losers);
      return { status: "finalized" };
    }
    return outcome;
  });

  /* Balaie toutes les 2 minutes les matchs dont le timer de réclamation
     de victoire a expiré, et confirme la victoire automatiquement. */
  const sweepMatchTimers = onSchedule("every 2 minutes", async () => {
    const snap = await db.collection("matches")
      .where("completed", "==", false)
      .where("cancelled", "==", false)
      .where("locked", "==", true)
      .get();
    const now = Date.now();
    for (const doc of snap.docs) {
      const match = doc.data();
      if (!match.victoryClaim || match.disputed) continue;
      if (match.cheaterReport && match.cheaterReport.status === "pending") continue;
      const elapsed = now - match.victoryClaim.at;
      const timerMs = match.victoryClaim.timerMs || VICTORY_TIMER_MS;
      if (elapsed < timerMs) continue;
      const { hostPlayers, guestPlayers } = matchRoster(match);
      const claimant = match.victoryClaim.by;
      const winners = hostPlayers.includes(claimant) ? hostPlayers : guestPlayers;
      const losers = hostPlayers.includes(claimant) ? guestPlayers : hostPlayers;
      try { await finalizeMatch(doc.id, winners, losers); } catch (e) { logger.error("sweep finalize failed", { id: doc.id, error: e.message }); }
    }

    // Nettoyage : matchs OPEN jamais verrouillés au-delà de 30 min → annulés + remboursés.
    const expiredSnap = await db.collection("matches")
      .where("completed", "==", false).where("cancelled", "==", false).where("locked", "==", false).get();
    for (const doc of expiredSnap.docs) {
      const m = doc.data();
      if (m.tournamentId) continue;
      const createdAt = m.createdAt || now;
      if (now - createdAt >= MATCH_TTL_MS) {
        try { await refundMatch(doc.id); } catch (e) { logger.error("sweep expire failed", { id: doc.id, error: e.message }); }
      }
    }
  });

  /* =========================================================
     ANNULATION — vote à deux (match verrouillé) OU départ simple
     (match pas encore verrouillé). Rembourse tout ce qui a été escrowé.
  ========================================================= */
  const matchCancelVote = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = String((request.data || {}).matchId || "");
    const me = await getMe(uid);
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);

    const doRefund = await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) return false;
      const match = snap.data();
      if (match.completed || match.cancelled) return false;
      const { hostPlayers, guestPlayers } = matchRoster(match);
      const all = [...hostPlayers, ...guestPlayers];
      if (!all.includes(username)) throw new HttpsError("permission-denied", "Not part of this match.");
      if (match.victoryClaim || match.disputed) throw new HttpsError("failed-precondition", "A result is already in progress.");
      const cancelVotes = { ...(match.cancelVotes || {}) };
      cancelVotes[username] = !cancelVotes[username];
      const bothVoted = all.length > 1 && all.every((p) => cancelVotes[p]);
      if (bothVoted) { tx.update(matchRef, { cancelVotes }); return true; }
      tx.update(matchRef, { cancelVotes });
      return false;
    });

    if (doRefund) { await refundMatch(matchId); return { status: "cancelled" }; }
    return { status: "voted" };
  });

  /* Quitter un match : forfait (si verrouillé), sinon retrait simple +
     remboursement de ce qu'on avait déjà escrowé (et annulation si plus
     personne côté host). */
  const matchLeave = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = String((request.data || {}).matchId || "");
    const me = await getMe(uid);
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);

    const plan = await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) return { status: "gone" };
      const match = snap.data();
      if (match.completed) return { status: "completed" };

      const { hostPlayers, guestPlayers } = matchRoster(match);
      const isHost = hostPlayers.includes(username);
      const isGuest = guestPlayers.includes(username);
      if (!isHost && !isGuest) return { status: "not_in_match" };

      if (match.locked) {
        if (match.victoryClaim || match.disputed) return { status: "result_in_progress" };
        const myTeam = isHost ? hostPlayers : guestPlayers;
        const otherTeam = isHost ? guestPlayers : hostPlayers;
        if (myTeam.length === 0 || otherTeam.length === 0) return { status: "cancel", full: true };
        return { status: "forfeit", winners: otherTeam, losers: myTeam };
      }

      // Pas encore verrouillé : simple retrait.
      const newHostPlayers = isHost ? hostPlayers.filter((p) => p !== username) : hostPlayers;
      const newGuestPlayers = isGuest ? guestPlayers.filter((p) => p !== username) : guestPlayers;
      const readies = { ...(match.readies || {}) };
      delete readies[username];
      const cancelVotes = { ...(match.cancelVotes || {}) };
      delete cancelVotes[username];

      if (isHost && newHostPlayers.length === 0) {
        // Le dernier joueur côté host part : le match n'a plus d'hôte.
        return { status: "cancel", full: true };
      }
      tx.update(matchRef, {
        hostPlayers: newHostPlayers, guestPlayers: newGuestPlayers,
        players: [...newHostPlayers, ...newGuestPlayers], readies, cancelVotes,
      });
      return { status: "left" };
    });

    if (plan.status === "forfeit") { await finalizeMatch(matchId, plan.winners, plan.losers); return { status: "forfeit" }; }
    if (plan.status === "cancel") { await refundMatch(matchId); return { status: "cancelled" }; }
    return plan;
  });

  /* =========================================================
     SIGNALEMENT DE TRICHE
  ========================================================= */
  const matchFileCheaterReport = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = String((request.data || {}).matchId || "");
    const me = await getMe(uid);
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = snap.data();
      const { hostPlayers, guestPlayers } = matchRoster(match);
      const onHost = hostPlayers.includes(username);
      const onGuest = guestPlayers.includes(username);
      if (!onHost && !onGuest) throw new HttpsError("permission-denied", "Only match participants can file a report.");
      if (match.cheaterReport && match.cheaterReport.status === "pending") {
        throw new HttpsError("failed-precondition", "A report is already pending.");
      }
      tx.update(matchRef, {
        cheaterReport: { by: username, against: onHost ? guestPlayers : hostPlayers, at: Date.now(), status: "pending" },
      });
    });
    return { ok: true };
  });

  const matchAdminReportDecision = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId, decision } = request.data || {}; // 'dismiss' | 'confirm'
    const me = await requireAdmin(uid);
    await db.collection("matches").doc(matchId).update({
      "cheaterReport.status": decision === "confirm" ? "confirmed" : "dismissed",
      "cheaterReport.resolvedBy": me.data.username,
      "cheaterReport.resolvedAt": Date.now(),
    });
    return { ok: true };
  });

  const matchAdminResolveDispute = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId, winnerUsername } = request.data || {};
    await requireAdmin(uid);
    const matchSnap = await db.collection("matches").doc(matchId).get();
    if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found.");
    const match = matchSnap.data();
    const { hostPlayers, guestPlayers } = matchRoster(match);
    const winners = hostPlayers.includes(winnerUsername) ? hostPlayers : guestPlayers;
    const losers = hostPlayers.includes(winnerUsername) ? guestPlayers : hostPlayers;
    if (winners.length === 0) throw new HttpsError("invalid-argument", "Unknown winner.");
    await finalizeMatch(matchId, winners, losers);
    return { ok: true };
  });

  /* =========================================================
     REMATCH — après un match terminé, chaque participant peut cliquer
     "Rematch". Dès que TOUS les joueurs des DEUX équipes ont cliqué
     (compté via matchRoster, donc ça marche pareil en 1v1/2v2/3v3/4v4),
     un nouveau match est créé automatiquement avec les mêmes équipes,
     la même mise et le même cover bet que le match d'origine. Idempotent :
     si le rematch a déjà été créé (rematchMatchId déjà posé), on renvoie
     juste son id sans jamais en recréer un deuxième.
  ========================================================= */
  const matchRematch = onCall(async (request) => {
    const uid = requireAuth(request);
    const matchId = String((request.data || {}).matchId || "");
    if (!matchId) throw new HttpsError("invalid-argument", "matchId is required.");
    const me = await getMe(uid);
    const username = me.data.username;
    const matchRef = db.collection("matches").doc(matchId);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(matchRef);
      if (!snap.exists) throw new HttpsError("not-found", "Match not found.");
      const match = snap.data();
      if (!match.completed) throw new HttpsError("failed-precondition", "This match isn't finished yet.");

      if (match.rematchMatchId) return { status: "already_created", newMatchId: match.rematchMatchId };

      const { hostPlayers, guestPlayers } = matchRoster(match);
      const all = [...hostPlayers, ...guestPlayers];
      if (!all.includes(username)) throw new HttpsError("permission-denied", "You weren't part of this match.");

      const votes = { ...(match.rematchVotes || {}), [username]: true };
      const everyoneIn = all.length > 0 && all.every((p) => votes[p]);

      if (!everyoneIn) {
        tx.update(matchRef, { rematchVotes: votes });
        return { status: "waiting", votes: Object.keys(votes).length, total: all.length };
      }

      const newId = "M-" + Math.random().toString(36).slice(2, 8).toUpperCase() +
        Math.random().toString(36).slice(2, 4).toUpperCase();
      const newMatch = {
        id: newId,
        host: match.host,
        hostEpic: match.hostEpic || "N/A",
        hostStats: match.hostStats || {},
        visibility: match.visibility || "public",
        passcode: match.passcode || null,
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
        rematchOf: matchId,
      };
      tx.set(db.collection("matches").doc(newId), newMatch);
      tx.update(matchRef, { rematchVotes: votes, rematchMatchId: newId });
      return { status: "created", newMatchId: newId };
    });
  });

  const matchAdminDelete = onCall(async (request) => {
    const uid = requireAuth(request);
    const { matchId } = request.data || {};
    await requireAdmin(uid);
    const matchSnap = await db.collection("matches").doc(matchId).get();
    if (matchSnap.exists) {
      const match = matchSnap.data();
      if ((match.escrowedBy || []).length > (match.refundedBy || []).length) await refundMatch(matchId);
    }
    await db.collection("matches").doc(matchId).delete();
    return { ok: true };
  });

  /* =========================================================
     ROUE QUOTIDIENNE
  ========================================================= */
  const spinWheel = onCall(async (request) => {
    const uid = requireAuth(request);
    const userRef = db.collection("users").doc(uid);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
      const me = snap.data();
      const admin_ = await isAdminUsername(me.username);
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
    const { item, avatarId } = request.data || {};
    const userRef = db.collection("users").doc(uid);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
      const me = snap.data();
      const coins = me.coins || 0;

      if (item === "avatar") {
        const price = AVATAR_PRICES[avatarId];
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
          update.coins = roundToCents(update.coins + 3);
          bonus = "coins:3";
        }
        tx.update(userRef, update);
        return { ok: true, bonus };
      }
      throw new HttpsError("invalid-argument", "Unknown item.");
    });
  });

  const useSnipe = onCall(async (request) => {
    const uid = requireAuth(request);
    const userRef = db.collection("users").doc(uid);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new HttpsError("failed-precondition", "Profile not found.");
      const snipes = snap.data().snipes || 0;
      if (snipes <= 0) throw new HttpsError("failed-precondition", "No snipes left.");
      tx.update(userRef, { snipes: snipes - 1 });
      return { ok: true };
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
    const avatars = starterAvatar && starterAvatar !== "default" ? ["default", String(starterAvatar)] : ["default"];
    await userRef.update({
      stats: { ...EMPTY_STATS },
      coins: 0,
      ownedAvatars: avatars,
      customAvatarUnlocked: false,
      snipes: 0,
      vipUntil: null,
      rp: 0,
      ecoResetVersion: ECO_RESET_VERSION,
      history: [],
      settledMatchIds: [],
      lastWheelSpin: null,
    });
    return { ok: true };
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

    const meRef = db.collection("users").doc(uid);
    const targetQuery = await db.collection("users").where("username", "==", targetUsername).limit(1).get();
    if (targetQuery.empty) throw new HttpsError("not-found", "This player doesn't exist.");
    const targetRef = targetQuery.docs[0].ref;
    if (targetRef.id === uid) throw new HttpsError("invalid-argument", "You can't tip yourself.");

    return db.runTransaction(async (tx) => {
      const meSnap = await tx.get(meRef);
      const me = meSnap.data();
      if ((me.coins || 0) < amount) throw new HttpsError("failed-precondition", "Not enough coins.");
      const isVip = !!(me.vipUntil && me.vipUntil > Date.now());
      const fee = isVip ? 0 : roundToCents(amount * 0.05);
      const net = roundToCents(amount - fee);
      const targetSnap = await tx.get(targetRef);
      const targetData = targetSnap.data() || {};
      tx.update(meRef, { coins: roundToCents((me.coins || 0) - amount) });
      tx.update(targetRef, {
        coins: roundToCents((targetData.coins || 0) + net),
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
  const adminAdjustCoins = onCall(async (request) => {
    const uid = requireAuth(request);
    await requireAdmin(uid);
    const { targetUsername, amount: rawAmount } = request.data || {};
    const amount = roundToCents(Number(rawAmount));
    if (!amount) throw new HttpsError("invalid-argument", "Invalid amount.");
    const q = await db.collection("users").where("username", "==", targetUsername).limit(1).get();
    if (q.empty) throw new HttpsError("not-found", "Player not found.");
    const ref = q.docs[0].ref;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const coins = (snap.data() || {}).coins || 0;
      if (amount < 0 && roundToCents(coins + amount) < 0) throw new HttpsError("failed-precondition", "Not enough coins on that account.");
      tx.update(ref, { coins: roundToCents(coins + amount) });
    });
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
    await userRef.update({ coins: 0, snipes: 0, vipUntil: null, ecoResetVersion: ECO_RESET_VERSION });
    return { ok: true };
  });

  const adminResetEconomy = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await getMe(uid);
    if (me.data.username !== SUPER_ADMIN) throw new HttpsError("permission-denied", "Owner only.");
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
    await requireAdmin(uid);
    const { targetUsername, action, days } = request.data || {}; // action: 'grant' | 'revoke'
    const q = await db.collection("users").where("username", "==", targetUsername).limit(1).get();
    if (q.empty) throw new HttpsError("not-found", "Player not found.");
    const ref = q.docs[0].ref;
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
    await requireAdmin(uid);
    const n = Number((request.data || {}).amount);
    if (!n || n <= 0) throw new HttpsError("invalid-argument", "Invalid amount.");
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
      hostPlayers: [a], guestPlayers: [b], readies: {}, results: {}, processedBy: [],
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
  function tournamentPayoutList(t, bracket) {
    const p = t.prizes || {};
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

  async function advanceTournamentServer(tid, matchesById) {
    const ref = db.collection("tournaments").doc(tid);
    const preSnap = await ref.get();
    if (!preSnap.exists) return;
    const pre = preSnap.data();
    let uidMap = {};
    if (pre.status === "running") {
      const sim = resolveBracket(pre, pre.bracket || [], matchesById);
      if (sim.finalWinner) uidMap = await resolveUidMap(tournamentPayoutList(pre, sim.bracket).map((p) => p.name));
    }
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const t = snap.data();
      let bracket = t.bracket || [];
      const update = {};
      if (t.status === "upcoming") {
        if (!(t.startAt && Date.now() >= t.startAt)) return;
        const players = t.players || [];
        if (players.length < 2) { tx.update(ref, { status: "cancelled", cancelReason: "Not enough players" }); return; }
        bracket = buildInitialBracket(players);
        update.status = "running"; update.startedAt = Date.now();
      } else if (t.status !== "running") return;

      const res = resolveBracket(t, bracket, matchesById);
      if (!res.changed && t.status === "running") return;
      res.newMatches.forEach((m) => tx.set(db.collection("matches").doc(m.id), m));
      update.bracket = res.bracket;
      if (res.finalWinner) {
        update.status = "finished"; update.winner = res.finalWinner; update.finishedAt = Date.now();
        if (!t.paidOut) {
          const payouts = tournamentPayoutList(t, res.bracket);
          const paid = [];
          payouts.forEach((pay) => {
            const payUid = uidMap[pay.name];
            if (payUid) { tx.update(db.collection("users").doc(payUid), { coins: FieldValue.increment(pay.amount) }); paid.push(pay); }
          });
          update.paidOut = true; update.payouts = paid;
        }
      }
      tx.update(ref, update);
    });
  }

  const tournamentTick = onSchedule("every 1 minutes", async () => {
    const tSnap = await db.collection("tournaments").where("status", "in", ["upcoming", "running"]).get();
    if (tSnap.empty) return;
    const tournaments = tSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const matchIds = new Set();
    tournaments.forEach((t) => (t.data.bracket || []).forEach((e) => { if (e.matchId) matchIds.add(e.matchId); }));
    const matchesById = {};
    const idList = [...matchIds];
    for (let i = 0; i < idList.length; i += 10) {
      const chunk = idList.slice(i, i + 10);
      if (chunk.length === 0) continue;
      const snap = await db.collection("matches").where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
      snap.forEach((d) => { matchesById[d.id] = d.data(); });
    }
    for (const t of tournaments) {
      const due = t.data.status === "upcoming" && t.data.startAt && Date.now() >= t.data.startAt;
      let needs = due;
      if (t.data.status === "running") needs = resolveBracket(t.data, t.data.bracket || [], matchesById).changed;
      if (!needs) continue;
      try { await advanceTournamentServer(t.id, matchesById); } catch (e) { logger.error("tournament tick failed", { id: t.id, error: e.message }); }
    }
  });

  const adminStartTournamentNow = onCall(async (request) => {
    const uid = requireAuth(request);
    const me = await getMe(uid);
    if (me.data.username !== SUPER_ADMIN) throw new HttpsError("permission-denied", "Owner only.");
    const { tid } = request.data || {};
    await db.collection("tournaments").doc(tid).update({ startAt: Date.now() - 1000 });
    return { ok: true };
  });

  return {
    initAccount, selfEcoReset,
    matchEscrow, matchTryLock, matchDeclareResult, sweepMatchTimers, matchCancelVote, matchLeave, matchRematch,
    matchFileCheaterReport, matchAdminReportDecision, matchAdminResolveDispute, matchAdminDelete,
    spinWheel, shopPurchase, useSnipe, sendTip,
    adminAdjustCoins, adminResetEconomy, adminSetVip, adminGiveSelfSnipes,
    tournamentTick, adminStartTournamentNow,
  };
};
