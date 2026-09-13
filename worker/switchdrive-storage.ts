import type { ManagedStorageStatus } from "../shared/types";
import type {
  ManagedStorage,
  ManagedStorageObject,
  ManagedStoragePut,
  ManagedStorageStat,
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
  constructor(readonly status: 401 | 403) {
    super(`SWITCHdrive WebDAV request failed with status ${status}`);
    this.name = "SwitchdriveAuthenticationError";
  }
}

export class SwitchdriveConnectionCheckError extends Error {
  readonly diagnostic: NonNullable<ManagedStorageStatus["diagnostic"]>;

  constructor(
    response: Pick<Response, "status" | "redirected" | "headers">,
    providerReason?: NonNullable<ManagedStorageStatus["diagnostic"]>["providerReason"],
  ) {
    const httpStatus = response.status;
    const classification = httpStatus === 401 ? "authentication_required"
      : httpStatus === 403 ? "forbidden"
        : [301, 302, 303, 307, 308].includes(httpStatus) ? "redirect" : "upstream_error";
    const message = classification === "authentication_required"
      ? "SWITCHdrive requires authentication (HTTP 401)."
      : classification === "forbidden"
        ? "SWITCHdrive denied WebDAV access (HTTP 403)."
        : classification === "redirect"
          ? `SWITCHdrive returned a redirect (HTTP ${httpStatus}). The connection check did not follow it.`
          : `SWITCHdrive WebDAV check failed (HTTP ${httpStatus}).`;
    super(message);
    this.name = "SwitchdriveConnectionCheckError";
    // Only fixed classifications and Fetch's status/redirect flag are exposed.
    // Never retain response URLs, headers, bodies, or authentication values.
    this.diagnostic = {
      httpStatus,
      redirected: response.redirected,
      classification,
      basicChallenge: /(?:^|,)\s*Basic(?:\s|$)/i.test(response.headers.get("www-authenticate") ?? ""),
      ...(providerReason ? { providerReason } : {}),
    };
  }
}

async function recognizedDavFailure(response: Response) {
  if (![401, 403].includes(response.status) || !response.body) return undefined;
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/xml" && mediaType !== "text/xml") return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = 8 * 1024;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value.subarray(0, remaining);
      text += decoder.decode(bytes, { stream: true });
      remaining -= bytes.byteLength;
    }
    text += decoder.decode();
    // Only exact known exception element values are recognized. No XML entity
    // expansion, provider message, credential value, or unknown text is exposed.
    const exception = text.match(/<((?:[A-Za-z_][\w.-]*:)?exception)>\s*(Sabre\\DAV\\Exception\\(?:NotAuthenticated|Forbidden))\s*<\/\1\s*>/);
    if (exception?.[2] === "Sabre\\DAV\\Exception\\NotAuthenticated") return "not_authenticated" as const;
    if (exception?.[2] === "Sabre\\DAV\\Exception\\Forbidden") return "forbidden" as const;
    return undefined;
  } catch {
    // The original HTTP result remains useful even if its optional XML is unreadable.
    return undefined;
  } finally {
    reader.releaseLock();
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
  if (response.status === 401 || response.status === 403) throw new SwitchdriveAuthenticationError(response.status);
  if (!accepted.includes(response.status)) {
    throw new Error(`SWITCHdrive WebDAV request failed with status ${response.status}`);
  }
  return response;
}

async function discardResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing unused bytes must not replace the operation's HTTP outcome.
  }
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
        redirect: "manual",
      });
      try {
        await checkedResponse(response, [201, 405]);
      } finally {
        await discardResponseBody(response);
      }
    }
  }

  async check() {
    const response = await fetch(`${this.baseUrl}/`, {
      method: "PROPFIND",
      headers: this.headers({ depth: "0" }),
      // Workers forward Authorization on automatic redirects, including across
      // hosts. Surface the first response without sending credentials onward.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    try {
      if (![200, 207].includes(response.status)) {
        throw new SwitchdriveConnectionCheckError(response, await recognizedDavFailure(response));
      }
    } finally {
      // Status probes never consume successful bodies; release unread bytes on
      // every path, including redirects, non-XML failures and truncated XML.
      await discardResponseBody(response);
    }
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
      redirect: "manual",
    });
    try {
      await checkedResponse(response, [200, 201, 204]);
    } finally {
      await discardResponseBody(response);
    }

    const metadata = await this.stat(input.key);
    // A failed observation does not authorize deleting uploaded bytes. The
    // registration candidate remains tracked for lifecycle reconciliation/GC.
    if (!metadata) {
      throw new Error("SWITCHdrive could not verify the attachment after upload");
    }
    if (metadata.byteSize !== null && metadata.byteSize !== input.byteSize) {
      throw new Error("SWITCHdrive reported a different attachment size after upload");
    }
    return { byteSize: input.byteSize };
  }

  async stat(key: string): Promise<ManagedStorageStat | null> {
    const keySegments = safeSegments(key, "Managed object key");
    const response = await fetch(objectUrl(this.baseUrl, [...this.rootSegments, ...keySegments]), {
      method: "HEAD",
      headers: this.headers(),
      redirect: "manual",
    });
    try {
      if (response.status === 404) return null;
      await checkedResponse(response, [200]);
      const sizeHeader = response.headers.get("content-length");
      const parsedSize = sizeHeader === null ? null : Number(sizeHeader);
      return {
        byteSize: parsedSize !== null && Number.isSafeInteger(parsedSize) && parsedSize >= 0
          ? parsedSize
          : null,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        etag: response.headers.get("etag"),
      };
    } finally {
      await discardResponseBody(response);
    }
  }

  async get(key: string): Promise<ManagedStorageObject | null> {
    const keySegments = safeSegments(key, "Managed object key");
    const response = await fetch(objectUrl(this.baseUrl, [...this.rootSegments, ...keySegments]), {
      method: "GET",
      headers: this.headers(),
      redirect: "manual",
    });
    let bodyTransferred = false;
    try {
      if (response.status === 404) return null;
      await checkedResponse(response, [200]);
      if (!response.body) throw new Error("SWITCHdrive returned an empty response body");
      const object = {
        body: response.body,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        etag: response.headers.get("etag"),
      };
      bodyTransferred = true;
      return object;
    } finally {
      if (!bodyTransferred) await discardResponseBody(response);
    }
  }

  async delete(key: string) {
    const keySegments = safeSegments(key, "Managed object key");
    const response = await fetch(objectUrl(this.baseUrl, [...this.rootSegments, ...keySegments]), {
      method: "DELETE",
      headers: this.headers(),
      redirect: "manual",
    });
    try {
      await checkedResponse(response, [200, 204, 404]);
    } finally {
      await discardResponseBody(response);
    }
  }
}
