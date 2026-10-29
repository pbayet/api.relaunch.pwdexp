import ldap from "ldapjs";
import fs from "node:fs";

/**
 * Recherche LDAP en lecture seule avec le compte de service (StartTLS sur 389).
 * Repris de core/services/ldap.service.js (API interne V1.1.0), limité à ce
 * dont la relance d'expiration a besoin : pas d'authentification utilisateur.
 */

const CA_CERT_PATH = process.env.LDAP_CA_CERT_PATH;

function createLdapClient() {
  return ldap.createClient({
    url: process.env.LDAP_URL,
    timeout: 10_000,
    connectTimeout: 10_000,
    reconnect: false,
  });
}

function startTls(client) {
  const tlsOptions = {
    ...(CA_CERT_PATH ? { ca: [fs.readFileSync(CA_CERT_PATH)] } : {}),
    rejectUnauthorized: true,
  };

  return new Promise((resolve, reject) => {
    client.starttls(tlsOptions, null, (err) => {
      if (err) return reject(new Error("LDAP_STARTTLS_FAILED", { cause: err }));
      resolve();
    });
  });
}

function bind(client, dn, password, errCode) {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) return reject(new Error(errCode, { cause: err }));
      resolve();
    });
  });
}

function search(client, base, options) {
  return new Promise((resolve, reject) => {
    const results = [];
    client.search(base, options, (err, res) => {
      if (err) return reject(new Error("LDAP_SEARCH_FAILED", { cause: err }));

      res.on("searchEntry", (entry) => {
        let dnValue = "";
        try {
          dnValue =
            typeof entry.dn === "string"
              ? entry.dn
              : entry.dn?.toString?.() || "";
        } catch {
          dnValue = "";
        }

        // ldapjs v3 : attributs lus depuis `entry.attributes` (valeur
        // scalaire si mono-valuée, tableau sinon).
        const attrs = {};
        for (const attr of entry.attributes || []) {
          const values = attr.values || [];
          attrs[attr.type] = values.length === 1 ? values[0] : values;
        }

        results.push({ ...attrs, dn: dnValue });
      });

      // `cause` conserve l'erreur ldapjs (dont `code` LDAP) pour les appelants.
      res.on("error", (err) =>
        reject(new Error("LDAP_SEARCH_ERROR", { cause: err })),
      );
      res.on("end", () => resolve(results));
    });
  });
}

async function safeUnbind(client) {
  if (!client) return;
  await new Promise((resolve) => client.unbind(() => resolve()));
}

/**
 * Échappe une valeur destinée à un filtre LDAP (RFC 4515) afin d'empêcher
 * toute injection de filtre : `*`, `(`, `)`, `\` et NUL.
 */
export function escapeLdapFilterValue(value) {
  return String(value).replace(
    /[\\*()\0]/g,
    (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/**
 * bind service -> search -> unbind. Pagination activée pour dépasser la
 * limite AD de 1000 résultats (MaxPageSize).
 */
export async function ldapServiceSearch(base, options) {
  const { LDAP_URL, LDAP_DN, LDAP_PASSWORD } = process.env;
  if (!LDAP_URL || !LDAP_DN || !LDAP_PASSWORD || !base) {
    throw new Error("LDAP_CONFIGURATION_ERROR");
  }
  if (!LDAP_URL.startsWith("ldap://")) {
    throw new Error("LDAP_URL_MUST_BE_LDAP_389_FOR_STARTTLS");
  }

  let client;
  try {
    client = createLdapClient();
    await startTls(client);
    await bind(client, LDAP_DN, LDAP_PASSWORD, "LDAP_SERVICE_BIND_FAILED");
    const { paged = { pageSize: 500 }, ...rest } = options;
    return await search(client, base, {
      ...rest,
      ...(paged ? { paged } : {}),
    });
  } finally {
    await safeUnbind(client);
  }
}
