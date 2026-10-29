/* ─────────────────────────────────────────────
   Relances d'expiration des mots de passe AD

   Trois déclencheurs, une seule chaîne d'envoi (deliver → sendReminder) :
   - sendUserReminder      POST /api/reminders/user  (un utilisateur, par email)
   - sendGeneralReminder   POST /api/reminders       (tous les comptes concernés)
   - runScheduledReminders tâche quotidienne (app.js, production uniquement)

   Sécurité :
   - routes protégées par clé API (en-tête x-api-key) ;
   - destinataires TOUJOURS résolus dans l'AD : l'email reçu sert uniquement
     de clé de recherche, jamais d'adresse d'envoi arbitraire ;
   - anti-doublon : une relance manuelle par compte toutes les
     PWD_REMINDER_COOLDOWN_MIN minutes ;
   - hors production, tous les mails partent vers BASE_RECIPIENT_EMAIL,
     l'objet indiquant le vrai destinataire.

   Envoi best-effort pour les relances groupées (un échec SMTP est reporté
   dans le résultat sans interrompre les autres envois) ; la relance
   unitaire remonte l'erreur au client.
───────────────────────────────────────────── */

import { getPasswordExpirations } from "../services/ad.service.js";
import { sendTemplatedMail } from "../services/mail.service.js";
import * as utils from "./utils.js";
import * as v from "./validators.js";
import { logger } from "../../config/logger.js";

const isProd = () => process.env.NODE_ENV === "production";

const cooldowns = utils.createCooldownStore();
setInterval(
  () => cooldowns.sweep(utils.getReminderConfig().cooldownMs),
  30 * 60_000,
).unref();

/* -------------------------------------------------------------------------- */
/*                                   ENVOI                                    */
/* -------------------------------------------------------------------------- */

const displayNameOf = ({ info }) =>
  info.displayName || info.sAMAccountName || info.email;

function toSummary(recipient) {
  return {
    email: recipient.info.email,
    login: recipient.info.sAMAccountName,
    displayName: displayNameOf(recipient),
    status: recipient.status,
    daysRemaining: recipient.info.daysRemaining,
    expiresAt: recipient.info.expiresAt,
  };
}

/** Envoi d'un mail de relance (lève en cas d'échec). */
async function sendReminder(recipient) {
  const cfg = utils.getReminderConfig();
  const realEmail = recipient.info.email;
  const to = isProd() ? realEmail : process.env.BASE_RECIPIENT_EMAIL;
  if (!to) throw new Error("MISSING_RECIPIENT");

  const subject = utils.buildSubject(
    recipient.status,
    recipient.info.daysRemaining,
  );

  await sendTemplatedMail({
    template: "expiration",
    to,
    from: cfg.from,
    subject: isProd() ? subject : `[DEV → ${realEmail}] ${subject}`,
    data: utils.buildMailData(recipient),
  });

  cooldowns.mark(realEmail);
}

/** Variante best-effort pour les envois groupés. */
async function deliver(recipient, { respectCooldown }) {
  const summary = toSummary(recipient);
  const { cooldownMs } = utils.getReminderConfig();

  if (respectCooldown) {
    const ms = cooldowns.remaining(summary.email, cooldownMs);
    if (ms > 0) {
      return {
        ...summary,
        result: "skipped",
        reason: `Déjà relancé récemment (nouvel envoi possible dans ${utils.formatDuration(ms)}).`,
      };
    }
  }

  try {
    await sendReminder(recipient);
    return { ...summary, result: "sent" };
  } catch (err) {
    const reason = err.cause?.response ?? err.cause?.message ?? err.message;
    logger.error(`[REMINDERS][MAIL] Échec relance ${summary.email} : ${reason}`);
    return { ...summary, result: "error", reason };
  }
}

function aggregate(results) {
  return {
    total: results.length,
    sent: results.filter((r) => r.result === "sent").length,
    skipped: results.filter((r) => r.result === "skipped").length,
    failed: results.filter((r) => r.result === "error").length,
    results,
  };
}

async function loadCandidateAccounts() {
  return utils.toCandidateAccounts(await getPasswordExpirations());
}

/* -------------------------------------------------------------------------- */
/*                                  ROUTES                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/reminders/user — relance d'un utilisateur précis.
 * Body : { email }
 */
export async function sendUserReminder(req) {
  const { email } = v.userReminderSchema.parse(req.body ?? {});
  const cfg = utils.getReminderConfig();

  const wait = cooldowns.remaining(email, cfg.cooldownMs);
  if (wait > 0) {
    throw new Error(`PWD_REMINDER_TOO_RECENT_[${utils.formatDuration(wait)}]`);
  }

  const [info] = await getPasswordExpirations({ email });
  if (!info) throw new Error("PWD_REMINDER_AD_ACCOUNT_NOT_FOUND");

  const status = utils.getPasswordStatus(info, cfg.defaultDays);
  if (status === "never") throw new Error("PWD_REMINDER_NOT_APPLICABLE");

  const recipient = { info, status };
  await sendReminder(recipient);

  logger.info(`[REMINDERS] Relance manuelle envoyée à ${email} (${status}).`);

  return { ...toSummary(recipient), result: "sent" };
}

/**
 * POST /api/reminders — relance générale.
 * Body : { days?: number, dryRun?: boolean }
 * dryRun = true : aucun envoi, renvoie la liste des destinataires.
 */
export async function sendGeneralReminder(req) {
  const params = v.generalReminderSchema.parse(req.body ?? {});
  const cfg = utils.getReminderConfig();
  const days = params.days ?? cfg.defaultDays;

  const recipients = utils.selectManualRecipients(
    await loadCandidateAccounts(),
    days,
  );

  if (params.dryRun) {
    return {
      dryRun: true,
      days,
      total: recipients.length,
      recipients: recipients.map(toSummary),
    };
  }

  const results = await utils.mapWithConcurrency(
    recipients,
    cfg.concurrency,
    (r) => deliver(r, { respectCooldown: true }),
  );
  const summary = aggregate(results);

  logger.info(
    `[REMINDERS] Relance générale (≤ ${days} j) : ${summary.sent} envoyée(s), ${summary.skipped} ignorée(s), ${summary.failed} échec(s).`,
  );

  return { dryRun: false, days, ...summary };
}

/**
 * Tâche planifiée (cf. app.js). Ne respecte pas le cooldown manuel (elle ne
 * tourne qu'une fois par jour ouvré) mais l'alimente, pour qu'un appel
 * manuel juste après ne renvoie pas le même mail.
 */
export async function runScheduledReminders(now = new Date()) {
  const cfg = utils.getReminderConfig();
  const recipients = utils.selectScheduledRecipients(
    await loadCandidateAccounts(),
    now,
  );

  const results = await utils.mapWithConcurrency(
    recipients,
    cfg.concurrency,
    (r) => deliver(r, { respectCooldown: false }),
  );
  const summary = aggregate(results);

  logger.info(
    `[REMINDERS][SCHEDULED] Paliers [${cfg.tiers.join(", ")}] : ${summary.sent} envoyée(s), ${summary.failed} échec(s) sur ${summary.total}.`,
  );

  return summary;
}
