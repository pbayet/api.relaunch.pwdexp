import { z } from "zod";

// z.coerce.boolean() transformerait "false" en true : on accepte donc
// explicitement un booléen JSON ou sa forme texte (query string).
const booleanLike = z
  .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
  .optional()
  .default(false);

export const userReminderSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email invalide.").max(254),
});

export const generalReminderSchema = z.object({
  /** Seuil "expire bientôt" (jours). Défaut : PWD_REMINDER_DEFAULT_DAYS. */
  days: z.coerce.number().int().min(0).max(90).optional(),
  /** true = ne rien envoyer, renvoyer seulement la liste des destinataires. */
  dryRun: booleanLike,
});
