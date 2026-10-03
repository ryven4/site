/**
 * Prime Token — Cloud Functions
 * ================================================================
 * Ce dossier est le seul endroit du projet où de l'argent réel est
 * manipulé. Tout se passe ici, JAMAIS dans index.html (le site) :
 * un site statique ne peut pas garder un secret (clé Stripe) ni être
 * fait confiance pour dire "j'ai payé, crédite-moi" — n'importe qui
 * pourrait appeler ce code lui-même sans payer. Ici, à l'inverse, la
 * clé secrète Stripe n'existe que sur le serveur Google, et les coins
 * ne sont crédités qu'après que STRIPE LUI-MÊME confirme le paiement
 * via un webhook signé.
 *
 * Deux fonctions :
 *  - createCheckoutSession : appelée par le site quand un joueur
 *    clique "Payer" ; crée une session de paiement Stripe et renvoie
 *    son URL. Ne crédite RIEN.
 *  - stripeWebhook : appelée par Stripe (pas par le site, pas par le
 *    joueur) quand un paiement est confirmé. C'est la SEULE fonction
 *    qui crédite des coins.
 * ================================================================
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// Économie serveur (coins, snipes, VIP, avatars, matchs, tournois) — voir
// economy.js pour le détail et pourquoi c'est désormais ici et plus dans
// le site.
Object.assign(exports, require("./economy.js")(admin, db));

// Secrets Stripe — jamais dans le code, jamais sur GitHub. Configurés une
// fois via `firebase functions:secrets:set` (voir le guide de déploiement).
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

// URL publique du site (redirection après paiement) et limites de dépôt.
const SITE_URL = "https://ryven4.github.io/site/";
const MIN_DEPOSIT_COINS = 1;
const MAX_DEPOSIT_COINS = 500; // = 500 € max par paiement (même limite que côté site)
const COIN_PRICE_EUR = 1; // 1 coin = 1 €, doit rester identique à COIN_PRICE_EUR dans index.html

/* =========================================================
   1) createCheckoutSession — crée une session de paiement Stripe.
   Appelée depuis le site via firebase.functions().httpsCallable(...).
   Ne touche à AUCUN coin. Renvoie juste une URL Stripe où rediriger
   le joueur pour qu'il paie par carte.
========================================================= */
exports.createCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    // Le joueur doit être connecté sur le site (sinon on ne sait pas à
    // quel compte créditer les coins plus tard).
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError("unauthenticated", "You must be logged in to make a deposit.");
    }
    const uid = request.auth.uid;

    const coins = Math.floor(Number(request.data && request.data.coins));
    if (!Number.isFinite(coins) || coins < MIN_DEPOSIT_COINS || coins > MAX_DEPOSIT_COINS) {
      throw new HttpsError(
        "invalid-argument",
        `Amount must be between ${MIN_DEPOSIT_COINS} and ${MAX_DEPOSIT_COINS} coins.`
      );
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY.value(), { apiVersion: "2024-06-20" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `${coins} Prime Token Coins` },
            unit_amount: Math.round(coins * COIN_PRICE_EUR * 100), // centimes
          },
          quantity: 1,
        },
      ],
      // On stocke QUI paie et COMBIEN de coins directement sur la session,
      // pour que le webhook (qui ne reçoit que l'ID Stripe) sache quoi
      // créditer sans jamais faire confiance à une valeur venant du site.
      client_reference_id: uid,
      metadata: { uid, coins: String(coins) },
      success_url: `${SITE_URL}?deposit=success`,
      cancel_url: `${SITE_URL}?deposit=cancelled`,
    });

    logger.info("Checkout session created", { uid, coins, sessionId: session.id });
    return { url: session.url };
  }
);

/* =========================================================
   2) stripeWebhook — appelée UNIQUEMENT par les serveurs de Stripe,
   jamais par le site ni le joueur. C'est ici, et seulement ici, que
   les coins sont crédités — après vérification cryptographique de la
   signature Stripe (impossible à falsifier sans la clé secrète du
   webhook), et de façon protégée contre les doublons (Stripe peut
   renvoyer le même événement plusieurs fois en cas de coupure réseau).
========================================================= */
exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const stripe = new Stripe(STRIPE_SECRET_KEY.value(), { apiVersion: "2024-06-20" });

    let event;
    try {
      const signature = req.headers["stripe-signature"];
      // req.rawBody : fourni automatiquement par Cloud Functions v2, le
      // corps BRUT (non parsé) est obligatoire pour vérifier la signature.
      event = stripe.webhooks.constructEvent(req.rawBody, signature, STRIPE_WEBHOOK_SECRET.value());
    } catch (err) {
      logger.warn("Invalid Stripe webhook signature", { error: err.message });
      res.status(400).send(`Webhook signature verification failed.`);
      return;
    }

    // Contestation bancaire (chargeback) ou remboursement fait depuis Stripe :
    // on reprend les coins correspondants (le solde peut passer en négatif).
    // À activer dans Stripe → Développeurs → Webhooks : charge.dispute.created
    // et charge.refunded.
    if (event.type === "charge.dispute.created" || event.type === "charge.refunded") {
      try {
        await handleClawback(stripe, event);
        res.status(200).send("ok");
      } catch (err) {
        logger.error("Clawback failed", { error: err.message, type: event.type });
        res.status(500).send("internal error");
      }
      return;
    }

    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
      // On ignore poliment tous les autres types d'événements Stripe.
      res.status(200).send("ignored");
      return;
    }

    const session = event.data.object;
    if (session.payment_status !== "paid") {
      res.status(200).send("not paid yet");
      return;
    }

    const uid = session.metadata && session.metadata.uid;
    const coins = Math.floor(Number(session.metadata && session.metadata.coins));

    if (!uid || !Number.isFinite(coins) || coins <= 0) {
      logger.error("Missing/invalid metadata on completed session", { sessionId: session.id, metadata: session.metadata });
      res.status(400).send("Missing metadata");
      return;
    }

    // Le montant réellement payé doit correspondre aux coins demandés (EUR).
    if (session.currency !== "eur" || session.amount_total !== Math.round(coins * COIN_PRICE_EUR * 100)) {
      logger.error("Amount mismatch on deposit", { sessionId: session.id, amount: session.amount_total, currency: session.currency, coins });
      res.status(200).send("amount mismatch");
      return;
    }

    try {
      // Ticket de dépôt = même principe que le "ledger" déjà utilisé côté
      // site pour les gains/remboursements de match (settledMatchIds) :
      // un document par paiement Stripe, créé UNE SEULE FOIS. Si Stripe
      // renvoie deux fois le même événement (webhook redelivery), la
      // transaction échoue à la 2e tentative et on ne crédite pas deux fois.
      const depositRef = db.collection("deposits").doc(session.id);
      const userRef = db.collection("users").doc(uid);

      await db.runTransaction(async (tx) => {
        const depositSnap = await tx.get(depositRef);
        if (depositSnap.exists) {
          logger.info("Deposit already processed, skipping", { sessionId: session.id });
          return;
        }
        tx.set(depositRef, {
          uid,
          coins,
          paymentIntent: session.payment_intent || null,
          amountTotalCents: session.amount_total || null,
          currency: session.currency || "eur",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.set(
          userRef,
          {
            coins: admin.firestore.FieldValue.increment(coins),
            notifications: admin.firestore.FieldValue.arrayUnion({
              id: `dep_${session.id}`,
              type: "tip", // réutilise le style visuel "gain d'argent" déjà existant côté site
              text: `Your deposit of ${coins} coins has been credited!`,
              at: Date.now(),
              read: false,
            }),
          },
          { merge: true }
        );
      });

      logger.info("Deposit credited", { uid, coins, sessionId: session.id });
      res.status(200).send("ok");
    } catch (err) {
      logger.error("Failed to credit deposit", { error: err.message, sessionId: session.id });
      // 500 => Stripe réessaiera automatiquement plus tard.
      res.status(500).send("internal error");
    }
  }
);
/* Reprise des coins après une contestation (chargeback) ou un remboursement.
   Idempotent : on mémorise sur le dépôt combien de coins ont déjà été repris. */
async function handleClawback(stripe, event) {
  const obj = event.data.object;
  const pi = obj.payment_intent;
  if (!pi) return;
  const sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
  const session = sessions.data[0];
  if (!session) { logger.warn("Clawback: no checkout session for payment", { pi }); return; }
  const depositRef = db.collection("deposits").doc(session.id);
  const isDispute = event.type === "charge.dispute.created";
  await db.runTransaction(async (tx) => {
    const dep = await tx.get(depositRef);
    if (!dep.exists) return;
    const d = dep.data();
    const total = Number(d.coins) || 0;
    let target;
    if (isDispute) target = total;
    else {
      const amount = Number(obj.amount) || 0;
      const refunded = Number(obj.amount_refunded) || 0;
      target = amount > 0 ? Math.round((total * refunded / amount) * 100) / 100 : total;
    }
    const already = Number(d.clawedBack) || 0;
    const delta = Math.round((Math.min(total, target) - already) * 100) / 100;
    if (delta <= 0) return;
    const userRef = db.collection("users").doc(d.uid);
    const update = {
      coins: admin.firestore.FieldValue.increment(-delta),
      notifications: admin.firestore.FieldValue.arrayUnion({
        id: `cb_${event.id}`, type: "warning",
        text: isDispute ? `Your payment of ${total} coins was disputed with your bank: ${delta} coins were removed and your account is suspended. Contact us on Discord.`
                        : `Your deposit was refunded: ${delta} coins were removed from your balance.`,
        at: Date.now(), read: false,
      }),
    };
    if (isDispute) Object.assign(update, { banned: true, banReason: "Payment dispute (chargeback)", bannedBy: "system", bannedAt: Date.now() });
    tx.set(userRef, update, { merge: true });
    tx.update(depositRef, { clawedBack: Math.round((already + delta) * 100) / 100, [isDispute ? "disputedAt" : "refundedAt"]: Date.now() });
  });
  logger.warn("Coins clawed back", { type: event.type, pi });
}
