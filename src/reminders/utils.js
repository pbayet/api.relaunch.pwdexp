/* ─────────────────────────────────────────────
   Relances d'expiration — utilitaires purs (sans I/O)

   Repris de modules/passwords/utils.js (API interne V1.1.0). Différence : plus
   de croisement avec users-manager (base SQL interne) — tous les comptes AD
   actifs ayant un mail sont concernés, sauf ceux listés dans
   PWD_REMINDER_EXCLUDE (comptes de service, boîtes génériques...).
───────────────────────────────────────────── */

import {
  renderContactList,
  renderDetailsList,
} from "../services/mail.service.js";

/* -------------------------------------------------------------------------- */
/*                                CONFIGURATION                               */
/* -------------------------------------------------------------------------- */

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const toList = (value, fallback = "") =>
  String(value ?? fallback)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * Configuration lue à chaque appel (et non figée au chargement du module)
 * pour rester pilotable par les tests et par un simple redémarrage.
 * Cf. .env.example, section "RELANCES".
 */
export function getReminderConfig(env = process.env) {
  const tiers = toList(env.PWD_REMINDER_TIERS, "15,7,1")
    .map((t) => toInt(t, NaN))
    .filter((t) => Number.isInteger(t) && t >= 0)
    .sort((a, b) => b - a);

  return {
    /** Paliers (jours restants) déclenchant la relance automatique. */
    tiers: [...new Set(tiers)],
    /** Relance auto des comptes expirés pendant N jours après l'expiration. */
    expiredMaxDays: toInt(env.PWD_REMINDER_EXPIRED_MAX_DAYS, 30),
    /** Seuil par défaut de la relance générale manuelle. */
    defaultDays: toInt(env.PWD_REMINDER_DEFAULT_DAYS, 15),
    /** Délai minimal entre deux relances manuelles d'un même compte. */
    cooldownMs: toInt(env.PWD_REMINDER_COOLDOWN_MIN, 10) * 60_000,
    /** Envois SMTP simultanés lors d'une relance groupée. */
    concurrency: Math.max(1, toInt(env.PWD_REMINDER_CONCURRENCY, 3)),
    scheduleEnabled: env.PWD_REMINDER_SCHEDULE_ENABLED !== "false",
    scheduleHour: toInt(env.PWD_REMINDER_HOUR, 8),
    scheduleMinute: toInt(env.PWD_REMINDER_MINUTE, 0),
    /** Emails ou sAMAccountName à ne jamais relancer (minuscules). */
    exclude: toList(env.PWD_REMINDER_EXCLUDE).map((e) => e.toLowerCase()),
    from: env.PWD_REMINDER_FROM || undefined,
    changeUrl: env.PWD_CHANGE_URL || undefined,
    /** Nom affiché en tête du mail. */
    appName: env.PWD_REMINDER_APP_NAME || "Service informatique",
    /** Procédure de changement à distance (lien affiché dans le mail, optionnel). */
    helpUrl: env.PWD_HELP_URL || undefined,
    helpLabel:
      env.PWD_HELP_LABEL || "Changement de mot de passe à distance",
    /** "Nom|email;Nom|email" */
    contacts: String(env.PWD_REMINDER_CONTACTS ?? "")
      .split(";")
      .map((c) => c.split("|").map((p) => p.trim()))
      .filter(([name, email]) => name && email)
      .map(([name, email]) => ({ name, email })),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   STATUTS                                  */
/* -------------------------------------------------------------------------- */

/**
 * Même règle que PasswordExpiration.getStatus() côté front users-manager.
 * @returns {"must-change"|"expired"|"never"|"expiring"|"valid"}
 */
export function getPasswordStatus(info, soonThresholdDays) {
  if (info.mustChangeAtNextLogon) return "must-change";
  if (info.isExpired) return "expired";
  if (info.neverExpires) return "never";
  if (info.daysRemaining !== null && info.daysRemaining <= soonThresholdDays) {
    return "expiring";
  }
  return "valid";
}

/** Vrai si le compte figure dans PWD_REMINDER_EXCLUDE (email ou login). */
export function isExcluded(info, exclude) {
  return [info.email, info.sAMAccountName]
    .filter(Boolean)
    .some((id) => exclude.includes(String(id).trim().toLowerCase()));
}

/**
 * Comptes AD candidats à une relance : ayant un mail et non exclus.
 * Renvoie des objets { info } (forme attendue par les sélections ci-dessous).
 */
export function toCandidateAccounts(adAccounts = [], env = process.env) {
  const { exclude } = getReminderConfig(env);
  return adAccounts
    .filter((a) => a?.email && !isExcluded(a, exclude))
    .map((info) => ({ info }));
}

/* -------------------------------------------------------------------------- */
/*                         SÉLECTION DES DESTINATAIRES                        */
/* -------------------------------------------------------------------------- */

/**
 * Relance générale (manuelle) : tous les comptes expirés, à changer, ou
 * expirant sous `days` jours.
 */
export function selectManualRecipients(accounts, days) {
  return accounts
    .map((a) => ({ ...a, status: getPasswordStatus(a.info, days) }))
    .filter((a) => ["expired", "must-change", "expiring"].includes(a.status));
}

/**
 * Relance automatique quotidienne (jours ouvrés) :
 *  - compte arrivant EXACTEMENT sur un palier (ex. J-15, J-7, J-1) ;
 *    le lundi, les paliers franchis pendant le week-end (où la tâche ne
 *    tourne pas) sont rattrapés (fenêtre de 3 jours) ;
 *  - compte expiré depuis au plus `expiredMaxDays` jours : relancé chaque
 *    jour ouvré (au-delà, on considère le compte abandonné — pas de spam) ;
 *  - compte "changement exigé" (pwdLastSet = 0) : relancé une fois par
 *    semaine (le lundi) — souvent un compte créé mais jamais utilisé.
 */
export function selectScheduledRecipients(
  accounts,
  now = new Date(),
  env = process.env,
) {
  const { tiers, expiredMaxDays } = getReminderConfig(env);
  const isMonday = now.getDay() === 1;
  const lookback = isMonday ? 2 : 0;
  const maxTier = tiers[0] ?? 0;

  const out = [];
  for (const a of accounts) {
    const status = getPasswordStatus(a.info, maxTier);
    const days = a.info.daysRemaining;

    if (status === "must-change") {
      if (isMonday) out.push({ ...a, status });
      continue;
    }

    if (status === "expired") {
      if (days !== null && Math.abs(days) <= expiredMaxDays)
        out.push({ ...a, status });
      continue;
    }

    if (status === "expiring" && days !== null) {
      const hit = tiers.find((t) => days <= t && days >= t - lookback);
      if (hit !== undefined) out.push({ ...a, status, tier: hit });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                          ANTI-DOUBLON (COOLDOWN)                           */
/* -------------------------------------------------------------------------- */

/**
 * Mémoire des derniers envois (email → timestamp), en mémoire process : une
 * seule instance (cf. ecosystem.config.cjs). Un redémarrage remet simplement
 * les compteurs à zéro.
 */
export function createCooldownStore() {
  const lastSent = new Map();

  return {
    /** ms restantes avant de pouvoir relancer (0 = autorisé). */
    remaining(email, cooldownMs, now = Date.now()) {
      const at = lastSent.get(email.toLowerCase());
      if (at === undefined) return 0;
      return Math.max(0, at + cooldownMs - now);
    },
    mark(email, now = Date.now()) {
      lastSent.set(email.toLowerCase(), now);
    },
    /** Purge des entrées expirées (évite une croissance infinie). */
    sweep(cooldownMs, now = Date.now()) {
      for (const [k, at] of lastSent)
        if (at + cooldownMs <= now) lastSent.delete(k);
    },
    clear() {
      lastSent.clear();
    },
  };
}

export function formatDuration(ms) {
  const minutes = Math.ceil(ms / 60_000);
  return minutes >= 1 ? `${minutes} min` : `${Math.ceil(ms / 1000)} s`;
}

/* -------------------------------------------------------------------------- */
/*                                CONCURRENCE                                 */
/* -------------------------------------------------------------------------- */

/** Map asynchrone à concurrence bornée (ordre des résultats conservé). */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/* -------------------------------------------------------------------------- */
/*                                CONTENU MAIL                                */
/* -------------------------------------------------------------------------- */

export const STATUS_THEME = {
  expiring: { color: "#b07f00", label: "Expire bientôt" },
  expired: { color: "#a5212e", label: "Expiré" },
  "must-change": { color: "#a5212e", label: "Changement exigé" },
  valid: { color: "#1b722f", label: "Valide" },
  never: { color: "#17a2b8", label: "N'expire jamais" },
};

const PARIS_DATE_TIME = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatParisDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : PARIS_DATE_TIME.format(d);
}

const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

/** Libellé court de l'échéance (badge + objet du mail). */
export function getRemainingLabel(status, daysRemaining) {
  if (status === "must-change")
    return "Changement exigé à la prochaine connexion";
  if (status === "never") return "N'expire jamais";
  if (status === "expired") {
    const d = Math.abs(daysRemaining ?? 0);
    return d > 0 ? `Expiré depuis ${plural(d, "jour")}` : "Expiré";
  }
  const d = daysRemaining ?? 0;
  return d === 0 ? "Expire aujourd'hui" : `Expire dans ${plural(d, "jour")}`;
}

export function buildSubject(status, daysRemaining) {
  if (status === "must-change")
    return "Action requise : changement de votre mot de passe";
  if (status === "expired") return "Votre mot de passe a expiré";
  const d = daysRemaining ?? 0;
  return d === 0
    ? "Votre mot de passe expire aujourd'hui"
    : `Votre mot de passe expire dans ${plural(d, "jour")}`;
}

function buildMessage(status, info) {
  const exp = formatParisDateTime(info.expiresAt);
  switch (status) {
    case "must-change":
      return "Votre compte doit changer de mot de passe à la prochaine ouverture de session.\nMerci de le faire dès que possible pour conserver l'accès à vos applications.";
    case "expired":
      return `Le mot de passe de votre compte a expiré le ${exp}.\nTant qu'il n'est pas renouvelé, l'accès à votre session, à la messagerie et aux applications peut être bloqué.`;
    default:
      return `Le mot de passe de votre compte expirera le ${exp}.\nPensez à le changer avant cette date pour éviter toute interruption d'accès.`;
  }
}

/**
 * Données injectées dans mail-templates/expiration.html.
 * Les valeurs "simples" sont échappées par renderTemplate ; seules les clés
 * *_HTML (construites ici par les helpers du mail.service) sont brutes.
 */
export function buildMailData({ info, status }, env = process.env) {
  const cfg = getReminderConfig(env);
  const theme = STATUS_THEME[status] ?? STATUS_THEME.expiring;

  return {
    APP_NAME: cfg.appName,
    TITLE: buildSubject(status, info.daysRemaining),
    FIRST_NAME: info.givenName || info.displayName || "",
    MESSAGE: buildMessage(status, info),
    STATUS_LABEL: getRemainingLabel(status, info.daysRemaining),
    THEME_COLOR: theme.color,
    DETAILS_ROWS_HTML: renderDetailsList([
      { label: "Identifiant", value: info.sAMAccountName || info.email },
      {
        label: "Date d'expiration",
        value:
          status === "must-change"
            ? "Immédiate"
            : formatParisDateTime(info.expiresAt),
      },
      {
        label: "Dernier changement",
        value:
          status === "must-change" ? "—" : formatParisDateTime(info.pwdLastSet),
      },
      { label: "Statut", value: theme.label },
    ]),
    ACTION_URL: cfg.changeUrl,
    ACTION_LABEL: "Changer mon mot de passe",
    HELP_URL: cfg.helpUrl,
    HELP_LABEL: cfg.helpLabel,
    CONTACTS_HTML: cfg.contacts.length
      ? renderContactList(cfg.contacts)
      : undefined,
  };
}
