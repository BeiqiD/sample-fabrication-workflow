import type {
  ManagedStorage,
  ManagedStorageObject,
  ManagedStoragePut,
} from "./managed-storage";

const DEFAULT_ROOT = "sample-fabrication-workflow";
const SWITCHDRIVE_HOST = "drive.switch.ch";

export interface SwitchdriveConfiguration {
  webdavUrl: string;
  username: string;
  appPassword: string;
  root: string;
}

export class SwitchdriveAuthenticationError extends Error {
  constructor() {
    super("SWITCHdrive rejected the configured credentials");
    this.name = "SwitchdriveAuthenticationError";
  }
}

function basicAuthorization(username: string, password: string) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function safeSegments(value: string, label: string) {
  const segments = value.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error(`${label} contains an invalid path`);
  }
  return segments;
}

function validateWebdavUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== SWITCHDRIVE_HOST || url.username || url.password
    || !/^\/remote\.php\/dav\/files\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error("The SWITCHdrive WebDAV URL is invalid");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function objectUrl(baseUrl: string, segments: string[]) {
  return `${baseUrl}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

async function checkedResponse(response: Response, accepted: number[]) {
  if (response.status === 401 || response.status === 403) throw new SwitchdriveAuthenticationError();
  if (!accepted.includes(response.status)) {
    throw new Error(`SWITCHdrive WebDAV request failed with status ${response.status}`);
  }
  return response;
}

export function switchdriveConfiguration(input: {
  SWITCHDRIVE_WEBDAV_URL?: string;
  SWITCHDRIVE_USERNAME?: string;
  SWITCHDRIVE_APP_PASSWORD?: string;
  SWITCHDRIVE_ROOT?: string;
}): SwitchdriveConfiguration | null {
  const webdavUrl = input.SWITCHDRIVE_WEBDAV_URL?.trim();
  const username = input.SWITCHDRIVE_USERNAME?.trim();
  const appPassword = input.SWITCHDRIVE_APP_PASSWORD?.trim();
  if (!webdavUrl || !username || !appPassword) return null;
  const root = input.SWITCHDRIVE_ROOT?.trim() || DEFAULT_ROOT;
  safeSegments(root, "SWITCHdrive root");
  return {
    webdavUrl: validateWebdavUrl(webdavUrl),
    username,
    appPassword,
    root,
  };
}

export class SwitchdriveStorage implements ManagedStorage {
  readonly provider = "switchdrive";
  readonly authentication = "service_binding" as const;
  private readonly baseUrl: string;
  private readonly rootSegments: string[];
  private readonly authorization: string;

  constructor(configuration: SwitchdriveConfiguration) {
    this.baseUrl = configuration.webdavUrl;
    this.rootSegments = safeSegments(configuration.root, "SWITCHdrive root");
    this.authorization = basicAuthorization(configuration.username, configuration.appPassword);
  }

  private headers(additional?: HeadersInit) {
    const headers = new Headers(additional);
    headers.set("authorization", this.authorization);
    return headers;
  }

  private async ensureDirectories(segments: string[]) {
    for (let length = 1; length <= segments.length; length += 1) {
      const response = await fetch(objectUrl(this.baseUrl, segments.slice(0, length)), {
        method: "MKCOL",
        headers: this.headers(),
      });
      await checkedResponse(response, [201, 405]);
    }
  }

  async check() {
    const response = await fetch(`${this.baseUrl}/`, {
      method: "PROPFIND",
      headers: this.headers({ depth: "0" }),
      signal: AbortSignal.timeout(10_000),
    });
    await checkedResponse(response, [200, 207]);
  }

  async put(input: ManagedStoragePut) {
    const keySegments = safeSegments(input.key, "Managed object key");
    const allSegments = [...this.rootSegments, ...keySegments];
    await this.ensureDirectories(allSegments.slice(0, -1));
    const url = objectUrl(this.baseUrl, allSegments);
    const response = await fetch(url, {
      method: "PUT",
      headers: this.headers({
        "content-type": input.contentType,
      }),
      body: input.body,
    });
    await checkedResponse(response, [200, 201, 204]);

    const metadata = await fetch(url, { method: "HEAD", headers: this.headers() });
    await checkedResponse(metadata, [200]);
    const storedSizeHeader = metadata.headers.get("content-length");
    if (storedSizeHeader !== null) {
      const storedSize = Number(storedSizeHeader);
      if (Number.isFinite(storedSize) && storedSize !== input.byteSize) {
        await this.delete(input.key);
        throw new Error("SWITCHdrive reported a different attachment size after upload");
      }
    }
    return { byteSize: input.byteSize };
  }

  async get(key: string): Promise<ManagedStorageObject | null> {
    const keySegments = safeSegments(key, "Managed object key");
    const response = await fetch(objectUrl(this.baseUrl, [...this.rootSegments, ...keySegments]), {
      method: "GET",
      headers: this.headers(),
    });
    if (response.status === 404) return null;
    await checkedResponse(response, [200]);
    if (!response.body) throw new Error("SWITCHdrive returned an empty response body");
    return {
      body: response.body,
      contentType: response.headers.get("content-type") || "application/octet-stream",
      etag: response.headers.get("etag"),
    };
  }

  async delete(key: string) {
    const keySegments = safeSegments(key, "Managed object key");
    const response = await fetch(objectUrl(this.baseUrl, [...this.rootSegments, ...keySegments]), {
      method: "DELETE",
      headers: this.headers(),
    });
    await checkedResponse(response, [200, 204, 404]);
  }
}
