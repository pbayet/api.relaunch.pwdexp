import { describe, it, expect } from "vitest";
import * as utils from "../src/reminders/utils.js";

const ENV = { PWD_REMINDER_TIERS: "15,7,1" };

const account = (overrides = {}) => ({
  sAMAccountName: "jdupont",
  email: "jean.dupont@example.com",
  displayName: "Jean Dupont",
  givenName: "Jean",
  mustChangeAtNextLogon: false,
  isExpired: false,
  neverExpires: false,
  daysRemaining: 30,
  expiresAt: "2026-10-29T08:00:00.000Z",
  pwdLastSet: "2026-07-31T08:00:00.000Z",
  ...overrides,
});

const ref = (info) => ({ info });

describe("utils :: getPasswordStatus", () => {
  it.each([
    [{ mustChangeAtNextLogon: true, isExpired: true }, "must-change"],
    [{ isExpired: true, daysRemaining: -2 }, "expired"],
    [{ neverExpires: true, daysRemaining: null }, "never"],
    [{ daysRemaining: 10 }, "expiring"],
    [{ daysRemaining: 40 }, "valid"],
  ])("%o → %s", (over, expected) => {
    expect(utils.getPasswordStatus(account(over), 15)).toBe(expected);
  });
});

describe("utils :: toCandidateAccounts", () => {
  it("écarte les comptes sans mail et ceux exclus (email ou login, casse ignorée)", () => {
    const res = utils.toCandidateAccounts(
      [
        account(),
        account({ email: null }),
        account({ email: "Accueil@x.fr", sAMAccountName: "accueil" }),
        account({ email: "svc@x.fr", sAMAccountName: "SVC-Backup" }),
      ],
      { PWD_REMINDER_EXCLUDE: "accueil@x.fr, svc-backup" },
    );
    expect(res.map((r) => r.info.email)).toEqual([
      "jean.dupont@example.com",
    ]);
  });
});

describe("utils :: selectManualRecipients", () => {
  it("sélectionne expirés, à changer et expirant sous le seuil", () => {
    const res = utils.selectManualRecipients(
      [
        ref(account({ daysRemaining: 5 })),
        ref(account({ daysRemaining: 40 })),
        ref(account({ isExpired: true, daysRemaining: -100 })),
        ref(account({ neverExpires: true, daysRemaining: null })),
      ],
      15,
    );
    expect(res.map((r) => r.status)).toEqual(["expiring", "expired"]);
  });
});

describe("utils :: selectScheduledRecipients", () => {
  const tuesday = new Date("2026-09-29T08:00:00");
  const monday = new Date("2026-09-28T08:00:00");

  it("déclenche uniquement sur les paliers exacts en semaine", () => {
    const res = utils.selectScheduledRecipients(
      [15, 14, 7, 6, 1, 0].map((d) => ref(account({ daysRemaining: d }))),
      tuesday,
      ENV,
    );
    expect(res.map((r) => r.info.daysRemaining)).toEqual([15, 7, 1]);
  });

  it("rattrape le lundi les paliers franchis pendant le week-end", () => {
    const res = utils.selectScheduledRecipients(
      [16, 13, 5, 4].map((d) => ref(account({ daysRemaining: d }))),
      monday,
      ENV,
    );
    expect(res.map((r) => r.info.daysRemaining)).toEqual([13, 5]);
  });

  it("relance les expirés récents chaque jour, pas les anciens", () => {
    const res = utils.selectScheduledRecipients(
      [
        ref(account({ isExpired: true, daysRemaining: -3 })),
        ref(account({ isExpired: true, daysRemaining: -90 })),
      ],
      tuesday,
      ENV,
    );
    expect(res).toHaveLength(1);
  });

  it("relance les 'changement exigé' uniquement le lundi", () => {
    const acc = [
      ref(account({ mustChangeAtNextLogon: true, isExpired: true, daysRemaining: null })),
    ];
    expect(utils.selectScheduledRecipients(acc, tuesday, ENV)).toHaveLength(0);
    expect(utils.selectScheduledRecipients(acc, monday, ENV)).toHaveLength(1);
  });
});

describe("utils :: cooldown", () => {
  it("bloque puis libère après le délai", () => {
    const store = utils.createCooldownStore();
    store.mark("A@x.fr", 0);
    expect(store.remaining("a@x.fr", 600_000, 1000)).toBe(599_000);
    expect(store.remaining("a@x.fr", 600_000, 600_000)).toBe(0);
  });
});

describe("utils :: mapWithConcurrency", () => {
  it("conserve l'ordre et borne la concurrence", async () => {
    let running = 0;
    let max = 0;
    const res = await utils.mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(res).toEqual([2, 4, 6, 8, 10]);
    expect(max).toBeLessThanOrEqual(2);
  });
});

describe("utils :: contenu du mail", () => {
  it("objet adapté au statut", () => {
    expect(utils.buildSubject("expiring", 1)).toBe("Votre mot de passe expire dans 1 jour");
    expect(utils.buildSubject("expiring", 0)).toBe("Votre mot de passe expire aujourd'hui");
    expect(utils.buildSubject("expired", -3)).toBe("Votre mot de passe a expiré");
  });

  it("buildMailData renseigne prénom (givenName AD), couleur et contacts", () => {
    const data = utils.buildMailData(
      { ...ref(account({ daysRemaining: 7 })), status: "expiring" },
      { PWD_REMINDER_CONTACTS: "Support|support@x.fr" },
    );
    expect(data.FIRST_NAME).toBe("Jean");
    expect(data.THEME_COLOR).toBe(utils.STATUS_THEME.expiring.color);
    expect(data.STATUS_LABEL).toBe("Expire dans 7 jours");
    expect(data.CONTACTS_HTML).toContain("support@x.fr");
    expect(data.ACTION_URL).toBeUndefined();
    expect(data.HELP_URL).toBeUndefined();
    expect(data.APP_NAME).toBe("Service informatique");
  });

  it("nom et lien d'aide configurables", () => {
    const data = utils.buildMailData(
      { ...ref(account()), status: "expiring" },
      { PWD_REMINDER_APP_NAME: "DSI Acme", PWD_HELP_URL: "https://intra/doc" },
    );
    expect(data.APP_NAME).toBe("DSI Acme");
    expect(data.HELP_URL).toBe("https://intra/doc");
  });
});
