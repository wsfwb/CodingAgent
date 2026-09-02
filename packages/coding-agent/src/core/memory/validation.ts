import { isMemoryTopicForScope } from "./config.ts";
import { MEMORY_LIMITS, utf8Bytes } from "./limits.ts";
import type { MemoryEntry, MemoryScope, MemorySource, MemoryTopic } from "./types.ts";

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
	/\b(?:sk|rk|pk)-(?:live|test)-[a-z0-9_-]{16,}\b/i,
	/\b(?:ghp|gho|ghu|ghs|github_pat)_[a-z0-9_]{20,}\b/i,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*["']?[a-z0-9_+\-/.]{12,}["']?/i,
];
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
	/\bignore (?:all |any )?(?:previous|prior|above) (?:instructions|prompts|rules)\b/i,
	/\b(?:system|developer) (?:message|prompt) (?:says|requires|is)\b/i,
	/\breveal (?:the )?(?:system|developer) (?:message|prompt)\b/i,
];
const SECRET_REDACTIONS: Array<[RegExp, string]> = [
	[
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
		"[REDACTED PRIVATE KEY]",
	],
	[/\b(?:sk|rk|pk)-(?:live|test)-[a-z0-9_-]{16,}\b/gi, "[REDACTED TOKEN]"],
	[/\b(?:ghp|gho|ghu|ghs|github_pat)_[a-z0-9_]{20,}\b/gi, "[REDACTED TOKEN]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED ACCESS KEY]"],
	[
		/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)["']?[a-z0-9_+\-/.]{12,}["']?/gi,
		"$1[REDACTED]",
	],
];

export class MemoryValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryValidationError";
	}
}

function requireSingleLine(value: string, name: string, maxChars: number): void {
	if (!value.trim()) throw new MemoryValidationError(`${name} must not be empty`);
	if (value !== value.trim()) throw new MemoryValidationError(`${name} must not have surrounding whitespace`);
	if (/\r|\n/.test(value)) throw new MemoryValidationError(`${name} must be a single line`);
	if (value.length > maxChars) throw new MemoryValidationError(`${name} exceeds ${maxChars} characters`);
}

function requireIsoTimestamp(value: string, name: string): void {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
		throw new MemoryValidationError(`${name} must be an ISO-8601 UTC timestamp`);
	}
}

export function assertSafeMemoryText(value: string): void {
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(value)) throw new MemoryValidationError("memory must not contain credentials or secrets");
	}
	for (const pattern of PROMPT_INJECTION_PATTERNS) {
		if (pattern.test(value)) throw new MemoryValidationError("memory contains prompt-injection-like instructions");
	}
}

export function redactMemorySecrets(value: string): string {
	let redacted = value;
	for (const [pattern, replacement] of SECRET_REDACTIONS) redacted = redacted.replace(pattern, replacement);
	return redacted;
}

export function validateMemoryIdentity(scope: MemoryScope, topic: MemoryTopic, key: string): void {
	if (!isMemoryTopicForScope(scope, topic))
		throw new MemoryValidationError(`topic ${topic} is not valid for ${scope} memory`);
	requireSingleLine(key, "key", MEMORY_LIMITS.keyChars);
	if (!KEY_PATTERN.test(key)) throw new MemoryValidationError("key must use lowercase kebab-case");
}

export function validateMemorySource(scope: MemoryScope, source: MemorySource): void {
	if (scope === "global" && source === "verified_project_fact") {
		throw new MemoryValidationError("verified project facts cannot be stored in global memory");
	}
}

export function validateMemoryEntry(scope: MemoryScope, topic: MemoryTopic, entry: MemoryEntry): void {
	if (entry.schemaVersion !== 1) throw new MemoryValidationError("unsupported memory schemaVersion");
	validateMemoryIdentity(scope, topic, entry.key);
	validateMemorySource(scope, entry.source);
	requireSingleLine(entry.title, "title", MEMORY_LIMITS.titleChars);
	requireSingleLine(entry.summary, "summary", MEMORY_LIMITS.summaryChars);
	if (!entry.content.trim()) throw new MemoryValidationError("content must not be empty");
	if (entry.content !== entry.content.trim())
		throw new MemoryValidationError("content must not have surrounding whitespace");
	if (utf8Bytes(entry.content) > MEMORY_LIMITS.contentBytes) {
		throw new MemoryValidationError(`content exceeds ${MEMORY_LIMITS.contentBytes} UTF-8 bytes`);
	}
	if (entry.content.includes("<!-- pi-memory:")) {
		throw new MemoryValidationError("content contains a reserved managed-memory marker");
	}
	requireIsoTimestamp(entry.createdAt, "createdAt");
	requireIsoTimestamp(entry.observedAt, "observedAt");
	requireIsoTimestamp(entry.updatedAt, "updatedAt");
	if (entry.sourceSessionId !== undefined) requireSingleLine(entry.sourceSessionId, "sourceSessionId", 200);
	assertSafeMemoryText(`${entry.title}\n${entry.summary}\n${entry.content}`);
}

export function normalizedMemoryMeaning(entry: Pick<MemoryEntry, "summary" | "content">): string {
	return `${entry.summary}\n${entry.content}`.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
