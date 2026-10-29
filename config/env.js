/**
 * Charge le .env AVANT tout le reste (premier import de app.js) : en ESM,
 * les imports statiques sont exécutés avant le corps du fichier importeur,
 * et certains modules lisent process.env dès leur chargement.
 */
import dotenv from "dotenv";

dotenv.config({ quiet: true });
