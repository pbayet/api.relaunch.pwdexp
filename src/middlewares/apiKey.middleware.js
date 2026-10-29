import crypto from "node:crypto";

/**
 * Protège les routes par une clé partagée (en-tête `x-api-key`), comparée en
 * temps constant. Sans API_KEY configurée, toutes les requêtes sont refusées.
 */
export function apiKeyMiddleware(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected) return next(new Error("API_KEY_NOT_CONFIGURED"));

  // Hors production, la clé est aussi acceptée en paramètre d'URL (?key=...)
  // pour tester les routes GET depuis un navigateur. Jamais en production :
  // une URL finit dans l'historique et les journaux.
  const fromQuery =
    process.env.NODE_ENV !== "production" ? req.query?.key : undefined;
  const provided = String(req.get("x-api-key") ?? fromQuery ?? "");
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();

  if (!provided || !crypto.timingSafeEqual(a, b)) {
    return next(new Error("INVALID_API_KEY"));
  }
  next();
}
