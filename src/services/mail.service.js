import nodemailer from "nodemailer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../config/logger.js";

/**
 * Envoi de mails HTML à partir de templates — repris de
 * core/services/mail.service.js (API interne V1.1.0), sans les "copies mails"
 * (inutiles ici : la relance est un message personnel).
 *
 * Configuration SMTP :
 *   HOST        - hôte du relais SMTP
 *   EMAIL_USER  - utilisateur SMTP
 *   EMAIL_PASS  - mot de passe SMTP
 *   EMAIL_PORT  - port SMTP (optionnel, défaut 25)
 *   EMAIL_FROM  - adresse d'expédition (optionnel, défaut noreply@example.com)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "mail-templates");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.HOST) {
    throw new Error("MAIL_NOT_CONFIGURED");
  }

  transporter = nodemailer.createTransport({
    host: process.env.HOST,
    port: Number(process.env.EMAIL_PORT) || 25,
    secure: false,
    ...(process.env.EMAIL_USER
      ? { auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } }
      : {}),
    tls: {
      rejectUnauthorized: false,
    },
  });

  return transporter;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Échappe les caractères HTML spéciaux. Appliqué par défaut à toute valeur
 * injectée dans un template ; les clés qui se terminent par `_HTML` sont du
 * HTML de confiance construit par le code et ne sont pas échappées.
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Remplace les placeholders {{CLE}} d'un template HTML par les valeurs de
 * `data`. Blocs conditionnels non imbriqués supportés :
 *   {{#if CLE}} ... {{/if}}
 * Les placeholders non renseignés sont retirés.
 */
export function renderTemplate(rawHtml, data = {}) {
  let output = rawHtml.replace(
    /{{#if\s+([\w.]+)\s*}}([\s\S]*?){{\/if\s*}}/g,
    (_match, key, inner) => {
      const value = data[key];
      const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
      return truthy ? inner : "";
    },
  );

  for (const key of Object.keys(data)) {
    const value = data[key];
    const replacement = key.endsWith("_HTML")
      ? String(value ?? "")
      : escapeHtml(value ?? "");
    const regex = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, "g");
    output = output.replace(regex, replacement);
  }

  output = output
    .replace(/{{#if\s+[\w.]+\s*}}/g, "")
    .replace(/{{\/if\s*}}/g, "");
  output = output.replace(/{{\s*[\w.]+\s*}}/g, "");

  return output;
}

/**
 * Rendu en table HTML (compatible Outlook) des paires label/valeur du bloc
 * "Détails", deux par ligne.
 */
export function renderDetailsList(items = []) {
  const cells = items.map(
    ({ label, value }) => `
        <td
          valign="top"
          width="48%"
          style="
            padding: 12px 14px;
            background-color: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
          "
        >
          <p
            style="
              margin: 0 0 4px 0;
              font-size: 0.72em;
              font-weight: bold;
              text-transform: uppercase;
              letter-spacing: 0.04em;
              color: #64748b;
            "
          >
            ${escapeHtml(label)}
          </p>
          <p
            style="
              margin: 0;
              font-size: 0.95em;
              font-weight: bold;
              color: #1e293b;
              word-break: break-word;
            "
          >
            ${escapeHtml(value ?? "")}
          </p>
        </td>`,
  );

  const spacer = `<td width="4%" style="font-size: 0; line-height: 0;">&nbsp;</td>`;
  const emptyCell = `<td width="48%">&nbsp;</td>`;
  const rowGap = `<tr><td colspan="3" style="font-size: 0; line-height: 10px; height: 10px;">&nbsp;</td></tr>`;

  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    if (rows.length > 0) rows.push(rowGap);
    rows.push(`<tr>${cells[i]}${spacer}${cells[i + 1] ?? emptyCell}</tr>`);
  }

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; width: 100%;"><tbody>${rows.join("\n")}</tbody></table>`;
}

/** Liste de contacts (`<li>Nom : email</li>`) pour l'encart "Besoin d'aide ?". */
export function renderContactList(contacts = []) {
  return contacts
    .map(
      ({ name, email }) =>
        `<li style="margin: 0 0 6px 0;">${escapeHtml(name)} : <a href="mailto:${escapeHtml(email)}" style="color: #2563eb; text-decoration: underline;">${escapeHtml(email)}</a></li>`,
    )
    .join("\n");
}

export async function sendMail({ to, subject, html, from }) {
  if (!to) throw new Error("MISSING_RECIPIENT");

  let info;
  try {
    info = await getTransporter().sendMail({
      from: from || process.env.EMAIL_FROM || "noreply@example.com",
      to,
      subject,
      html,
    });
  } catch (err) {
    // Refus du relais (ex. 550 5.7.1 Unable to relay : IP non autorisée sur
    // un relais IIS sans authentification) ou relais injoignable.
    throw new Error("MAIL_SEND_FAILED", { cause: err });
  }

  logger.info(
    `[MAIL] Envoyé à ${to} | subject="${subject}" | messageId=${info.messageId}`,
  );

  return info;
}

/** Envoi à partir de src/services/mail-templates/<template>.html. */
export async function sendTemplatedMail({ template, to, subject, data, from }) {
  let rawHtml;
  try {
    rawHtml = await fs.readFile(
      path.join(TEMPLATES_DIR, `${template}.html`),
      "utf-8",
    );
  } catch {
    throw new Error(`MAIL_TEMPLATE_NOT_FOUND_[${template}]`);
  }

  return sendMail({ to, subject, html: renderTemplate(rawHtml, data), from });
}
