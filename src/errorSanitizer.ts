import * as path from "path";

const MAX_SANITIZE_OUTPUT_CHARS = 8000;
const MAX_SANITIZE_INPUT_CHARS = 16000;
const REDACTED_PLACEHOLDER = "[REDACTED]";

function basenameFromPathLike(raw: string): string {
  const value = typeof raw === "string" ? raw : String(raw ?? "");
  if (!value) return "";

  if (/^file:\/\/\/?/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === "file:") {
        const decoded = decodeURIComponent(url.pathname || "");
        const normalized = decoded.replace(/^\/([A-Za-z]:[\\/])/, "$1");
        if (/^[A-Za-z]:(\\|\/)/.test(normalized)) {
          return path.win32.basename(normalized);
        }
        return path.posix.basename(normalized);
      }
    } catch {
      // Fall through to string-based handling below.
    }
    return basenameFromPathLike(value.replace(/^file:\/\/\/?/i, ""));
  }

  if (value.startsWith("\\\\")) {
    return path.win32.basename(value);
  }

  if (/^[A-Za-z]:(\\|\/)/.test(value)) {
    return path.win32.basename(value);
  }

  if (value.startsWith("/")) {
    return path.posix.basename(value);
  }

  return path.basename(value);
}

function sanitizeSensitiveDetails(
  input: string,
  redactedPlaceholder: string,
): string {
  return input
    .replace(
      /(\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_m, prefix: string) => `${prefix}${redactedPlaceholder}`,
    )
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|password|passwd)=)[^&\s]+/gi,
      (_m, prefix: string) => `${prefix}${redactedPlaceholder}`,
    )
    .replace(
      /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|password|passwd)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_m, prefix: string) => `${prefix}${redactedPlaceholder}`,
    );
}

export function sanitizeAbsolutePathDetails(
  message: string,
  redactedPlaceholder = REDACTED_PLACEHOLDER,
): string {
  const rawText = typeof message === "string" ? message : String(message ?? "");
  if (!rawText) return "";
  const input =
    rawText.length > MAX_SANITIZE_INPUT_CHARS
      ? rawText.slice(0, MAX_SANITIZE_INPUT_CHARS)
      : rawText;
  const maskedInput = sanitizeSensitiveDetails(input, redactedPlaceholder);

  const sanitized = maskedInput
    .replace(
      /'(file:\/\/[^']+)'/gi,
      (_m, p1: string) => `'${basenameFromPathLike(p1)}'`,
    )
    .replace(
      /"(file:\/\/[^"]+)"/gi,
      (_m, p1: string) => `"${basenameFromPathLike(p1)}"`,
    )
    .replace(/file:\/\/[^\s"'`]+/gi, (m) => basenameFromPathLike(m))
    .replace(
      /'((?:[A-Za-z]:(?:\\|\/)|\\\\)[^']+)'/g,
      (_m, p1: string) => `'${basenameFromPathLike(p1)}'`,
    )
    .replace(
      /"((?:[A-Za-z]:(?:\\|\/)|\\\\)[^"]+)"/g,
      (_m, p1: string) => `"${basenameFromPathLike(p1)}"`,
    )
    .replace(
      /(^|[^A-Za-z0-9_])((?:[A-Za-z]:(?:\\|\/)|\\\\)(?:[^\\\/:"'`\r\n]+[\\/])+[^"'`\r\n]*\s+[^"'`\r\n]*?)(?=$|[)\],:;.!?])/g,
      (_m, prefix: string, p1: string) =>
        `${prefix}${basenameFromPathLike(p1)}`,
    )
    .replace(
      /(^|[^A-Za-z0-9_])((?:[A-Za-z]:(?:\\|\/)|\\\\)[^"'`\r\n]*?\.[A-Za-z0-9]{1,16})(?=$|[\s)\],:;.!?])/g,
      (_m, prefix: string, p1: string) =>
        `${prefix}${basenameFromPathLike(p1)}`,
    )
    .replace(
      /(^|[^A-Za-z0-9_])((?:[A-Za-z]:(?:\\|\/)|\\\\)(?:[^\s"'`\\/]+[\\/])+[^\s"'`\\/]+)/g,
      (_m, prefix: string, p1: string) =>
        `${prefix}${basenameFromPathLike(p1)}`,
    )
    .replace(
      /(\b(?:open|stat|lstat|scandir|unlink|readFile|writeFile|rename|mkdir|rmdir|readdir|readlink|realpath|opendir|copyfile|access|chmod)\s+)((?:[A-Za-z]:(?:\\|\/))[^\s"'`\\/]+)(?=$|[\s)\],:;.!?])/gi,
      (_m, prefix: string, p1: string) =>
        `${prefix}${basenameFromPathLike(p1)}`,
    )
    .replace(
      /'(\/[^']+)'/g,
      (_m, p1: string) => `'${basenameFromPathLike(p1)}'`,
    )
    .replace(
      /"(\/[^"]+)"/g,
      (_m, p1: string) => `"${basenameFromPathLike(p1)}"`,
    )
    .replace(
      /(^|[\s(])(\/(?:[^\/:"'`\r\n]+\/)+[^"'`\r\n]*\s+[^"'`\r\n]*?)(?=$|[)\],:;.!?])/g,
      (_m, prefix: string, p1: string) =>
        `${prefix}${basenameFromPathLike(p1)}`,
    )
    .replace(
      /(^|[\s(])(\/[^"'`\r\n]*?\.[A-Za-z0-9]{1,16})(?=$|[\s)\],:;.!?])/g,
      (_m, prefix: string, p1: string) =>
        `${prefix}${basenameFromPathLike(p1)}`,
    )
    .replace(
      /(\b(?:open|stat|lstat|scandir|unlink|readFile|writeFile|rename|mkdir|rmdir|readdir|readlink|realpath|opendir|copyfile|access|chmod)\s+)(\/[^\s"'`\/]+)(?=$|[\s)\],:;.!?])/gi,
      (_m, prefix: string, p1: string) =>
        `${prefix}${basenameFromPathLike(p1)}`,
    )
    .replace(
      /(^|[\s(])(\/[^\s"'`\/]+(?:\/[^\s"'`\/]+)+)/g,
      (_m, prefix: string, p1: string) =>
        `${prefix}${basenameFromPathLike(p1)}`,
    );

  return sanitized.length > MAX_SANITIZE_OUTPUT_CHARS
    ? sanitized.slice(0, MAX_SANITIZE_OUTPUT_CHARS)
    : sanitized;
}
