import express from "express";
import * as controllers from "./controllers.js";

/** Monté sur /api/reminders (app.js), derrière la clé API. */
const router = express.Router();

const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    next(err);
  }
};

// Relance de TOUS les comptes concernés. Body : { days?, dryRun? }
router.post("/", handle(controllers.sendGeneralReminder));

// Relance d'un utilisateur précis. Body : { email }
router.post("/user", handle(controllers.sendUserReminder));

/* ─────────────────────────────────────────────
   DEV — mêmes relances en GET, pour tester depuis un navigateur
   (paramètres et clé dans l'URL). Désactivées en production : un GET qui
   envoie des mails peut être déclenché par un simple pré-chargement de lien.
───────────────────────────────────────────── */
if (process.env.NODE_ENV !== "production") {
  // GET /api/reminders?key=...&dryRun=true&days=15
  router.get(
    "/",
    handle((req) => controllers.sendGeneralReminder({ body: req.query })),
  );

  // GET /api/reminders/user?key=...&email=...
  router.get(
    "/user",
    handle((req) => controllers.sendUserReminder({ body: req.query })),
  );
}

export default router;
