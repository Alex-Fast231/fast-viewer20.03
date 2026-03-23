export const APP_SCHEMA_VERSION = 3;
export const APP_VERSION = "3.0.0";
export const APP_MODULE = "doku";

export const PRACTICE_ADDRESS = `Münchener Str. 155
85051 Ingolstadt
Tel.: 0841-45674267`;

export function createEmptyAppData() {
  const now = new Date().toISOString();

  return {
    schemaVersion: APP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    module: APP_MODULE,
    viewerCompatible: true,
    exportTimestamp: "",

    settings: {
      therapistName: "",
      therapistFax: "",
      practicePhone: "",
      practiceAddress: PRACTICE_ADDRESS,
      workDays: [],
      weeklyHours: "",
      privacyMode: "full",
      createdAt: now,
      updatedAt: now
    },

    homes: [],

    doku: {
      version: 1
    },

    zeit: {
      version: 1,
      therapists: [],
      workModels: [],
      timeEntries: [],
      approvals: [],
      kilometer: [],
      reports: []
    },

    kilometer: {
      startPoint: {
        label: "",
        address: ""
      },
      knownRoutes: [],
      travelLog: []
    },

    abwesenheiten: [],

    abgabeHistory: [],
    nachbestellHistory: [],

    security: {
      log: [],
      lastSecurityChangeAt: "",
      privacyMode: "full"
    },

    ui: {
      lastBackupAt: ""
    }
  };
}