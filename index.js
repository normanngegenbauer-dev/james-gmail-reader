/*
 * Gmail Reader for James — OpenPets SDK v3 — Version 0.3.19
 *
 * Minimal inbox watcher:
 * - Checks the Gmail inbox every 20 seconds.
 * - Announces only newly detected message IDs.
 * - Does not fetch sender, subject, message headers, or message bodies.
 * - Uses Gmail metadata-only OAuth; tokens are never written to plugin storage or logged.
 */

// Normis Client-ID bleibt als Standard/Fallback im Plugin enthalten.
// Jeder Benutzer kann im Configure-Bereich seine eigene Client-ID eintragen.
const DEFAULT_GOOGLE_CLIENT_ID =
  "1093119980331-guocnhf0t3509r46lbh4krggre0dn31f.apps.googleusercontent.com";

async function getPluginConfig() {
  return await runtimeCtx.config.get() || {};
}

async function getGoogleClientId() {
  const config = await getPluginConfig();
  const configured = typeof config.googleClientId === "string"
    ? config.googleClientId.trim()
    : "";
  return configured || DEFAULT_GOOGLE_CLIENT_ID;
}

// Das Google OAuth Client Secret wird ausschließlich über das geschützte
// Configure-Feld eingelesen und niemals fest im Plugin-Code hinterlegt.
async function getGoogleClientSecret() {
  const config = await getPluginConfig();
  const value = config?.googleClientSecret;
  return typeof value === "string" ? value.trim() : "";
}

async function getScreenDimensions() {
  const config = await getPluginConfig();
  const width = Number(config?.screenWidth);
  const height = Number(config?.screenHeight);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 2560,
    height: Number.isFinite(height) && height > 0 ? height : 1440
  };
}
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SECRET_REFRESH_TOKEN = "gmail_google_refresh_token";

const GMAIL_SCOPE =
  "https://www.googleapis.com/auth/gmail.metadata";

const POLL_INTERVAL_MS = 20_000;
const MAX_SEEN_IDS = 1000;
const STORAGE_SEEN = "gmail_seen_message_ids";
const STORAGE_CONNECTED = "gmail_connected";
const STORAGE_BASELINE = "gmail_baseline_established";
const VOICE_ANNOUNCEMENT = "Normi, Du hast eine neue Email";
const MOVE_DURATION_MS = 2200;
const PAUSE_AT_CENTER_MS = 1800;
let jamesHomePosition = null;
let jamesMotionBusy = false;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getScreenCenterTarget(state) {
  // moveTo erwartet die linke obere Ecke von James.
  // Benutzer tragen ihre Bildschirmauflösung unter Configure ein.
  // Standard/Fallback ist Normis QHD-Auflösung 2560 × 1440.
  const bounds = state?.bounds;
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    return null;
  }
  return getScreenDimensions().then(({ width, height }) => ({
    x: Math.round((width - bounds.width) / 2),
    y: Math.round((height - bounds.height) / 2)
  }));
}

async function speakNewEmail() {
  // Bubble and audio are deliberately independent: one failing must not
  // suppress the other. Pass plain text for maximum SDK compatibility.
  try {
    await runtimeCtx.pet.speak(VOICE_ANNOUNCEMENT);
  } catch (error) {
    await runtimeCtx.log.warn("James-Sprechblase konnte nicht angezeigt werden.", {
      message: String(error?.message || error)
    });
  }
  try {
    await runtimeCtx.voice.speak(VOICE_ANNOUNCEMENT, { rate: 0.85 });
  } catch (error) {
    await runtimeCtx.log.warn("Die hörbare Gmail-Benachrichtigung ist fehlgeschlagen.", {
      message: String(error?.message || error)
    });
  }
}

async function notifyWithJamesMotion() {
  if (jamesMotionBusy) return;
  jamesMotionBusy = true;
  let moved = false;
  try {
    const state = await runtimeCtx.pet.getState();
    const target = await getScreenCenterTarget(state);
    if (state?.visible && !state?.dragging && jamesHomePosition && target) {
      await runtimeCtx.pet.moveTo(target, {
        durationMs: MOVE_DURATION_MS,
        easing: "ease-in-out"
      });
      moved = true;
      await speakNewEmail();
      await sleep(PAUSE_AT_CENTER_MS);
    } else {
      // Never fight a manual drag or a hidden pet; still show and speak the notice.
      await speakNewEmail();
    }
  } catch (error) {
    await runtimeCtx.log.warn("James-Bewegung fehlgeschlagen; Benachrichtigung wird trotzdem versucht.", {
      message: String(error?.message || error)
    });
    await speakNewEmail();
  } finally {
    if (moved && jamesHomePosition) {
      try {
        await runtimeCtx.pet.moveTo(jamesHomePosition, {
          durationMs: MOVE_DURATION_MS,
          easing: "ease-in-out"
        });
      } catch (error) {
        await runtimeCtx.log.warn("James konnte nicht an seine Ausgangsposition zurückkehren.", {
          message: String(error?.message || error)
        });
      }
    }
    jamesMotionBusy = false;
  }
}

let runtimeCtx = null;
let activeAccessToken = null;
let pollBusy = false;
let pollTimer = null;

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function refreshGoogleAccessToken() {
  const refreshToken = await runtimeCtx.secrets.get(SECRET_REFRESH_TOKEN);
  if (!refreshToken) {
    throw new Error("Kein gespeichertes Gmail-Refresh-Token. Bitte Gmail erneut verbinden.");
  }

  const form = new URLSearchParams({
    client_id: await getGoogleClientId(),
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const clientSecret = await getGoogleClientSecret();
  if (clientSecret) form.set("client_secret", clientSecret);

  const response = await runtimeCtx.net.fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: form.toString(),
    timeoutMs: 20000
  });
  const data = response.json && typeof response.json === "object"
    ? response.json
    : parseJson(response.text, {});

  if (!response.ok || !data.access_token) {
    const detail = data?.error_description || data?.error || `HTTP ${response.status}`;
    throw new Error(`Google-Token konnte nicht erneuert werden: ${detail}`);
  }

  // Google normally keeps the same refresh token. If it rotates one, save it.
  if (data.refresh_token) {
    await runtimeCtx.secrets.set(SECRET_REFRESH_TOKEN, data.refresh_token);
  }
  activeAccessToken = data.access_token;
  return activeAccessToken;
}

async function gmailGet(path) {
  // Retry once with a freshly renewed access token if Gmail rejects an expired one.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!activeAccessToken || attempt > 0) {
      await refreshGoogleAccessToken();
    }

    const response = await runtimeCtx.net.fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${activeAccessToken}`,
          Accept: "application/json"
        },
        timeoutMs: 15000
      }
    );

    const data = response.json && typeof response.json === "object"
      ? response.json
      : parseJson(response.text, {});

    if (response.ok) return data;
    if (response.status === 401 && attempt === 0) {
      activeAccessToken = null;
      continue;
    }
    const message = data?.error?.message || `Gmail HTTP ${response.status}`;
    throw new Error(message);
  }
  throw new Error("Gmail-Zugriff konnte nach Token-Erneuerung nicht hergestellt werden.");
}

async function listInboxMessageIds() {
  // Metadata scope does not permit the Gmail search query parameter (q).
  // Restrict the listing to the INBOX label; only message IDs are retained.
  // No messages.get call is made, so headers and bodies are never requested.
  const data = await gmailGet(
    "messages?maxResults=50&labelIds=INBOX"
  );
  return Array.isArray(data.messages)
    ? data.messages.map(message => message.id).filter(Boolean)
    : [];
}

async function readSeenIds() {
  const raw = await runtimeCtx.storage.get(STORAGE_SEEN);
  const parsed = raw ? parseJson(raw, []) : [];
  return Array.isArray(parsed) ? parsed : [];
}

async function writeSeenIds(ids) {
  await runtimeCtx.storage.set(
    STORAGE_SEEN,
    JSON.stringify(ids.slice(0, MAX_SEEN_IDS))
  );
}

async function announceNewMessages({ establishBaseline = false } = {}) {
  if (pollBusy) return;
  pollBusy = true;

  try {
    const ids = await listInboxMessageIds();
    const seen = await readSeenIds();
    const baselineEstablished =
      await runtimeCtx.storage.get(STORAGE_BASELINE) === "true";

    // Establish the initial inbox snapshot exactly once. This is independent
    // of seen.length, so an initially empty inbox will not reset the baseline
    // on every subsequent poll.
    if (establishBaseline || !baselineEstablished) {
      await writeSeenIds(ids);
      await runtimeCtx.storage.set(STORAGE_BASELINE, "true");
      await runtimeCtx.status.set({
        text: "Gmail verbunden. James wartet auf neue E-Mails.",
        tone: "success"
      });
      return;
    }

    const seenSet = new Set(seen);
    const newIds = ids.filter(id => !seenSet.has(id));

    // Persist IDs before speaking to avoid duplicate announcements after a restart.
    if (newIds.length > 0) {
      await writeSeenIds([...newIds, ...seen]);
      for (const id of newIds.slice().reverse()) {
        await notifyWithJamesMotion();
      }
      await runtimeCtx.status.set({
        text: `${newIds.length} neue E-Mail${newIds.length === 1 ? "" : "s"} erkannt.`,
        tone: "success"
      });
    }
  } finally {
    pollBusy = false;
  }
}

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePolling() {
  // Use the sandbox's standard timer instead of ctx.schedule. This avoids
  // the host's "Invalid plugin schedule delay" validation failure.
  stopPolling();
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    try {
      await checkNow();
    } catch (error) {
      await runtimeCtx.log.warn("Automatische Gmail-Prüfung fehlgeschlagen.", {
        message: String(error?.message || error)
      });
    } finally {
      if (runtimeCtx) schedulePolling();
    }
  }, POLL_INTERVAL_MS);
}

async function connectGmail() {
  const oauthOptions = {
    provider: "google",
    clientId: await getGoogleClientId(),
    scopes: [GMAIL_SCOPE]
  };
  const clientSecret = await getGoogleClientSecret();
  if (!clientSecret) {
    throw new Error("Bitte zuerst das Google OAuth Client Secret unter Configure eintragen und speichern.");
  }
  oauthOptions.clientSecret = clientSecret;

  const tokens = await runtimeCtx.auth.oauth(oauthOptions);
  activeAccessToken = tokens?.accessToken || tokens?.access_token || null;
  const refreshToken = tokens?.refreshToken || tokens?.refresh_token || null;
  if (!activeAccessToken || !refreshToken) {
    throw new Error("Google hat kein vollständiges Token-Paar zurückgegeben. Bitte OAuth-Client-Konfiguration prüfen.");
  }
  // Persist the long-lived credential before marking the account connected.
  // The secret store is encrypted and survives plugin/app restarts.
  await runtimeCtx.secrets.set(SECRET_REFRESH_TOKEN, refreshToken);
  await runtimeCtx.storage.set(STORAGE_CONNECTED, "true");

  // Verify that the stored refresh token can independently obtain a new access token.
  activeAccessToken = null;
  await refreshGoogleAccessToken();
  await announceNewMessages({ establishBaseline: true });
  schedulePolling();
}

async function checkNow() {
  await refreshGoogleAccessToken();
  await announceNewMessages();
}

async function disconnectGmail() {
  stopPolling();
  await runtimeCtx.auth.signOut("google");
  await runtimeCtx.secrets.set(SECRET_REFRESH_TOKEN, "");
  activeAccessToken = null;
  await runtimeCtx.storage.set(STORAGE_CONNECTED, "false");
  await runtimeCtx.status.set({
    text: "Gmail wurde getrennt.",
    tone: "info"
  });
}

OpenPetsPlugin.register({
  async start(ctx) {
    runtimeCtx = ctx;
    jamesHomePosition = null;
    jamesMotionBusy = false;
    try {
      const initialPetState = await ctx.pet.getState();
      jamesHomePosition = { ...initialPetState.position };
    } catch (error) {
      await ctx.log.warn("James-Ausgangsposition konnte nicht gespeichert werden.", {
        message: String(error?.message || error)
      });
    }

    await ctx.commands.register(
      {
        id: "gmail-connect",
        title: "Gmail verbinden",
        description: "Google sicher anmelden und ausschließlich Gmail-Metadatenzugriff erlauben.",
        timeoutMs: 120000
      },
      async () => {
        try {
          await connectGmail();
        } catch (error) {
          await ctx.status.set({
            text: `Gmail-Verbindung fehlgeschlagen: ${String(error?.message || error)}`,
            tone: "warning"
          });
        }
      }
    );

    await ctx.commands.register(
      {
        id: "gmail-check-now",
        title: "Gmail jetzt prüfen",
        description: "Sofort nach neuen E-Mails suchen."
      },
      async () => {
        try {
          await checkNow();
        } catch (error) {
          await ctx.status.set({
            text: `Gmail-Prüfung fehlgeschlagen: ${String(error?.message || error)}`,
            tone: "warning"
          });
        }
      }
    );

    await ctx.commands.register(
      {
        id: "gmail-disconnect",
        title: "Gmail trennen",
        description: "Google-Verbindung beenden und automatische Prüfung stoppen."
      },
      async () => {
        try {
          await disconnectGmail();
        } catch (error) {
          await ctx.log.warn("Gmail-Abmeldung fehlgeschlagen.", {
            message: String(error?.message || error)
          });
        }
      }
    );

    const connected = await ctx.storage.get(STORAGE_CONNECTED);
    if (connected === "true") {
      try {
        // Restore the account silently from the encrypted refresh token.
        // No browser login is needed unless Google has revoked the grant.
        await refreshGoogleAccessToken();
        await announceNewMessages();
        schedulePolling();
        await ctx.status.set({
          text: "Google-Anmeldung automatisch wiederhergestellt. James überwacht Gmail alle 20 Sekunden.",
          tone: "success"
        });
      } catch (error) {
        // Keep the saved refresh token and connected flag for transient network errors.
        // Only the user can re-authorize if Google has actually revoked the grant.
        await ctx.status.set({
          text: `Gespeicherte Google-Anmeldung konnte nicht erneuert werden: ${String(error?.message || error)}. Bitte Verbindung prüfen.`,
          tone: "warning"
        });
      }
    } else {
      await ctx.status.set({
        text: "Bitte über das Pet-Menü zuerst Gmail verbinden.",
        tone: "info"
      });
    }
  },

  async stop() {
    stopPolling();
    runtimeCtx = null;
    activeAccessToken = null;
    pollBusy = false;
    jamesHomePosition = null;
    jamesMotionBusy = false;
  }
});
