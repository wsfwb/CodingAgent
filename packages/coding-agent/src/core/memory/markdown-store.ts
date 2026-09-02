import { type FileHandle, open, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import YAML from "yaml";
import { AtomicFileConflictError, atomicWriteMemoryFile } from "./atomic-file.ts";
import {
	getMemoryScopeDirectory,
	getMemoryTopics,
	isMemoryTopicForScope,
	MEMORY_INDEX_FILE,
	MEMORY_PROJECT_FILE,
	normalizeMemoryProjectRoot,
} from "./config.ts";
import {
	MEMORY_SCHEMA_VERSION,
	type MemoryEntry,
	type MemoryIndex,
	type MemoryScope,
	type MemorySource,
	type MemoryTopic,
	type MemoryTopicDocument,
} from "./types.ts";
import { assertSafeMemoryText, validateMemoryIdentity } from "./validation.ts";

const TOPIC_HEADER_START = "<!-- pi-managed-memory";
const INDEX_HEADER_START = "<!-- pi-memory-index";
const COMMENT_END = "-->";
const ENTRY_START = "<!-- pi-memory:start";
const ENTRY_END = "<!-- pi-memory:end -->";
const MEMORY_SOURCES = new Set<MemorySource>(["user_explicit", "user_feedback", "verified_project_fact"]);

export class MemoryFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryFormatError";
	}
}

interface TopicHeader {
	schemaVersion: 1;
	scope: MemoryScope;
	topic: MemoryTopic;
	topicRevision: number;
}

export interface MemoryProjectMetadata {
	schemaVersion: 1;
	projectRoot: string;
	createdAt: string;
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MemoryFormatError(`${description} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new MemoryFormatError(`${name} must be a non-empty string`);
	return value;
}

function requireRevision(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new MemoryFormatError(`${name} must be a non-negative integer`);
	return value as number;
}

function parseYamlComment(content: string, marker: string): { value: unknown; end: number } {
	if (!content.startsWith(marker)) throw new MemoryFormatError(`missing ${marker} header`);
	const end = content.indexOf(COMMENT_END, marker.length);
	if (end === -1) throw new MemoryFormatError(`unterminated ${marker} header`);
	try {
		return { value: YAML.parse(content.slice(marker.length, end).trim()), end: end + COMMENT_END.length };
	} catch (error) {
		throw new MemoryFormatError(
			`invalid YAML in ${marker} header: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseTopicHeader(content: string): TopicHeader {
	const record = requireRecord(parseYamlComment(content, TOPIC_HEADER_START).value, "topic header");
	const scope = requireString(record.scope, "scope");
	const topic = requireString(record.topic, "topic");
	if (record.schemaVersion !== MEMORY_SCHEMA_VERSION) throw new MemoryFormatError("unsupported topic schemaVersion");
	if (scope !== "global" && scope !== "project") throw new MemoryFormatError("invalid memory scope");
	if (!isMemoryTopicForScope(scope, topic))
		throw new MemoryFormatError(`topic ${topic} is not valid for ${scope} memory`);
	return { schemaVersion: 1, scope, topic, topicRevision: requireRevision(record.topicRevision, "topicRevision") };
}

function parseEntryMetadata(value: unknown): Omit<MemoryEntry, "title" | "summary" | "content"> {
	const record = requireRecord(value, "memory entry metadata");
	if (record.schemaVersion !== MEMORY_SCHEMA_VERSION) throw new MemoryFormatError("unsupported entry schemaVersion");
	const source = requireString(record.source, "source");
	if (!MEMORY_SOURCES.has(source as MemorySource)) throw new MemoryFormatError(`invalid memory source: ${source}`);
	return {
		schemaVersion: 1,
		key: requireString(record.key, "key"),
		source: source as MemorySource,
		createdAt: requireString(record.createdAt, "createdAt"),
		observedAt: requireString(record.observedAt, "observedAt"),
		updatedAt: requireString(record.updatedAt, "updatedAt"),
		...(record.sourceSessionId === undefined
			? {}
			: { sourceSessionId: requireString(record.sourceSessionId, "sourceSessionId") }),
	};
}

function parseEntryBlock(block: string): MemoryEntry {
	const metadata = parseYamlComment(block, ENTRY_START);
	const body = block.slice(metadata.end).trim();
	const lines = body.split(/\r?\n/);
	if (!lines[0]?.startsWith("## ")) throw new MemoryFormatError("memory entry is missing its title");
	if (!lines[1]?.startsWith("**Summary:** ")) throw new MemoryFormatError("memory entry is missing its summary");
	const title = lines[0].slice(3).trim();
	const summary = lines[1].slice("**Summary:** ".length).trim();
	const content = lines.slice(2).join("\n").trim();
	if (!title || !summary || !content)
		throw new MemoryFormatError("memory entry title, summary, and content are required");
	return { ...parseEntryMetadata(metadata.value), title, summary, content };
}

export function parseMemoryTopic(content: string): MemoryTopicDocument {
	const header = parseTopicHeader(content);
	const entries: MemoryEntry[] = [];
	let cursor = 0;
	while (true) {
		const start = content.indexOf(ENTRY_START, cursor);
		if (start === -1) break;
		const end = content.indexOf(ENTRY_END, start);
		if (end === -1) throw new MemoryFormatError("unterminated memory entry");
		entries.push(parseEntryBlock(content.slice(start, end)));
		cursor = end + ENTRY_END.length;
	}
	const keys = new Set<string>();
	for (const entry of entries) {
		if (keys.has(entry.key)) throw new MemoryFormatError(`duplicate memory key: ${entry.key}`);
		keys.add(entry.key);
	}
	return { ...header, entries };
}

function yamlComment(marker: string, value: unknown): string {
	return `${marker}\n${YAML.stringify(value, { lineWidth: 0 }).trim()}\n${COMMENT_END}`;
}

export function renderMemoryTopic(document: MemoryTopicDocument): string {
	const header = yamlComment(TOPIC_HEADER_START, {
		schemaVersion: document.schemaVersion,
		scope: document.scope,
		topic: document.topic,
		topicRevision: document.topicRevision,
		warning: "Managed by Pi. Do not edit manually.",
	});
	const heading = `# ${document.scope === "global" ? "Global" : "Project"} ${capitalize(document.topic)}`;
	const blocks = document.entries.map((entry) => {
		const metadata = yamlComment(ENTRY_START, {
			schemaVersion: entry.schemaVersion,
			key: entry.key,
			source: entry.source,
			createdAt: entry.createdAt,
			observedAt: entry.observedAt,
			updatedAt: entry.updatedAt,
			...(entry.sourceSessionId ? { sourceSessionId: entry.sourceSessionId } : {}),
		});
		return `${metadata}\n## ${entry.title}\n**Summary:** ${entry.summary}\n${entry.content}\n${ENTRY_END}`;
	});
	return `${header}\n\n${heading}\n\n${blocks.join("\n\n")}\n`;
}

export function parseMemoryIndex(content: string): MemoryIndex {
	const parsed = parseYamlComment(content, INDEX_HEADER_START);
	const record = requireRecord(parsed.value, "index header");
	if (record.schemaVersion !== MEMORY_SCHEMA_VERSION) throw new MemoryFormatError("unsupported index schemaVersion");
	const scope = requireString(record.scope, "scope");
	if (scope !== "global" && scope !== "project") throw new MemoryFormatError("invalid index scope");
	const topicRecords = requireRecord(record.topics, "topics");
	const topicRevisions = new Map<MemoryTopic, number>();
	for (const [topic, value] of Object.entries(topicRecords)) {
		if (!isMemoryTopicForScope(scope, topic)) throw new MemoryFormatError(`invalid index topic: ${topic}`);
		topicRevisions.set(topic, requireRevision(requireRecord(value, topic).topicRevision, `${topic}.topicRevision`));
	}
	if (topicRevisions.size !== getMemoryTopics(scope).length) {
		throw new MemoryFormatError("memory index must contain every fixed topic");
	}
	const entriesByTopic = new Map<MemoryTopic, MemoryIndex["topics"][number]["entries"]>();
	let currentTopic: MemoryTopic | undefined;
	const lines = content.slice(parsed.end).split(/\r?\n/);
	const seenKeys = new Set<string>();
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.startsWith("## ")) {
			const heading = line.slice(3).trim().toLocaleLowerCase();
			currentTopic = getMemoryTopics(scope).find((topic) => topic === heading);
			if (!currentTopic) throw new MemoryFormatError(`invalid memory index section: ${heading}`);
			continue;
		}
		if (!line.startsWith("- `")) continue;
		if (!currentTopic) throw new MemoryFormatError("memory index entry appears outside a topic section");
		const match = line.match(/^- `([^`]+)` \| ([^|]+) \| (\d{4}-\d{2}-\d{2}) \| (.+)$/);
		if (!match) throw new MemoryFormatError("invalid memory index entry");
		const [, key, sourceText, observedAt, summary] = match;
		validateMemoryIdentity(scope, currentTopic, key);
		const source = sourceText.trim();
		if (!MEMORY_SOURCES.has(source as MemorySource)) throw new MemoryFormatError(`invalid memory source: ${source}`);
		assertSafeMemoryText(summary);
		if (seenKeys.has(key)) throw new MemoryFormatError(`duplicate memory key in index: ${key}`);
		seenKeys.add(key);
		if (lines[index + 1]?.trim() !== `Details: ${currentTopic}.md`) {
			throw new MemoryFormatError(`invalid detail pointer for memory key: ${key}`);
		}
		index++;
		const entries = entriesByTopic.get(currentTopic) ?? [];
		entries.push({ key, summary, source: source as MemorySource, observedAt });
		entriesByTopic.set(currentTopic, entries);
	}
	const topics = getMemoryTopics(scope).map((topic) => ({
		topic,
		topicRevision: topicRevisions.get(topic) ?? 0,
		entries: entriesByTopic.get(topic) ?? [],
	}));
	return { schemaVersion: 1, scope, generatedAt: requireString(record.generatedAt, "generatedAt"), topics };
}

export function renderMemoryIndex(index: MemoryIndex): string {
	const header = yamlComment(INDEX_HEADER_START, {
		schemaVersion: index.schemaVersion,
		scope: index.scope,
		generatedAt: index.generatedAt,
		topics: Object.fromEntries(index.topics.map((topic) => [topic.topic, { topicRevision: topic.topicRevision }])),
	});
	const heading = `# ${index.scope === "global" ? "Global" : "Project"} Memory`;
	const sections = index.topics
		.filter((topic) => topic.entries.length > 0)
		.map((topic) => {
			const entries = topic.entries
				.map(
					(entry) =>
						`- \`${entry.key}\` | ${entry.source} | ${entry.observedAt.slice(0, 10)} | ${entry.summary}\n  Details: ${topic.topic}.md`,
				)
				.join("\n");
			return `## ${capitalize(topic.topic)}\n${entries}`;
		});
	return `${header}\n\n${heading}\nHistorical auto-memory. Current user instructions and AGENTS.md take precedence.\n\n${sections.join("\n\n")}\n`;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

async function readUtf8IfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readPrefixIfExists(path: string, maxBytes: number): Promise<string | undefined> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

export class MemoryMarkdownStore {
	readonly agentDir: string;
	readonly projectRoot: string;
	readonly scope: MemoryScope;
	readonly scopeDirectory: string;

	constructor(agentDir: string, projectRoot: string, scope: MemoryScope) {
		this.agentDir = agentDir;
		this.projectRoot = projectRoot;
		this.scope = scope;
		this.scopeDirectory = getMemoryScopeDirectory(agentDir, scope, projectRoot);
	}

	get indexPath(): string {
		return join(this.scopeDirectory, MEMORY_INDEX_FILE);
	}

	getTopicPath(topic: MemoryTopic): string {
		if (!isMemoryTopicForScope(this.scope, topic))
			throw new MemoryFormatError(`topic ${topic} is not valid for ${this.scope} memory`);
		return join(this.scopeDirectory, `${topic}.md`);
	}

	async readTopic(topic: MemoryTopic): Promise<MemoryTopicDocument> {
		const content = await readUtf8IfExists(this.getTopicPath(topic));
		if (content === undefined) return { schemaVersion: 1, scope: this.scope, topic, topicRevision: 0, entries: [] };
		const document = parseMemoryTopic(content);
		if (document.scope !== this.scope || document.topic !== topic)
			throw new MemoryFormatError(`topic identity mismatch in ${basename(this.getTopicPath(topic))}`);
		return document;
	}

	async readTopicRevision(topic: MemoryTopic): Promise<number> {
		const prefix = await readPrefixIfExists(this.getTopicPath(topic), 2 * 1024);
		if (prefix === undefined) return 0;
		const header = parseTopicHeader(prefix);
		if (header.scope !== this.scope || header.topic !== topic) {
			throw new MemoryFormatError(`topic identity mismatch in ${basename(this.getTopicPath(topic))}`);
		}
		return header.topicRevision;
	}

	async loadConsistentIndex(
		now = new Date(),
		options: { persistRebuild?: boolean } = {},
	): Promise<{ index: MemoryIndex; content: string; rebuilt: boolean }> {
		const topics = getMemoryTopics(this.scope);
		const topicRevisions = await Promise.all(topics.map((topic) => this.readTopicRevision(topic)));
		const existing = await readUtf8IfExists(this.indexPath);
		if (existing !== undefined) {
			try {
				const parsed = parseMemoryIndex(existing);
				const consistent = topics.every(
					(topic, index) =>
						parsed.topics.find((candidate) => candidate.topic === topic)?.topicRevision === topicRevisions[index],
				);
				if (consistent) return { index: parsed, content: existing, rebuilt: false };
			} catch {
				// A topic document is the source of truth; a malformed derived index is rebuilt below.
			}
		}
		const topicDocuments = await Promise.all(topics.map((topic) => this.readTopic(topic)));
		const index = this.buildIndex(topicDocuments, now.toISOString());
		const content = renderMemoryIndex(index);
		if (options.persistRebuild === true) {
			await atomicWriteMemoryFile(this.indexPath, content);
		}
		return { index, content, rebuilt: true };
	}

	buildIndex(documents: readonly MemoryTopicDocument[], generatedAt: string): MemoryIndex {
		return {
			schemaVersion: 1,
			scope: this.scope,
			generatedAt,
			topics: getMemoryTopics(this.scope).map((topic) => {
				const document = documents.find((candidate) => candidate.topic === topic);
				return {
					topic,
					topicRevision: document?.topicRevision ?? 0,
					entries: (document?.entries ?? []).map(({ key, summary, source, observedAt }) => ({
						key,
						summary,
						source,
						observedAt,
					})),
				};
			}),
		};
	}

	async writeTopicAndIndex(document: MemoryTopicDocument, now = new Date()): Promise<void> {
		const documents = await Promise.all(
			getMemoryTopics(this.scope).map((topic) => (topic === document.topic ? document : this.readTopic(topic))),
		);
		await this.writeDocumentsAndIndex(documents, now);
	}

	async writeDocumentsAndIndex(documents: readonly MemoryTopicDocument[], now = new Date()): Promise<void> {
		for (const topic of getMemoryTopics(this.scope)) {
			const document = documents.find((candidate) => candidate.topic === topic);
			if (!document) throw new MemoryFormatError(`missing memory topic: ${topic}`);
			await atomicWriteMemoryFile(this.getTopicPath(topic), renderMemoryTopic(document));
		}
		await atomicWriteMemoryFile(this.indexPath, renderMemoryIndex(this.buildIndex(documents, now.toISOString())));
	}

	async ensureProjectMetadata(now = new Date()): Promise<void> {
		if (this.scope !== "project") return;
		const path = join(this.scopeDirectory, MEMORY_PROJECT_FILE);
		const existing = await readUtf8IfExists(path);
		const normalizedRoot = normalizeMemoryProjectRoot(this.projectRoot);
		if (existing !== undefined) {
			validateProjectMetadata(existing, normalizedRoot);
			return;
		}
		const metadata: MemoryProjectMetadata = {
			schemaVersion: 1,
			projectRoot: normalizedRoot,
			createdAt: now.toISOString(),
		};
		try {
			await atomicWriteMemoryFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
		} catch (error) {
			if (!(error instanceof AtomicFileConflictError)) throw error;
			const raced = await readUtf8IfExists(path);
			if (raced === undefined) throw error;
			validateProjectMetadata(raced, normalizedRoot);
		}
	}
}

function validateProjectMetadata(content: string, normalizedRoot: string): void {
	const value = requireRecord(JSON.parse(content) as unknown, "project metadata");
	if (value.schemaVersion !== 1 || value.projectRoot !== normalizedRoot) {
		throw new MemoryFormatError("project memory identity mismatch");
	}
}
