import assert from "node:assert/strict";
import test from "node:test";
import { connect, ProviderCredentials, ProviderName } from "../src";
import type { GoogleOAuthCredentials } from "../src";

const SMOKE_ENABLED = process.env.FILEBASEDB_SMOKE_TEST === "1";

function getProvider(): ProviderName {
  const provider = process.env.FILEBASEDB_PROVIDER;
  if (provider !== "google" && provider !== "onedrive") {
    throw new Error("Set FILEBASEDB_PROVIDER to 'google' or 'onedrive' for smoke tests.");
  }

  return provider;
}

function getFolderId(): string {
  const folderId = process.env.FILEBASEDB_FOLDER_ID;
  if (!folderId) {
    throw new Error("Set FILEBASEDB_FOLDER_ID for smoke tests.");
  }

  return folderId;
}

function getCredentials(provider: ProviderName): ProviderCredentials {
  if (provider === "google") {
    const credentials: GoogleOAuthCredentials = {};
    const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;

    if (accessToken) credentials.accessToken = accessToken;
    if (refreshToken) credentials.refreshToken = refreshToken;
    if (clientId) credentials.clientId = clientId;
    if (clientSecret) credentials.clientSecret = clientSecret;
    if (redirectUri) credentials.redirectUri = redirectUri;

    if (!credentials.accessToken && !credentials.refreshToken) {
      throw new Error("Google smoke test requires GOOGLE_ACCESS_TOKEN or GOOGLE_REFRESH_TOKEN.");
    }

    return credentials;
  }

  const token = process.env.ONEDRIVE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("OneDrive smoke test requires ONEDRIVE_ACCESS_TOKEN.");
  }

  return { accessToken: token };
}

test("integration smoke: OAuth provider, folder access, read/write, metadata", { timeout: 90_000 }, async (t) => {
  if (!SMOKE_ENABLED) {
    t.skip("Set FILEBASEDB_SMOKE_TEST=1 to run integration smoke tests.");
    return;
  }

  const provider = getProvider();
  const folderId = getFolderId();
  const credentials = getCredentials(provider);
  const db = await connect(provider, credentials, {
    retry: {
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
    },
    writeConflict: {
      policy: "retry-merge",
      maxRetries: 4,
      backoffMs: 150,
    },
  });

  try {
    await db.useFolder(folderId);

    const files = await db.getFiles();
    assert.ok(Array.isArray(files));

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const smokeFileName = `smoke/${provider}-smoke-${suffix}.txt`;
    const smokeBody = `filebasedb-smoke-${suffix}`;

    const written = await db.writeFile(smokeFileName, smokeBody, "text/plain");
    assert.ok(written.id);

    const content = await db.readFile(smokeFileName);
    assert.equal(content, smokeBody);

    await db.addMetadata(written.id, {
      tags: ["smoke"],
      category: "integration",
      scope: "provider-credentials",
    });

    const tagged = await db.getFiles({ tag: "smoke" });
    assert.ok(tagged.some((entry) => entry.id === written.id));

    await db.removeMetadata(written.id);
    await db.deleteFile(smokeFileName);
  } finally {
    db.disconnect();
  }
});

test("integration smoke: provider creates real folder hierarchy for nested paths", { timeout: 120_000 }, async (t) => {
  if (!SMOKE_ENABLED) {
    t.skip("Set FILEBASEDB_SMOKE_TEST=1 to run integration smoke tests.");
    return;
  }

  const provider = getProvider();
  const folderId = getFolderId();
  const credentials = getCredentials(provider);
  const db = await connect(provider, credentials, {
    retry: {
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
    },
  });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const pathA = `hierarchy/a-${suffix}/shared-name.txt`;
  const pathB = `hierarchy/b-${suffix}/shared-name.txt`;

  try {
    await db.useFolder(folderId);

    await db.writeFile(pathA, `A-${suffix}`, "text/plain");
    await db.writeFile(pathB, `B-${suffix}`, "text/plain");

    const readA = await db.readFile(pathA);
    const readB = await db.readFile(pathB);

    assert.equal(readA, `A-${suffix}`);
    assert.equal(readB, `B-${suffix}`);
  } finally {
    await db.deleteFile(pathA);
    await db.deleteFile(pathB);
    db.disconnect();
  }
});
