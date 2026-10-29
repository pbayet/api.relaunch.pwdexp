import { logger } from "../../config/logger.js";

/**
 * Codes d'erreur métier (levés via `throw new Error("CODE")`) -> statut HTTP
 * + message. Reprend les codes du registre de l'API interne V1.1.0.
 * Un code peut porter une valeur entre crochets : PWD_REMINDER_TOO_RECENT_[10 min].
 */
const ERRORS = {
  INVALID_API_KEY: [401, "Clé API absente ou invalide."],
  API_KEY_NOT_CONFIGURED: [503, "API_KEY n'est pas configurée sur le serveur."],
  PWD_REMINDER_AD_ACCOUNT_NOT_FOUND: [404, "Aucun compte Active Directory actif ne correspond à cet email."],
  PWD_REMINDER_NOT_APPLICABLE: [422, "Le mot de passe de ce compte n'expire jamais."],
  PWD_REMINDER_TOO_RECENT: [429, "Une relance a déjà été envoyée récemment à cet utilisateur. Réessayez dans [VALUE]."],
  MAIL_NOT_CONFIGURED: [503, "Le relais SMTP n'est pas configuré (variable HOST manquante)."],
  MAIL_SEND_FAILED: [502, "Le relais SMTP a refusé l'envoi (voir le détail : si « Unable to relay », l'IP du serveur doit être autorisée sur le relais)."],
  MISSING_RECIPIENT:[500, "Aucun destinataire (vérifier BASE_RECIPIENT_EMAIL hors production)."],
  LDAP_CONFIGURATION_ERROR: [500, "Les variables d'environnement LDAP sont manquantes ou mal configurées."],
  LDAP_URL_MUST_BE_LDAP_389_FOR_STARTTLS: [500, "LDAP_URL doit être en ldap:// (port 389, StartTLS)."],
  LDAP_STARTTLS_FAILED: [500, "Échec du chiffrement StartTLS vers l'annuaire (certificat ?)."],
  LDAP_SERVICE_BIND_FAILED: [500, "Le compte de service n'a pas pu s'authentifier auprès de l'annuaire LDAP."],
  LDAP_SEARCH_FAILED: [500, "Échec de la recherche LDAP."],
  LDAP_SEARCH_ERROR: [500, "Erreur pendant la recherche LDAP."],
  LDAP_ATTRIBUTE_NOT_READABLE: [500, "Le compte de service LDAP n'a pas le droit de lire pwdLastSet."],
};

/** URL journalisée sans la clé API éventuellement passée en ?key= (dev). */
const safeUrl = (req) =>
  req.originalUrl.replace(/([?&]key=)[^&]*/i, "$1***");

function resolve(message = "") {
  const m = message.match(/^(.*?)_\[(.*)\]$/);
  const code = m ? m[1] : message;
  const entry = ERRORS[code];
  if (!entry) return null;
  return {
    code,
    status: entry[0],
    message: entry[1].replace("[VALUE]", m?.[2] ?? ""),
  };
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err?.name === "ZodError" || Array.isArray(err?.issues)) {
    const issues = (err.issues || []).map((i) => ({
      path: i.path?.join("."),
      message: i.message,
    }));
    logger.warn(`[VALIDATION] ${req.method} ${safeUrl(req)} ${JSON.stringify(issues)}`);
    return res.status(400).json({ error: "VALIDATION_ERROR", issues });
  }

  // JSON mal formé (express.json)
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "INVALID_JSON", message: "Corps JSON invalide." });
  }

  const known = resolve(err?.message);
  if (known) {
    const log = known.status >= 500 ? logger.error : logger.warn;
    log(`[${known.code}] ${req.method} ${safeUrl(req)}${err.cause ? ` | cause: ${err.cause.message}` : ""}`);
    return res.status(known.status).json({
      error: known.code,
      message: known.message,
      // Réponse brute du serveur SMTP (ex. "550 5.7.1 Unable to relay for ...").
      ...(known.code === "MAIL_SEND_FAILED"
        ? { detail: err.cause?.response ?? err.cause?.message }
        : {}),
    });
  }

  logger.error(`[UNEXPECTED] ${req.method} ${safeUrl(req)} | ${err?.stack ?? err}`);
  return res.status(500).json({ error: "INTERNAL_ERROR", message: "Erreur interne." });
}
