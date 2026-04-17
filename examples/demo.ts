import "dotenv/config";
import { connect } from "../src";

async function run(): Promise<void> {
  const provider = (process.env.FILEBASEDB_PROVIDER as "google" | "onedrive" | undefined) ?? "google";
  const folderId = process.env.FILEBASEDB_FOLDER_ID;

  if (!folderId) {
    throw new Error("Set FILEBASEDB_FOLDER_ID in your environment before running examples/demo.ts");
  }

  const credentials =
    provider === "google"
      ? {
          accessToken: process.env.GOOGLE_ACCESS_TOKEN,
          refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          redirectUri: process.env.GOOGLE_REDIRECT_URI,
        }
      : {
          accessToken: process.env.ONEDRIVE_ACCESS_TOKEN ?? "",
        };

  const db = await connect(provider, credentials, {
    cacheTtlMs: 60_000,
    pollingIntervalMs: 15_000,
  });

  await db.useFolder(folderId);

  const files = await db.getFiles();
  console.log("Files:", files);

  const firstFile = files[0];
  if (firstFile) {
    await db.addMetadata(firstFile.id, {
      tags: ["demo", "important"],
      category: "samples",
      reviewer: "developer",
    });
    console.log(`Updated metadata for file: ${firstFile.name}`);
  }

  const onlyDemoTaggedFiles = await db.getFiles({ tag: "demo" });
  console.log("Filtered files (tag=demo):", onlyDemoTaggedFiles);

  const unsubscribe = db.subscribe(folderId, (events) => {
    console.log("Folder changes:", events);
  });

  setTimeout(() => {
    unsubscribe();
    db.disconnect();
    console.log("Demo complete.");
  }, 60_000);
}

void run().catch((error: Error) => {
  console.error(`Demo failed: ${error.message}`);
  process.exit(1);
});
