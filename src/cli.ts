#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./index";
import { safeErrorMessage } from "./security";
import { FileFilters, ProviderCredentials, ProviderName } from "./types";

type Args = {
  provider?: ProviderName;
  folder?: string;
  credentialsPath?: string;
  tag?: string;
  type?: string;
  fromDate?: string;
  toDate?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    switch (current) {
      case "--provider":
        if (next === "google" || next === "onedrive") args.provider = next;
        break;
      case "--folder":
        if (next) args.folder = next;
        break;
      case "--credentials":
        if (next) args.credentialsPath = next;
        break;
      case "--tag":
        if (next) args.tag = next;
        break;
      case "--type":
        if (next) args.type = next;
        break;
      case "--from-date":
        if (next) args.fromDate = next;
        break;
      case "--to-date":
        if (next) args.toDate = next;
        break;
      default:
        break;
    }
  }

  return args;
}

function readCredentials(provider: ProviderName, credentialsPath: string): ProviderCredentials {
  const resolvedPath = path.resolve(process.cwd(), credentialsPath);
  const raw = fs.readFileSync(resolvedPath, "utf8");
  const credentials = JSON.parse(raw) as ProviderCredentials;

  if (typeof credentials !== "object" || credentials === null) {
    throw new Error("Credentials file must contain a JSON object.");
  }

  if (provider === "onedrive") {
    if (typeof (credentials as { accessToken?: unknown }).accessToken !== "string") {
      throw new Error("OneDrive credentials must include an accessToken string.");
    }
  } else {
    const googleCredentials = credentials as {
      accessToken?: unknown;
      refreshToken?: unknown;
    };

    const hasAccessToken = typeof googleCredentials.accessToken === "string";
    const hasRefreshToken = typeof googleCredentials.refreshToken === "string";

    if (!hasAccessToken && !hasRefreshToken) {
      throw new Error("Google credentials must include an accessToken or refreshToken string.");
    }
  }

  return credentials;
}

function printHelp(): void {
  console.log("FileBaseDB CLI");
  console.log("");
  console.log("Usage:");
  console.log("  filebasedb --provider <google|onedrive> --folder <folderIdOrLink> --credentials <path>");
  console.log("             [--tag <tag>] [--type <mime>] [--from-date <iso>] [--to-date <iso>]");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.provider || !args.folder || !args.credentialsPath) {
    printHelp();
    process.exit(1);
  }

  const credentials = readCredentials(args.provider, args.credentialsPath);
  const db = await connect(args.provider, credentials);
  try {
    await db.useFolder(args.folder);

    const filters: FileFilters = {};
    if (args.tag) filters.tag = args.tag;
    if (args.type) filters.type = args.type;
    if (args.fromDate) filters.fromDate = args.fromDate;
    if (args.toDate) filters.toDate = args.toDate;

    const files = await db.getFiles(filters);
    console.log(JSON.stringify(files, null, 2));
  } finally {
    db.disconnect();
  }
}

void main().catch((error: Error) => {
  console.error(`FileBaseDB CLI error: ${safeErrorMessage(error, "Unexpected CLI error.")}`);
  process.exit(1);
});
