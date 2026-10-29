import { ldapServiceSearch, escapeLdapFilterValue } from "./ldap.service.js";
import { logger } from "../../config/logger.js";

/**
 * Expiration des mots de passe Active Directory.
 * Repris de getPasswordExpirations (core/middlewares/auth.middleware.js,
 * API interne V1.1.0) — même calcul, avec en plus l'attribut `givenName`
 * (prénom du mail, fourni auparavant par users-manager).
 */

// FILETIME AD : intervalles de 100 ns depuis le 01/01/1601 (UTC).
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const TICKS_PER_MS = 10000n;
const INT64_MAX = 0x7fffffffffffffffn;
const INT64_MIN = -0x8000000000000000n;
const UAC_ACCOUNTDISABLE = 0x2;
const UAC_DONT_EXPIRE_PASSWORD = 0x10000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PWD_AGE_CACHE_MS = 60 * 60 * 1000; // la stratégie change rarement
// Codes LDAP renvoyés par l'AD pour un objet invisible au compte de service.
const LDAP_NO_SUCH_OBJECT = 32;
const LDAP_INSUFFICIENT_ACCESS_RIGHTS = 50;

/** Cache mémoire minimal (clé -> { value, expiresAt }) des stratégies lues. */
const policyCache = new Map();

async function getCached(key, fn, ttlMs) {
  const hit = policyCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fn();
  policyCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Convertit un FILETIME AD (pwdLastSet) en timestamp ms, ou null si 0 / vide. */
function fileTimeToMs(value) {
  if (value === undefined || value === null || value === "") return null;
  const ft = BigInt(value);
  if (ft <= 0n || ft >= INT64_MAX) return null;
  return Number((ft - FILETIME_EPOCH_OFFSET) / TICKS_PER_MS);
}

/**
 * DN racine du domaine, déduit des composants DC= de SEARCH_BASE
 * (ex. "OU=Utilisateurs,DC=EXAMPLE,DC=LOCAL" -> "DC=EXAMPLE,DC=LOCAL").
 * Surchargeable via LDAP_DOMAIN_DN.
 */
function getDomainDN() {
  if (process.env.LDAP_DOMAIN_DN) return process.env.LDAP_DOMAIN_DN;
  const dcs = (process.env.SEARCH_BASE || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /^DC=/i.test(p));
  if (!dcs.length) throw new Error("LDAP_CONFIGURATION_ERROR");
  return dcs.join(",");
}

/** Convertit une durée AD (intervalle négatif de 100 ns) en ms, ou null si "jamais". */
function adIntervalToMs(value) {
  const raw = BigInt(value);
  if (raw === 0n || raw === INT64_MIN) return null;
  return Number((raw < 0n ? -raw : raw) / TICKS_PER_MS);
}

/** Lit un attribut de durée sur un objet (base scope), avec cache. */
function readPolicyMaxAgeMs(dn, attribute) {
  return getCached(
    `ldap.pwdpolicy.${dn.toLowerCase()}`,
    async () => {
      let obj;
      try {
        [obj] = await ldapServiceSearch(dn, {
          scope: "base",
          filter: "(objectClass=*)",
          attributes: [attribute],
          paged: false,
        });
      } catch (err) {
        // Objet non visible (ACL) : l'AD répond noSuchObject plutôt qu'un
        // résultat vide -> traité comme "stratégie non lisible".
        if (
          [LDAP_NO_SUCH_OBJECT, LDAP_INSUFFICIENT_ACCESS_RIGHTS].includes(
            err.cause?.code,
          )
        ) {
          return undefined;
        }
        throw err;
      }
      // Attribut absent = non lisible par le compte de service -> undefined
      // (mis en cache aussi, pour ne pas réinterroger l'AD à chaque appel).
      if (obj?.[attribute] === undefined) return undefined;
      return adIntervalToMs(obj[attribute]);
    },
    MAX_PWD_AGE_CACHE_MS,
  );
}

/**
 * Durée de validité effective pour un utilisateur, en ms (null = n'expire jamais) :
 * - stratégie affinée (PSO/FGPP) si `msDS-ResultantPSO` est renseigné
 *   -> `msDS-MaximumPasswordAge` du PSO ;
 * - sinon stratégie de domaine -> `maxPwdAge` de l'objet domaine.
 * undefined = stratégie non lisible (ACL par défaut des PSO : admins
 * uniquement) -> formatPasswordExpiration se rabat sur
 * msDS-UserPasswordExpiryTimeComputed.
 */
function getEffectiveMaxPasswordAgeMs(resultantPsoDN) {
  return resultantPsoDN
    ? readPolicyMaxAgeMs(resultantPsoDN, "msDS-MaximumPasswordAge")
    : readPolicyMaxAgeMs(getDomainDN(), "maxPwdAge");
}

/**
 * Calcule l'expiration : pwdLastSet + durée de validité.
 * Cas particuliers : flag "le mot de passe n'expire jamais", stratégie sans
 * expiration, pwdLastSet = 0 (changement obligatoire à la prochaine ouverture de session).
 */
export function formatPasswordExpiration(
  entry,
  policyMaxAgeMs,
  now = Date.now(),
) {
  const uac = Number(entry.userAccountControl || 0);
  const pwdLastSetMs = fileTimeToMs(entry.pwdLastSet);
  const mustChangeAtNextLogon = String(entry.pwdLastSet ?? "") === "0";

  // Durée de validité : celle de la stratégie si elle a pu être lue, sinon
  // déduite de msDS-UserPasswordExpiryTimeComputed (calculé par l'AD) moins
  // pwdLastSet — cas d'un PSO non lisible par le compte de service.
  let maxPwdAgeMs = policyMaxAgeMs;
  if (maxPwdAgeMs === undefined) {
    const computed = entry["msDS-UserPasswordExpiryTimeComputed"];
    const computedMs =
      computed !== undefined && BigInt(computed) < INT64_MAX
        ? fileTimeToMs(computed)
        : null;
    maxPwdAgeMs =
      computedMs !== null && pwdLastSetMs !== null
        ? computedMs - pwdLastSetMs
        : null;
  }

  const neverExpires =
    (uac & UAC_DONT_EXPIRE_PASSWORD) !== 0 || maxPwdAgeMs === null;

  const expiresAtMs =
    !neverExpires && pwdLastSetMs !== null ? pwdLastSetMs + maxPwdAgeMs : null;

  return {
    sAMAccountName: entry.sAMAccountName || null,
    email: entry.mail || null,
    displayName: entry.displayName || null,
    givenName: entry.givenName || null,
    accountDisabled: (uac & UAC_ACCOUNTDISABLE) !== 0,
    passwordPolicy: entry["msDS-ResultantPSO"] || "DOMAIN",
    pwdLastSet:
      pwdLastSetMs !== null ? new Date(pwdLastSetMs).toISOString() : null,
    maxPwdAgeDays:
      maxPwdAgeMs !== null ? Math.round(maxPwdAgeMs / DAY_MS) : null,
    neverExpires,
    mustChangeAtNextLogon,
    expiresAt:
      expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
    isExpired:
      mustChangeAtNextLogon || (expiresAtMs !== null && expiresAtMs <= now),
    daysRemaining:
      expiresAtMs !== null ? Math.floor((expiresAtMs - now) / DAY_MS) : null,
  };
}

/**
 * Lit dans l'Active Directory la date d'expiration du mot de passe de chaque
 * utilisateur ACTIF ayant une adresse mail : date du dernier changement
 * (pwdLastSet) + durée de validité de la stratégie applicable (PSO/FGPP si
 * présente, sinon stratégie de domaine).
 *
 * Prérequis AD : le compte de service (LDAP_DN) doit pouvoir lire
 * pwdLastSet, userAccountControl et msDS-ResultantPSO sur les utilisateurs,
 * ainsi que msDS-MaximumPasswordAge sur les PSO. Sinon l'AD omet ces
 * attributs sans erreur -> on lève LDAP_ATTRIBUTE_NOT_READABLE plutôt que de
 * renvoyer un faux "n'expire jamais".
 *
 * @param {object} [options]
 * @param {string} [options.email] Filtre sur un utilisateur (attribut `mail`).
 * @returns {Promise<Array<object>>} Trié par date d'expiration croissante (sans expiration en fin de liste).
 */
export async function getPasswordExpirations({ email } = {}) {
  const filters = [
    "(objectCategory=person)",
    "(objectClass=user)",
    `(!(userAccountControl:1.2.840.113556.1.4.803:=${UAC_ACCOUNTDISABLE}))`,
    email ? `(mail=${escapeLdapFilterValue(email)})` : "(mail=*)",
  ];

  const entries = await ldapServiceSearch(process.env.SEARCH_BASE, {
    scope: "sub",
    filter: `(&${filters.join("")})`,
    attributes: [
      "sAMAccountName",
      "mail",
      "displayName",
      "givenName",
      "userAccountControl",
      "pwdLastSet",
      "msDS-ResultantPSO",
      "msDS-UserPasswordExpiryTimeComputed",
    ],
  });

  const unreadable = entries.filter((e) => e.pwdLastSet === undefined);
  if (unreadable.length) {
    // Typiquement des comptes à privilèges (adminCount=1, AdminSDHolder) :
    // l'héritage des droits de l'OU ne s'applique pas à eux.
    logger.warn(
      `[LDAP][PWD_EXPIRATION] pwdLastSet illisible pour ${unreadable.length} compte(s) (AdminSDHolder probable) : ${unreadable.map((e) => e.sAMAccountName || e.dn).join(", ")}`,
    );
  }
  if (entries.length && unreadable.length === entries.length) {
    logger.error(
      "[LDAP][PWD_EXPIRATION] pwdLastSet non renvoyé par l'AD : le compte de service n'a pas le droit de lecture (Read Account Restrictions).",
    );
    throw new Error("LDAP_ATTRIBUTE_NOT_READABLE");
  }

  const readable = entries.filter((e) => e.pwdLastSet !== undefined);

  // Une seule lecture par stratégie distincte (domaine + chaque PSO).
  const policies = new Map();
  for (const dn of new Set(readable.map((e) => e["msDS-ResultantPSO"] || ""))) {
    policies.set(dn, await getEffectiveMaxPasswordAgeMs(dn || null));
  }

  const now = Date.now();
  return readable
    .map((e) =>
      formatPasswordExpiration(
        e,
        policies.get(e["msDS-ResultantPSO"] || ""),
        now,
      ),
    )
    .sort((a, b) => {
      if (!a.expiresAt) return b.expiresAt ? 1 : 0;
      if (!b.expiresAt) return -1;
      return a.expiresAt.localeCompare(b.expiresAt);
    });
}
