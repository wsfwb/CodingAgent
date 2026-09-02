import { getMemoryTopics, isMemoryTopicForScope } from "./config.ts";
import { MEMORY_LIMITS, utf8Bytes } from "./limits.ts";
import { MemoryMarkdownStore, renderMemoryIndex, renderMemoryTopic } from "./markdown-store.ts";
import { acquireMemoryScopeLock } from "./scope-lock.ts";
import type { MemoryEntry, MemoryIndex, MemoryScope, MemorySource, MemoryTopic, MemoryTopicDocument } from "./types.ts";
import {
	MemoryValidationError,
	normalizedMemoryMeaning,
	validateMemoryEntry,
	validateMemoryIdentity,
	validateMemorySource,
} from "./validation.ts";

export interface MemoryEntryDraft {
	key: string;
	title: string;
	summary: string;
	content: string;
	source: MemorySource;
	sourceSessionId?: string;
}

export interface MemoryConsolidationRequest {
	document: MemoryTopicDocument;
	protectedKeys: readonly string[];
	targetBytes: number;
}

export interface MemoryConsolidator {
	consolidate(request: MemoryConsolidationRequest): Promise<MemoryTopicDocument>;
}

export interface MemoryMutationResult {
	action: "created" | "updated" | "forgotten";
	scope: MemoryScope;
	topic: MemoryTopic;
	key: string;
	topicRevision: number;
}

export class MemoryManagerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryManagerError";
	}
}

export interface MemoryManagerOptions {
	agentDir: string;
	projectRoot: string;
	consolidator?: MemoryConsolidator;
	now?: () => Date;
}

export class MemoryManager {
	private readonly agentDir: string;
	private readonly projectRoot: string;
	private readonly consolidator?: MemoryConsolidator;
	private readonly now: () => Date;

	constructor(options: MemoryManagerOptions) {
		this.agentDir = options.agentDir;
		this.projectRoot = options.projectRoot;
		this.consolidator = options.consolidator;
		this.now = options.now ?? (() => new Date());
	}

	async read(scope: MemoryScope, topic: MemoryTopic): Promise<MemoryTopicDocument> {
		if (!isMemoryTopicForScope(scope, topic))
			throw new MemoryValidationError(`topic ${topic} is not valid for ${scope} memory`);
		return this.store(scope).readTopic(topic);
	}

	getIndexPath(scope: MemoryScope): string {
		return this.store(scope).indexPath;
	}

	async loadIndex(scope: MemoryScope): Promise<{ index: MemoryIndex; content: string }> {
		const store = this.store(scope);
		await store.ensureProjectMetadata(this.now());
		const loaded = await store.loadConsistentIndex(this.now());
		if (!loaded.rebuilt) return loaded;
		const release = await acquireMemoryScopeLock(store.scopeDirectory);
		try {
			await store.ensureProjectMetadata(this.now());
			return await store.loadConsistentIndex(this.now(), { persistRebuild: true });
		} finally {
			await release();
		}
	}

	async create(scope: MemoryScope, topic: MemoryTopic, draft: MemoryEntryDraft): Promise<MemoryMutationResult> {
		validateMemoryIdentity(scope, topic, draft.key);
		validateMemorySource(scope, draft.source);
		return this.mutate(scope, topic, draft.key, async (documents, now) => {
			const existing = findEntry(documents, draft.key);
			if (existing)
				throw new MemoryManagerError(`memory key already exists in ${existing.document.topic}: ${draft.key}`);
			const entry = this.entryFromDraft(draft, now, now);
			validateMemoryEntry(scope, topic, entry);
			const duplicate = findMeaning(documents, entry);
			if (duplicate) throw new MemoryManagerError(`equivalent memory already exists as key ${duplicate.entry.key}`);
			return { action: "created", entries: [...documentFor(documents, topic).entries, entry] };
		});
	}

	async update(scope: MemoryScope, topic: MemoryTopic, draft: MemoryEntryDraft): Promise<MemoryMutationResult> {
		validateMemoryIdentity(scope, topic, draft.key);
		validateMemorySource(scope, draft.source);
		return this.mutate(scope, topic, draft.key, async (documents, now) => {
			const found = findEntry(documents, draft.key);
			if (!found) throw new MemoryManagerError(`memory key does not exist: ${draft.key}`);
			if (found.document.topic !== topic)
				throw new MemoryManagerError(`memory key belongs to topic ${found.document.topic}`);
			const entry = this.entryFromDraft(draft, found.entry.createdAt, now);
			validateMemoryEntry(scope, topic, entry);
			const duplicate = findMeaning(documents, entry, draft.key);
			if (duplicate) throw new MemoryManagerError(`equivalent memory already exists as key ${duplicate.entry.key}`);
			return {
				action: "updated",
				entries: found.document.entries.map((candidate) => (candidate.key === draft.key ? entry : candidate)),
			};
		});
	}

	async forget(scope: MemoryScope, topic: MemoryTopic, key: string): Promise<MemoryMutationResult> {
		validateMemoryIdentity(scope, topic, key);
		return this.mutate(scope, topic, key, async (documents) => {
			const found = findEntry(documents, key);
			if (!found) throw new MemoryManagerError(`memory key does not exist: ${key}`);
			if (found.document.topic !== topic)
				throw new MemoryManagerError(`memory key belongs to topic ${found.document.topic}`);
			return { action: "forgotten", entries: found.document.entries.filter((entry) => entry.key !== key) };
		});
	}

	private store(scope: MemoryScope): MemoryMarkdownStore {
		return new MemoryMarkdownStore(this.agentDir, this.projectRoot, scope);
	}

	private entryFromDraft(draft: MemoryEntryDraft, createdAt: string, updatedAt: string): MemoryEntry {
		return {
			schemaVersion: 1,
			key: draft.key,
			title: draft.title,
			summary: draft.summary,
			content: draft.content,
			source: draft.source,
			createdAt,
			observedAt: updatedAt,
			updatedAt,
			...(draft.sourceSessionId ? { sourceSessionId: draft.sourceSessionId } : {}),
		};
	}

	private async mutate(
		scope: MemoryScope,
		topic: MemoryTopic,
		key: string,
		apply: (
			documents: MemoryTopicDocument[],
			now: string,
		) => Promise<{ action: MemoryMutationResult["action"]; entries: MemoryEntry[] }>,
	): Promise<MemoryMutationResult> {
		const store = this.store(scope);
		const release = await acquireMemoryScopeLock(store.scopeDirectory);
		try {
			await store.ensureProjectMetadata(this.now());
			const documents = await Promise.all(getMemoryTopics(scope).map((candidate) => store.readTopic(candidate)));
			const current = documentFor(documents, topic);
			const outcome = await apply(documents, this.now().toISOString());
			let updated: MemoryTopicDocument = {
				...current,
				topicRevision: current.topicRevision + 1,
				entries: outcome.entries,
			};
			for (const entry of updated.entries) validateMemoryEntry(scope, topic, entry);
			const protectedKey = outcome.action === "forgotten" ? undefined : key;
			updated = await this.consolidateIfNeeded(updated, protectedKey);
			let nextDocuments = documents.map((document) => (document.topic === topic ? updated : document));
			nextDocuments = await this.consolidateIndexIfNeeded(store, nextDocuments, protectedKey);
			updated = documentFor(nextDocuments, topic);
			await store.writeDocumentsAndIndex(nextDocuments, this.now());
			return { action: outcome.action, scope, topic, key, topicRevision: updated.topicRevision };
		} finally {
			await release();
		}
	}

	private async consolidateIfNeeded(
		document: MemoryTopicDocument,
		protectedKey?: string,
	): Promise<MemoryTopicDocument> {
		let renderedBytes = utf8Bytes(renderMemoryTopic(document));
		if (renderedBytes <= MEMORY_LIMITS.topicSoftBytes) return document;
		if (this.consolidator) {
			try {
				const consolidated = await this.consolidator.consolidate({
					document: structuredClone(document),
					protectedKeys: protectedKey ? [protectedKey] : [],
					targetBytes: MEMORY_LIMITS.topicTargetBytes,
				});
				document = this.normalizeConsolidation(document, consolidated, protectedKey);
				renderedBytes = utf8Bytes(renderMemoryTopic(document));
			} catch {
				// Below the hard limit, a failed semantic consolidation must not lose a valid new memory.
			}
		}
		if (renderedBytes > MEMORY_LIMITS.topicHardBytes) {
			document = trimOldLowValueEntries(document, protectedKey, MEMORY_LIMITS.topicHardBytes);
		}
		if (utf8Bytes(renderMemoryTopic(document)) > MEMORY_LIMITS.topicHardBytes) {
			throw new MemoryManagerError("memory topic remains above the hard limit after consolidation");
		}
		return document;
	}

	private async consolidateIndexIfNeeded(
		store: MemoryMarkdownStore,
		documents: MemoryTopicDocument[],
		protectedKey?: string,
	): Promise<MemoryTopicDocument[]> {
		const indexBytes = () => utf8Bytes(renderMemoryIndex(store.buildIndex(documents, this.now().toISOString())));
		if (indexBytes() <= MEMORY_LIMITS.indexSoftBytes) return documents;

		if (this.consolidator) {
			const candidates = [...documents].sort((a, b) => indexSummaryBytes(b) - indexSummaryBytes(a));
			for (const candidate of candidates) {
				if (indexBytes() <= MEMORY_LIMITS.indexTargetBytes) break;
				try {
					const protectsCurrent =
						protectedKey !== undefined && candidate.entries.some((entry) => entry.key === protectedKey);
					const consolidated = await this.consolidator.consolidate({
						document: structuredClone(candidate),
						protectedKeys: protectsCurrent ? [protectedKey] : [],
						targetBytes: MEMORY_LIMITS.topicTargetBytes,
					});
					const normalized = this.normalizeConsolidation(candidate, consolidated, protectedKey, protectsCurrent);
					if (JSON.stringify(normalized.entries) !== JSON.stringify(candidate.entries)) {
						documents = documents.map((document) =>
							document.topic === candidate.topic
								? { ...normalized, topicRevision: candidate.topicRevision + 1 }
								: document,
						);
					}
				} catch {
					// Hard-limit enforcement below remains deterministic if semantic consolidation fails.
				}
			}
		}

		while (indexBytes() > MEMORY_LIMITS.indexHardBytes) {
			const removable = lowestValueEntry(documents, protectedKey);
			if (!removable) break;
			documents = documents.map((document) =>
				document.topic === removable.topic
					? {
							...document,
							topicRevision: document.topicRevision + 1,
							entries: document.entries.filter((entry) => entry.key !== removable.key),
						}
					: document,
			);
		}
		if (indexBytes() > MEMORY_LIMITS.indexHardBytes) {
			throw new MemoryManagerError("memory index remains above the hard limit after consolidation");
		}
		return documents;
	}

	private normalizeConsolidation(
		original: MemoryTopicDocument,
		result: MemoryTopicDocument,
		protectedKey?: string,
		requireProtectedKey = protectedKey !== undefined,
	): MemoryTopicDocument {
		if (result.scope !== original.scope || result.topic !== original.topic)
			throw new MemoryManagerError("consolidator changed topic identity");
		const originals = new Map(original.entries.map((entry) => [entry.key, entry]));
		const seen = new Set<string>();
		const entries = result.entries.map((entry) => {
			const previous = originals.get(entry.key);
			if (!previous) throw new MemoryManagerError(`consolidator invented key ${entry.key}`);
			if (seen.has(entry.key)) throw new MemoryManagerError(`consolidator duplicated key ${entry.key}`);
			seen.add(entry.key);
			const textChanged =
				entry.title !== previous.title || entry.summary !== previous.summary || entry.content !== previous.content;
			const normalized: MemoryEntry = {
				...entry,
				schemaVersion: 1,
				key: previous.key,
				source: previous.source,
				createdAt: previous.createdAt,
				observedAt: previous.observedAt,
				updatedAt: textChanged ? this.now().toISOString() : previous.updatedAt,
				...(previous.sourceSessionId ? { sourceSessionId: previous.sourceSessionId } : {}),
			};
			if (!previous.sourceSessionId) delete normalized.sourceSessionId;
			validateMemoryEntry(original.scope, original.topic, normalized);
			return normalized;
		});
		if (requireProtectedKey && !entries.some((entry) => entry.key === protectedKey)) {
			throw new MemoryManagerError("consolidator removed the current memory");
		}
		return { ...original, entries };
	}
}

function indexSummaryBytes(document: MemoryTopicDocument): number {
	return document.entries.reduce((total, entry) => total + utf8Bytes(entry.key) + utf8Bytes(entry.summary) + 64, 0);
}

function lowestValueEntry(
	documents: readonly MemoryTopicDocument[],
	protectedKey?: string,
): { topic: MemoryTopic; key: string } | undefined {
	return documents
		.flatMap((document) =>
			document.entries
				.filter((entry) => entry.key !== protectedKey)
				.map((entry) => ({
					topic: document.topic,
					key: entry.key,
					source: entry.source,
					observedAt: entry.observedAt,
				})),
		)
		.sort((a, b) => SOURCE_VALUE[a.source] - SOURCE_VALUE[b.source] || a.observedAt.localeCompare(b.observedAt))[0];
}

function documentFor(documents: readonly MemoryTopicDocument[], topic: MemoryTopic): MemoryTopicDocument {
	const document = documents.find((candidate) => candidate.topic === topic);
	if (!document) throw new MemoryManagerError(`missing memory topic: ${topic}`);
	return document;
}

function findEntry(
	documents: readonly MemoryTopicDocument[],
	key: string,
): { document: MemoryTopicDocument; entry: MemoryEntry } | undefined {
	for (const document of documents) {
		const entry = document.entries.find((candidate) => candidate.key === key);
		if (entry) return { document, entry };
	}
	return undefined;
}

function findMeaning(
	documents: readonly MemoryTopicDocument[],
	entry: MemoryEntry,
	excludeKey?: string,
): { document: MemoryTopicDocument; entry: MemoryEntry } | undefined {
	const meaning = normalizedMemoryMeaning(entry);
	for (const document of documents) {
		const duplicate = document.entries.find(
			(candidate) => candidate.key !== excludeKey && normalizedMemoryMeaning(candidate) === meaning,
		);
		if (duplicate) return { document, entry: duplicate };
	}
	return undefined;
}

const SOURCE_VALUE: Record<MemorySource, number> = {
	verified_project_fact: 0,
	user_feedback: 1,
	user_explicit: 2,
};

function trimOldLowValueEntries(
	document: MemoryTopicDocument,
	protectedKey: string | undefined,
	targetBytes: number,
): MemoryTopicDocument {
	const removable = document.entries
		.filter((entry) => entry.key !== protectedKey)
		.sort((a, b) => SOURCE_VALUE[a.source] - SOURCE_VALUE[b.source] || a.observedAt.localeCompare(b.observedAt));
	const entries = [...document.entries];
	while (utf8Bytes(renderMemoryTopic({ ...document, entries })) > targetBytes && removable.length > 0) {
		const remove = removable.shift();
		if (!remove) break;
		const index = entries.findIndex((entry) => entry.key === remove.key);
		if (index !== -1) entries.splice(index, 1);
	}
	return { ...document, entries };
}
